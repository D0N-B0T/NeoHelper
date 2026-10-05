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
        lorenciaSpot: { x: 202, y: 124, untilLv: 13 },
        devias3Spot: { x: 225, y: 217 },
        icarusSpot: { x: 46, y: 199, untilLv: 400 },
        devias3Cmd: '/move devias3',
        icarusCmd: '/move icarus',
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
        _warnedMaps: null,
    };
    MH.auto = AUTO;   // ⬅️ para que stats.js lo vea

    // ---------- config desde storage ----------
    chrome.storage.local.get('autoCfg', (c) => { if (c.autoCfg) Object.assign(AUTO, c.autoCfg); });
    chrome.storage.onChanged.addListener((ch, area) => {
        if (area === 'local' && ch.autoCfg) Object.assign(AUTO, ch.autoCfg.newValue || {});
        if (area === 'local' && ch.autoEnabled) AUTO.enabled = !!ch.autoEnabled.newValue;
    });
    chrome.storage.local.get('autoEnabled', (c) => AUTO.enabled = !!c.autoEnabled);

    // ---------- helpers de input ----------
    const trustedEnter = () => chrome.runtime.sendMessage({ target: 'bg', type: 'pressEnter' }).catch(() => { });
    const typeInto = (el, text) => {
        if (!el) return;
        el.focus(); el.value = text;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const stopHoldThenChat = async (text) => {
        await chrome.runtime.sendMessage({ target: 'bg', type: 'stop' }).catch(() => { });
        await new Promise(r => setTimeout(r, 600));
        await chrome.runtime.sendMessage({ target: 'bg', type: 'chat', text }).catch(() => { });
    };

    const holdMouse = async () => {
        if (AUTO.holding) return;
        const cfg = await chrome.storage.local.get(['button', 'x', 'y', 'repeat']);
        chrome.runtime.sendMessage({
            target: 'bg', type: 'start',
            button: cfg.button || 'right',
            x: cfg.x ?? null,
            y: cfg.y ?? null,
            repeat: cfg.repeat ?? 300
        }).catch(() => { });
        AUTO.holding = true;
        console.log('[MH-AUTO] HOLD ON →', cfg.x, cfg.y, cfg.button, 'repeat', cfg.repeat);
    };

    const unholdMouse = async () => {
        if (!AUTO.holding) return;
        chrome.runtime.sendMessage({ target: 'bg', type: 'stop' }).catch(() => { });
        AUTO.holding = false;
        AUTO.holdSpot = null;
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
        const info = await queryCharInfo();
        if (!info) return;

        const want = (AUTO.charName || '').toLowerCase();
        if (want && (info.focused || '').toLowerCase() !== want) {
            const exists = info.all.some(c => c.Name.toLowerCase() === want);
            if (!exists) { console.error('[MH-AUTO] no existe:', AUTO.charName); return; }
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
            AUTO.lastMoveCmd = null;
            AUTO.lastMoveMap = null;
            AUTO.pendingMoveUntil = 0;
            AUTO.holdSpot = null;
        }

        const now = Date.now();
        const walking = MH.api.isWalking();
        if (walking && AUTO.holding) { await unholdMouse(); return; }
        if (now - AUTO.lastAction < 3000) return;

        if (map === 0) {
            const { x, y, untilLv } = AUTO.lorenciaSpot;
            if ((AUTO.lv ?? 0) >= untilLv) {
                if (!canSendMove(AUTO.devias3Cmd)) return;
                markMoveSent(AUTO.devias3Cmd);
                AUTO.lastAction = now;
                await unholdMouse();
                await stopHoldThenChat(AUTO.devias3Cmd);
                MH.api.waitMapThenGo(2, AUTO.devias3Spot.x, AUTO.devias3Spot.y);
                return;
            }
            if (walking) return;
            const dist = Math.hypot(m.x - x, m.y - y);
            if (dist > 5) {
                if (AUTO.holding) await unholdMouse();
                AUTO.lastAction = now;
                MH.api.goTo(x, y);
            } else if (!AUTO.holding) {
                AUTO.holdSpot = { x, y, map: 0 };
                try { await holdMouse(); } catch (e) { console.error('[MH-AUTO] holdMouse error:', e); }
            }
            return;
        }

        if (map === 2) {
            const { x, y } = AUTO.devias3Spot;
            const target = icarusTarget();
            if ((AUTO.lv ?? 0) >= target) {
                if (!canSendMove(AUTO.icarusCmd)) return;
                markMoveSent(AUTO.icarusCmd);
                AUTO.lastAction = now;
                await unholdMouse();
                await stopHoldThenChat(AUTO.icarusCmd);
                MH.api.waitMapThenGo(AUTO.icarusMap, AUTO.icarusSpot.x, AUTO.icarusSpot.y);
                return;
            }
            if (walking) return;
            const dist = Math.hypot(m.x - x, m.y - y);
            if (dist > 5) {
                if (AUTO.holding) await unholdMouse();
                AUTO.lastAction = now;
                MH.api.goTo(x, y);
            } else if (!AUTO.holding) {
                AUTO.holdSpot = { x, y, map: 2 };
                try { await holdMouse(); } catch (e) { console.error('[MH-AUTO] holdMouse error:', e); }
            }
            return;
        }

        if (map === AUTO.icarusMap) {
            const { x, y, untilLv } = AUTO.icarusSpot;
            if ((AUTO.lv ?? 0) >= untilLv) {
                if (AUTO.holding) await unholdMouse();
                return;
            }
            if (walking) return;
            const dist = Math.hypot(m.x - x, m.y - y);
            if (dist > 5) {
                if (AUTO.holding) await unholdMouse();
                AUTO.lastAction = now;
                MH.api.goTo(x, y);
            } else if (!AUTO.holding) {
                AUTO.holdSpot = { x, y, map };
                try { await holdMouse(); } catch (e) { console.error('[MH-AUTO] holdMouse error:', e); }
            }
            return;
        }

        if (!AUTO._warnedMaps) AUTO._warnedMaps = new Set();
        if (!AUTO._warnedMaps.has(map)) {
            AUTO._warnedMaps.add(map);
            console.warn('[MH-AUTO] mapa no configurado:', map);
        }
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
                    unholdMouse();
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

    console.log('[MH] auto.js cargado');
})();