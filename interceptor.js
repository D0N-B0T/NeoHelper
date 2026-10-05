(function () {
    if (window.__mhInterceptorLoaded) return;
    window.__mhInterceptorLoaded = true;

    window.capturedEntities = window.capturedEntities || []; // debug desde la consola de la página

    // Único punto de entrada: filtra, parsea TODOS los `character "X" ... at (x, y)` del texto
    // y emite un evento con la lista ya parseada (JSON string: los objetos no cruzan bien entre mundos).
    const feed = (txt, src) => {
        try {
            if (typeof txt !== 'string' || txt.length > 200000) return;
            if (!/character\s+"/.test(txt) || !/at\s*\(\s*\d+\s*,\s*\d+\s*\)/.test(txt)) return;

            const list = [];
            const re = /character\s+"([^"]+)"[^"]{0,120}?at\s*\(\s*(\d+)\s*,\s*(\d+)\s*\)/g;
            let m;
            while ((m = re.exec(txt))) list.push({ n: m[1], x: +m[2], y: +m[3] });

            if (!list.length) {
                // formato alterno: un solo nombre y una sola posición, en cualquier orden
                const names = [...txt.matchAll(/character\s+"([^"]+)"/g)];
                const poss = [...txt.matchAll(/at\s*\(\s*(\d+)\s*,\s*(\d+)\s*\)/g)];
                if (names.length === 1 && poss.length === 1) list.push({ n: names[0][1], x: +poss[0][1], y: +poss[0][2] });
            }
            if (!list.length) return;

            window.capturedEntities.push({ raw: txt.slice(0, 300), timestamp: Date.now(), src });
            if (window.capturedEntities.length > 200) window.capturedEntities.shift();
            window.dispatchEvent(new CustomEvent('mh-entity', { detail: JSON.stringify({ src, list }) }));
        } catch (_) { }
    };

    ['log', 'debug', 'info', 'warn'].forEach((level) => {
        const orig = console[level];
        console[level] = function (...args) {
            try {
                // feed(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '), 'console');
                let txt = '';
                for (const a of args) if (typeof a === 'string') txt += a + ' ';
                if (txt.includes('hero moved by server')) window.postMessage({ __mh: 'rubber' }, '*');
                if (txt) feed(txt, 'console');
            } catch (_) { }
            return orig.apply(console, args);
        };
    });

    const OrigWS = window.WebSocket;
    if (OrigWS) {
        window.WebSocket = function (...args) {
            const ws = new OrigWS(...args);
            ws.addEventListener('message', async (ev) => {
                try {
                    let data = ev.data;
                    if (data instanceof Blob) data = await data.arrayBuffer();
                    if (data instanceof ArrayBuffer) data = new TextDecoder('latin1').decode(new Uint8Array(data));
                    feed(data, 'ws');
                } catch (_) { }
            });
            return ws;
        };
        window.WebSocket.prototype = OrigWS.prototype;
        Object.assign(window.WebSocket, OrigWS);
    }

    const origFetch = window.fetch;
    if (origFetch) {
        window.fetch = async function (...args) {
            const res = await origFetch.apply(this, args);
            try {
                res.clone().text().then((txt) => feed(txt, 'fetch')).catch(() => { });
            } catch (_) { }
            return res;
        };
    }

    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function () {
        this.addEventListener('load', function () {
            try {
                if (this.responseType === '' || this.responseType === 'text') feed(this.responseText, 'xhr');
            } catch (_) { }
        });
        return origOpen.apply(this, arguments);
    };

    // Posición propia (si __store está disponible en el mundo principal)
    // Posición propia + mapa (terreno completo leído desde world)
    let lastMap = -1;
    setInterval(() => {
        try {
            const S = window.__store, st = S?.playerData, w = S?.world;
            if (st && (st.x != null || st.posX != null)) {
                window.dispatchEvent(new CustomEvent('mh-mypos', {
                    detail: JSON.stringify({ x: st.x ?? st.posX, y: st.y ?? st.posY, map: w?.mapIndex })
                }));

            }

            if (st && st.level != null) {
                window.dispatchEvent(new CustomEvent('mh-stats', {
                    detail: JSON.stringify({
                        n: st.name, lv: st.level, ml: st.masterLevel, exp: st.exp, cur: st.currentLvlExp, next: st.expToNextLvl, zen: st.money,
                        hp: st.currentHP, mhp: st.maxHP, mp: st.currentMP, mmp: st.maxMP, sd: st.currentSD, msd: st.maxSD, ag: st.currentAG, mag: st.maxAG,
                        pts: st.points, res: st.resets ?? st.reset ?? st.resetCount, gres: st.grandResets ?? st.grandReset ?? st.grandResetCount,
                        helper: S.muHelper?.active, lost: !!(S.connectionLost || S.isOffline)
                    })
                }));


                if (w && !S.sceneLoading && w.netObjsQuery) {
                    const list = [];
                    for (const e of w.netObjsQuery) {
                        if (!e.monsterAnimation || 'dying' in e || e.droppedItem) continue;
                        list.push([e.netId, e.objectNameInWorld, Math.round(e.transform.pos.x), Math.round(e.transform.pos.z)]);
                    }
                    window.dispatchEvent(new CustomEvent('mh-mobs', { detail: JSON.stringify({ map: w.mapIndex, list }) }));
                }
            }

            if (w && !S.sceneLoading && w.mapIndex !== lastMap && typeof w.getTerrainFlag === 'function') {
                const g = new Uint8Array(65536);
                let walk = 0;
                for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
                    g[y * 256 + x] = w.getTerrainFlag(x, y) & ~2; // sin el bit "personaje encima"
                    if (!(g[y * 256 + x] & 4)) walk++;
                }
                if (!walk) return; // terreno aún no cargado, reintenta en 1s
                let bin = '';
                for (let i = 0; i < g.length; i += 8192) bin += String.fromCharCode.apply(null, g.subarray(i, i + 8192));
                lastMap = w.mapIndex;
                window.dispatchEvent(new CustomEvent('mh-map', { detail: JSON.stringify({ map: w.mapIndex, b64: btoa(bin) }) }));
            }
        } catch (_) { }
    }, 1000);
    // Mover el personaje: escribe el destino (en tiles) donde el juego deja el clic
    window.addEventListener('mh-moveto', (ev) => {
        try {
            const { x, y } = JSON.parse(ev.detail);
            const S = window.__store, me = [...S.world.playersQuery].find((e) => e.netId === S.playerId);
            const m = me.playerMoveTo;
            m.point.x = x; m.point.y = y; m.handled = false; m.silent = false; m.sendToServer = true;
        } catch (_) { }
    });

    window.addEventListener('mh-rubber', () => {
        window.dispatchEvent(new CustomEvent('mh-rubber-forward'));
    });
    // ---- CHAT: escribe en el input del juego y pide al background el Enter trusted ----
    window.addEventListener('mh-sendchat', (ev) => {
        try {
            const { text } = JSON.parse(ev.detail);
            const el = document.querySelector('.v097d-chat-field.line.to-normal');
            if (!el) {
                console.warn('[MH] no encontré el input de chat');
                return;
            }
            el.focus();
            el.value = text;
            // avisar al content script de que el input está listo para el Enter
            window.dispatchEvent(new CustomEvent('mh-sendchat-ready', {
                detail: JSON.stringify({ ok: true })
            }));
        } catch (_) { }

    });
    // ---- SELECCIÓN DE PERSONAJE ----
    window.addEventListener('mh-select-char', (ev) => {
        try {
            const { name } = JSON.parse(ev.detail);
            const S = window.__store;
            if (!S || !name) return;
            const list = S.charactersList || [];
            const target = [...list].find(c => (c.Name || '').toLowerCase() === name.toLowerCase());
            if (!target) {
                console.warn('[MH] char no encontrado:', name, '· disponibles:', [...list].map(c => c.Name));
                return;
            }
            S.focusedChar = target.Name;
            console.log('[MH] focusedChar =', target.Name);
        } catch (e) { console.warn('[MH] mh-select-char:', e); }
    });

    window.addEventListener('mh-query-char', () => {
        try {
            const S = window.__store;
            const list = S?.charactersList || [];
            const focused = S?.focusedChar;
            const all = [...list].map(c => ({
                Name: c.Name, Level: c.Level, SlotIndex: c.SlotIndex, Status: c.Status
            }));
            const cur = all.find(x => x.Name === focused) || all[0] || null;
            window.dispatchEvent(new CustomEvent('mh-char-info', {
                detail: JSON.stringify({ focused, char: cur, all })
            }));
        } catch (e) { console.warn('[MH] mh-query-char:', e); }
    });

    window.addEventListener('mh-enter-game', () => {
        try {
            const plates = [...document.querySelectorAll('.char-sel-plate')];
            if (!plates.length) { console.warn('[MH] no hay plate'); return; }

            const S = window.__store;
            const want = (S?.focusedChar || '').toLowerCase();
            const plate = plates.find(p =>
                p.querySelector('.char-sel-plate-name')?.textContent?.trim().toLowerCase() === want
            ) || plates[0];

            const r = plate.getBoundingClientRect();
            // El plate está ARRIBA del personaje (translate(-50%, -100%)).
            // El personaje 3D está debajo → bajamos ~100px desde el top del plate.
            const cx = Math.round(r.left + r.width / 2);
            const cy = Math.round(r.top + 100);  // ⬅️ ajustar este offset

            console.log('[MH] enter: realClick en', cx, cy, '· plate bottom:', r.bottom);

            window.dispatchEvent(new CustomEvent('mh-real-click', {
                detail: JSON.stringify({ x: cx, y: cy, dbl: true })
            }));
        } catch (e) { console.warn('[MH] enter:', e); }
    });
    // ---- DETECCIÓN DE PANTALLA (login / charselect / game) ----
    let lastPhase = null;
    setInterval(() => {
        try {
            const S = window.__store;
            let phase = 'unknown';

            const hasCharScreen = !!document.querySelector(
                '.characters-page, .char-sel-plate, .char-sel-bar'
            );
            const hasLogin = !!document.querySelector(
                'input[type="password"], .login-form, .v097d-login, [data-phase="login"]'
            );
            const sceneLoading = !!S?.sceneLoading;
            const hasWorld = !!S?.world;
            const hasPlayer = !!S?.playerData?.name;
            const inGame = hasWorld && hasPlayer && !hasCharScreen && !sceneLoading;

            // Prioridad: charselect > login > game (el DOM de charselect es inconfundible)
            if (hasCharScreen) phase = 'charselect';
            else if (hasLogin) phase = 'login';
            else if (inGame) phase = 'game';

            if (phase !== lastPhase) {
                console.log('[MH] fase:', lastPhase, '→', phase,
                    { hasCharScreen, hasLogin, inGame, hasWorld, hasPlayer, sceneLoading });
                lastPhase = phase;
                window.dispatchEvent(new CustomEvent('mh-phase', {
                    detail: JSON.stringify({ phase })
                }));
            }
        } catch (e) { console.warn('[MH] phase detector:', e); }
    }, 500);
    console.log('[MH] Interceptor cargado');





})();

