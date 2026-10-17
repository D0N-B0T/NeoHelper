// content/auto.js
// Máquina de estados del AUTO: login → serverselect → charselect → game.
// Expone: MH.auto (para stats.js)
// Consume: MH.me, MH.cfg, MH.api.getMe, MH.api.goTo, MH.api.stopWalk,
//          MH.api.isWalking, MH.api.waitMapThenGo

(() => {
    const MH = window.__MH;
    if (!MH) { console.error('[MH] _bus.js no cargado'); return; }

    const AUTO = {
        enabled: false,
        user: '', pass: '',
        charName: '',

        icarusLv: { _default: 170, gm: 113 },
        phase: 'unknown',
        cls: '', lv: 0, charLevel: 0, map: null,
        lastAction: 0, enterTries: 0,
        holding: false,
        holdSpot: null,
        lastMoveCmd: null,
        lastMoveAt: 0,
        lastMoveMap: null,
        pendingMoveUntil: 0,
        icarusMap: 10,
        chars: [],                  // [{ n: nombre, lv: nivel, cls: clase }] — aprendido del char-select
        charStamp: 0,               // última vez que la lista cambió (para el popup)
        autopartySent: false,       // ya se mandó /autoparty on en este mapa
        _heldMap: null,             // mapa en el que el hold estaba activo
        _reholdTried: false,        // ya intenté un HOLD limpio tras autoparty

        _warnedMaps: null,
    };
    MH.auto = AUTO;   // ⬅️ para que stats.js lo vea

    // ---------- config desde storage ----------
    // Los personajes se recuerdan en chrome.storage.local['charsList'] (compartido con el popup).
    // El respaldo en localStorage es un no-op fuera de una extensión (depurar el módulo suelto).
    let charsKey = '';
    const store = (chrome?.storage?.local) || {
        get: (k, cb) => { let v = null; try { v = JSON.parse(localStorage.getItem('mh.' + k) || 'null'); } catch (_) { } cb?.({ [k]: v }); },
        set: (o) => { try { for (const k in o) localStorage.setItem('mh.' + k, JSON.stringify(o[k])); } catch (_) { } },
    };
    const readChars = () => new Promise((res) => {
        try { store.get('charsList', (c) => res(Array.isArray(c?.charsList) ? c.charsList : [])); }
        catch (_) { res([]); }
    });
    // Fusiona la lista del server con la memoria: agrega nuevos, actualiza nivel/clase,
    // NUNCA borra los que no aparecieron (un personaje puede estar en otro server).
    const learnChars = (all) => {
        if (!all || !all.length) return;
        const prev = new Map((AUTO.chars || []).map((c) => [String(c.n).toLowerCase(), c]));
        for (const c of all) {
            const name = c?.Name; if (!name) continue;
            const lv = c.Level ?? 0;
            prev.set(String(name).toLowerCase(), { n: name, lv, cls: /^mg/i.test(name) ? 'magic gladiator' : 'normal' });
        }
        const next = [...prev.values()].slice(0, 20);
        // El log se emite la primera vez y cuando entra un personaje nuevo:
        // si no, cada vuelta al char-select repetiría la misma línea.
        const sig = next.map((c) => c.n.toLowerCase()).join('|');
        if (sig === charsKey) return;
        charsKey = sig;
        AUTO.chars = next;
        AUTO.charStamp = Date.now();
        try { store.set({ charsList: next, autoChars: { chars: next, ts: AUTO.charStamp } }); } catch (_) { }
        console.log('[MH-AUTO] personajes:', next.map((c) => `${c.n} (lv${c.lv}, ${c.cls})`).join(', ') || '—');
    };
    // Solo se lee, nunca se escribe: así una petición en curso no puede pisar
    // una lista recién aprendida en el char-select.
    readChars().then((list) => {
        AUTO.chars = list;
        charsKey = list.map((c) => c.n.toLowerCase()).join('|');
        if (list.length) console.log('[MH-AUTO] personajes recordados:', list.map((c) => c.n).join(', '));
    });

    // El popup guarda el personaje elegido en autoCfg.charName. Hasta que ese get resuelve,
    // AUTO.charName sigue en '' y el primer doCharSelect() entraba con el focusedChar previo
    // del juego (el personaje de la sesión anterior). cfgReady se espera antes de decidir.
    let cfgReady = false;
    const cfgPromise = new Promise((res) => {
        try {
            chrome.storage.local.get('autoCfg', (c) => {
                if (c.autoCfg) Object.assign(AUTO, c.autoCfg);
                cfgReady = true;
                res();
            });
        } catch (_) { cfgReady = true; res(); }
    });
    chrome.storage.onChanged.addListener((ch, area) => {
        if (area === 'local' && ch.autoCfg) {
            Object.assign(AUTO, ch.autoCfg.newValue || {});
            cfgReady = true;
            console.log('[MH-AUTO] autoCfg actualizado · personaje:', AUTO.charName || '—');
        }
        if (area === 'local' && ch.autoEnabled) {
            const was = AUTO.enabled;
            AUTO.enabled = !!ch.autoEnabled.newValue;
            // Toggle ON->OFF: apagar TODO de verdad (hold, walk, cacería, marcas).
            if (was && !AUTO.enabled) shutdownAuto();
        }
    });
    chrome.storage.local.get('autoEnabled', (c) => AUTO.enabled = !!c.autoEnabled);

    // Apagado total del AUTO. Se llama cuando el usuario pasa el toggle a OFF.
    // Suelta el hold, corta el autowalk y la cacería, y limpia las marcas de
    // movimiento para que al volver a ON el estado arranque limpio (si no, un
    // lastMoveCmd/lastMoveMap viejo bloquea el primer /move del mapa nuevo).
    function shutdownAuto() {
        console.log('[MH-AUTO] toggle OFF → apagando todo');
        try { MH.api.stopHunt?.(); } catch (_) { }
        try { MH.api.stopWalk?.('auto-off', false); } catch (_) { }
        if (AUTO.holding) chrome.runtime.sendMessage({ target: 'bg', type: 'stop' }).catch(() => { });
        AUTO.holding = false;
        AUTO.holdSpot = null;
        AUTO._heldMap = null;
        AUTO._reholdTried = false;
        AUTO.autopartySent = false;
        AUTO.lastMoveCmd = null;
        AUTO.lastMoveMap = null;
        AUTO.lastMoveAt = 0;
        AUTO.pendingMoveUntil = 0;
        AUTO._lastPos = null;
        AUTO.enterTries = 0;
        AUTO.lastAction = 0;
        chrome.storage.local.set({
            autoState: {
                phase: AUTO.phase, lv: AUTO.lv, map: AUTO.map,
                cls: AUTO.cls, charLevel: AUTO.charLevel, holding: false,
                off: true
            }
        }).catch(() => { });
    }
    MH.api.shutdownAuto = shutdownAuto;

    // ---------- helpers de input ----------
    const trustedEnter = () => chrome.runtime.sendMessage({ target: 'bg', type: 'pressEnter' }).catch(() => { });
    const typeInto = (el, text) => {
        if (!el) return;
        el.focus(); el.value = text;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    // Suelta el hold y NO lo reanuda. El bg lo repone al terminar si keepHold.
    const stopHoldThenChat = async (text) => {
        await chrome.runtime.sendMessage({ target: 'bg', type: 'stop' }).catch(() => { });
        await new Promise(r => setTimeout(r, 600));
        await chrome.runtime.sendMessage({ target: 'bg', type: 'chat', text, keepHold: true }).catch(() => { });
    };

    // Manda /autoparty on una sola vez por máp y (en el primer hold del mapa).
    // Suelta el hold, envía el comando, y luego lo reanuda manualmente.
    async function sendAutoParty() {
        if (AUTO.autopartySent) return;
        const cmd = MH.cfg?.mu?.commands?.autoParty;
        if (!cmd) return;
        AUTO.autopartySent = true;
        console.log('[MH-AUTO] enviando', cmd, '· mapa', AUTO.map);

        const wasHolding = AUTO.holding;
        if (wasHolding) await unholdMouse();

        // Enviar el comando sin keepHold (no reanuda automáticamente)
        await chrome.runtime.sendMessage({ target: 'bg', type: 'stop' }).catch(() => { });
        await new Promise(r => setTimeout(r, 300));
        await chrome.runtime.sendMessage({ target: 'bg', type: 'chat', text: cmd, keepHold: false }).catch(() => { });

        // Esperar a que el comando se envíe
        await new Promise(r => setTimeout(r, 600));

        // Reanudar el hold manualmente si estaba activo
        if (wasHolding) {
            await holdMouse(false);  // reanudar con clics normales
        }
    }

    const holdMouse = async (pausesChat = false) => {
        if (AUTO.holding) return;
        const cfg = await chrome.storage.local.get(['button', 'x', 'y', 'repeat']);
        const msg = {
            target: 'bg', type: 'start',
            button: cfg.button || 'right',
            x: cfg.x ?? null,
            y: cfg.y ?? null,
            repeat: cfg.repeat ?? 300,
            pausesChat
        };
        chrome.runtime.sendMessage(msg).catch(() => { });
        AUTO.holding = true;
        AUTO._heldMap = AUTO.map;  // track the map where hold was activated
        console.log('[MH-AUTO] HOLD ON →', cfg.x, cfg.y, cfg.button, 'repeat', cfg.repeat, pausesChat ? '(pausado para chat)' : '');
    };

    const unholdMouse = async () => {
        if (!AUTO.holding) return;
        chrome.runtime.sendMessage({ target: 'bg', type: 'stop' }).catch(() => { });
        AUTO.holding = false;
        AUTO.holdSpot = null;
        // NO resetear _heldMap aquí - necesitamos saber en qué mapa estaba
        console.log('[MH-AUTO] HOLD OFF');
    };

    // ---------- login ----------
    async function doLogin() {
        if (Date.now() - AUTO.lastAction < 3000) return;
        AUTO.lastAction = Date.now();
        const userEl = document.querySelector('input[type="text"], input[name="user"], input[name="username"]');
        const passEl = document.querySelector('input[type="password"]');
        if (!userEl || !passEl) return;
        typeInto(userEl, AUTO.user);
        typeInto(passEl, AUTO.pass);
        await new Promise(r => setTimeout(r, 200));
        trustedEnter();
    }

    // ---------- server select ----------
    async function doServerSelect() {
        if (Date.now() - AUTO.lastAction < 3000) return;

        const btn = [...document.querySelectorAll('div')].find(e => {
            const t = e.textContent.trim();
            const r = e.getBoundingClientRect();
            return t === 'Server 1-1' && r.width > 0 && r.height > 0;
        });
        if (!btn) return;

        AUTO.lastAction = Date.now();
        const r = btn.getBoundingClientRect();
        const cx = Math.round(r.left + r.width / 2);
        const cy = Math.round(r.top + r.height / 2);
        console.log('[MH-AUTO] server-select: dbl-click en', cx, cy, `(${r.width}x${r.height})`);

        window.dispatchEvent(new CustomEvent('mh-real-click', {
            detail: JSON.stringify({ x: cx, y: cy, dbl: true })
        }));
    }

    // ---------- char select ----------
    let charInfoResolve = null;
    window.addEventListener('mh-char-info', (ev) => {
        try { charInfoResolve?.(JSON.parse(ev.detail)); } catch (_) { }
    });
    const queryCharInfo = () => new Promise((res) => {
        charInfoResolve = res;
        window.dispatchEvent(new CustomEvent('mh-query-char'));
        setTimeout(() => res(null), 800);
    });

    async function doCharSelect() {
        if (Date.now() - AUTO.lastAction < 3000) return;
        AUTO.lastAction = Date.now();
        // El primer ciclo corría antes de que el get('autoCfg') del arranque resolviera,
        // así que AUTO.charName todavía estaba vacío y se entraba con el personaje
        // enfocado que el juego arrastraba de la sesión anterior.
        await cfgPromise;
        const info = await queryCharInfo();
        if (!info || !info.all?.length) return;

        // La lista del server es la fuente de verdad: se memoriza antes de decidir nada.
        learnChars(info.all);

        // Sin nombre configurado: si la cuenta tiene UN solo personaje se entra solo;
        // si tiene varios, se deja la elección al usuario (o se pone el nombre en el popup).
        if (!AUTO.charName && info.all.length === 1) {
            AUTO.charName = info.all[0].Name;
            chrome.storage.local.set({ autoCfg: Object.assign({}, AUTO, { charName: AUTO.charName }) }).catch(() => { });
        }
        const want = (AUTO.charName || '').toLowerCase();
        if (want && (info.focused || '').toLowerCase() !== want) {
            const exists = info.all.some(c => c.Name.toLowerCase() === want);
            if (!exists) {
                // El nombre guardado puede venir de otro server o del campo viejo de texto.
                // Antes se abortaba aquí y se entraba con el personaje enfocado por el juego:
                // ahora se adopta el enfocado (o el primero) y se reescribe autoCfg.
                const fallback = info.focused || info.all[0]?.Name || '';
                console.warn('[MH-AUTO] no existe:', AUTO.charName, '· disponibles:', info.all.map(c => c.Name).join(', '), '→ uso', fallback);
                AUTO.charName = fallback;
                chrome.storage.local.set({ autoCfg: Object.assign({}, AUTO, { charName: fallback }) }).catch(() => { });
                return;
            }
            window.dispatchEvent(new CustomEvent('mh-select-char', {
                detail: JSON.stringify({ name: AUTO.charName })
            }));
            await new Promise(r => setTimeout(r, 1200));
            const i2 = await queryCharInfo();
            if ((i2?.focused || '').toLowerCase() !== want) {
                console.warn('[MH-AUTO] no cambié');
                return;
            }
        }

        const cur = info.all.find(c => c.Name === (info.focused || '')) || info.all[0];
        AUTO.cls = /^mg/i.test(cur?.Name || '') ? 'magic gladiator' : 'normal';
        AUTO.charLevel = cur?.Level ?? 0;

        AUTO.enterTries = (AUTO.enterTries || 0) + 1;
        if (AUTO.enterTries > 6) { AUTO.enterTries = 0; return; }
        window.dispatchEvent(new CustomEvent('mh-enter-game'));
        await new Promise(r => setTimeout(r, 2000));
    }

    // ---------- in-game ----------
    const icarusTarget = () =>
        AUTO.cls === 'magic gladiator'
            ? (AUTO.icarusLv?.gm ?? 113)
            : (AUTO.icarusLv?._default ?? 170);

    const canSendMove = (cmd) => {
        const now = Date.now();
        if (now < AUTO.pendingMoveUntil) return false;
        if (AUTO.lastMoveCmd === cmd && AUTO.lastMoveMap === AUTO.map) return false;
        return true;
    };

    const markMoveSent = (cmd) => {
        AUTO.lastMoveCmd = cmd;
        AUTO.lastMoveMap = AUTO.map;
        AUTO.lastMoveAt = Date.now();
        AUTO.pendingMoveUntil = Date.now() + 30000;
    };

    async function doIngame() {
        const m = MH.api.getMe();
        if (!m) return;
        const map = MH.me?.map;
        if (map !== AUTO.map) {
            console.log('[MH-AUTO] cambio de mapa:', AUTO.map, '→', map);
            AUTO.map = map;
            if (AUTO.autopartySent) {
                AUTO.autopartySent = false;          // reenviar en el mapa nuevo
                console.log('[MH-AUTO] mapa nuevo · autoparty se reenviará');
            }
        }

        // Primer hold en este mapa: manda /autoparty on (una sola vez por mapa).
        if (AUTO.holding && AUTO._heldMap !== map) {
            AUTO._heldMap = map;
            AUTO.autopartySent = false;
            await sendAutoParty();
        }
        await MH.api.applyActiveStep();
    }

    // ---------- fase: cambio desde el detector ----------
    window.addEventListener('mh-phase', (ev) => {
        try {
            const { phase } = JSON.parse(ev.detail);
            if (AUTO.phase !== phase) {
                console.log('[MH-AUTO] fase:', AUTO.phase, '→', phase);
                AUTO.phase = phase;
                AUTO.lastAction = 0;
                if (phase === 'game') AUTO.enterTries = 0;
                if (phase === 'serverselect') AUTO.enterTries = 0;
                if (phase === 'charselect') {
                    AUTO.lv = 0;
                    AUTO.map = null;
                    AUTO.autopartySent = false;
                    AUTO._heldMap = null;
                    AUTO._reholdTried = false;
                    unholdMouse();
                    // La lista de personajes es información, no una acción: se aprende
                    // aunque el AUTO esté apagado (el loop principal no corre en OFF).
                    queryCharInfo().then((i) => learnChars(i?.all));
                }
            }
        } catch (_) { }
    });

    // ---------- loop principal ----------
    setInterval(() => {
        if (!AUTO.enabled) return;
        try {
            if (MH.walk.timer && MH.me) {
                if (!AUTO._lastPos || AUTO._lastPos.x !== MH.me.x || AUTO._lastPos.y !== MH.me.y) {
                    AUTO._lastPos = { x: MH.me.x, y: MH.me.y, t: Date.now() };
                } else if (Date.now() - AUTO._lastPos.t > 2500) {
                    MH.api.stopWalk('auto-stuck', false);
                    AUTO._lastPos = null;
                }
            }

            switch (AUTO.phase) {
                case 'login': doLogin(); break;
                case 'serverselect': doServerSelect(); break;
                case 'charselect': doCharSelect(); break;
                case 'game': doIngame(); break;
            }

            chrome.storage.local.set({
                autoState: {
                    phase: AUTO.phase, lv: AUTO.lv, map: AUTO.map,
                    cls: AUTO.cls, charLevel: AUTO.charLevel, holding: AUTO.holding
                }
            }).catch(() => { });
        } catch (e) { console.warn('[MH-AUTO]', e); }
    }, 1500);
    MH.api.holdMouse = holdMouse;
    MH.api.unholdMouse = unholdMouse;
    MH.api.stopHoldThenChat = stopHoldThenChat;
    console.log('[MH] auto.js cargado');
})();