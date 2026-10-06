// content/autowalk.js

(() => {
    const MH = window.__MH;
    if (!MH) { console.error('[MH] _bus.js no cargado'); return; }

    const wcfg = { lookahead: 10, tick: 150, maxStill: 24 };

    // ---------- stopWalk ----------
    // halt=true: además hace clic en el centro (tu personaje) para que frene donde está
    const stopWalk = (why = 'detenido', halt = true) => {
        const w = MH.walk;
        const was = !!w.timer;
        clearInterval(w.timer); w.timer = null;
        w.path = null;
        if (why !== 'llegó') { clearInterval(w.followTimer); w.followTimer = null; }
        w.msg = why;
        if (was && halt && MH.me) chrome.runtime.sendMessage({ target: 'bg', type: 'mh-move', x: MH.me.x, y: MH.me.y }).catch(() => { });
    };

    // ---------- goTo (BFS) ----------
    async function goTo(tx, ty, near = 3) {
        const w = MH.walk;
        clearInterval(w.timer); w.timer = null;

        // ⬇️ NUEVO: esperar hasta 5s a que el terreno esté cargado
        const mapId = MH.me?.map;
        let b64 = null;
        for (let i = 0; i < 25; i++) {
            b64 = (await chrome.storage.local.get('map:' + mapId))['map:' + mapId];
            if (b64) break;
            await new Promise(r => setTimeout(r, 200));
        }
        const fail = (m) => { w.msg = m; console.warn('[MH]', m); };
        if (!b64 || !MH.me) return fail('sin terreno o sin pos');
        const bin = atob(b64);
        const ok = (x, y) => x >= 0 && y >= 0 && x < 256 && y < 256 && !(bin.charCodeAt(y * 256 + x) & 12);

        // Si el destino no es caminable, buscar el punto más cercano que sí lo sea
        let targetX = tx, targetY = ty;
        if (!ok(tx, ty)) {
            console.log('[MH] destino no caminable, buscando punto cercano...');
            let bestDist = Infinity;
            const searchRadius = 20;  // buscar en radio de 20 tiles
            for (let dx = -searchRadius; dx <= searchRadius; dx++) {
                for (let dy = -searchRadius; dy <= searchRadius; dy++) {
                    const nx = tx + dx, ny = ty + dy;
                    if (ok(nx, ny)) {
                        const dist = Math.hypot(dx, dy);
                        if (dist < bestDist) {
                            bestDist = dist;
                            targetX = nx;
                            targetY = ny;
                        }
                    }
                }
            }
            if (bestDist === Infinity) return fail('no hay punto caminable cerca del destino');
            console.log('[MH] nuevo destino:', targetX, targetY, '(dist original:', bestDist.toFixed(1), 'tiles)');
        }

        const s = MH.api.getMe();
        const start = s.y * 256 + s.x;
        const goal = targetY * 256 + targetX;
        const par = new Int32Array(65536).fill(-2);
        par[start] = -1;
        const q = [start];
        for (let h = 0; h < q.length && par[goal] === -2; h++) {
            const c = q[h], cx = c & 255, cy = c >> 8;
            for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
                if (!dx && !dy) continue;
                const nx = cx + dx, ny = cy + dy, n = ny * 256 + nx;
                if (!ok(nx, ny) || par[n] !== -2) continue;
                if (dx && dy && (!ok(cx + dx, cy) || !ok(cx, cy + dy))) continue;
                par[n] = c; q.push(n);
            }
        }
        if (par[goal] === -2) return fail('sin ruta');
        const path = [];
        for (let c = goal; c !== -1; c = par[c]) path.push({ x: c & 255, y: c >> 8 });
        path.reverse();
        console.log('[MH] ruta de', path.length, 'tiles');
        w.msg = '';
        w.path = path; w.idx = 0;

        const los = (ax, ay, bx, by) => {
            const n = Math.max(Math.abs(bx - ax), Math.abs(by - ay)) * 2;
            for (let i = 1; i <= n; i++) {
                if (!ok(Math.round(ax + (bx - ax) * i / n), Math.round(ay + (by - ay) * i / n))) return false;
            }
            return true;
        };

        let idx = 0, lastKey = '', still = 0, lastWp = null, lastSend = 0;
        w.timer = setInterval(() => {
            const p = MH.api.getMe(), now = Date.now();
            if (MH.me?.map !== mapId) return stopWalk('cambió de mapa', false);
            if (!p.auto) return stopWalk('sin posición auto', true);
            if (Math.hypot(targetX - p.x, targetY - p.y) <= near) { stopWalk('llegó', false); return; }

            const lim = Math.min(path.length, idx + wcfg.lookahead * 2);
            let bd = 1e9;
            for (let j = idx; j < lim; j++) {
                const d = Math.hypot(path[j].x - p.x, path[j].y - p.y);
                if (d < bd && los(p.x, p.y, path[j].x, path[j].y)) { bd = d; idx = j; }
            }
            w.idx = idx;

            const pk = p.x + ',' + p.y;
            still = pk === lastKey ? still + 1 : 0; lastKey = pk;
            if (still >= wcfg.maxStill) return stopWalk(`atascado en (${p.x}, ${p.y})`, true);

            let wp = path[Math.min(idx + 1, path.length - 1)];
            for (let j = Math.min(idx + wcfg.lookahead, path.length - 1); j > idx; j--) {
                if (los(p.x, p.y, path[j].x, path[j].y)) { wp = path[j]; break; }
            }

            const dLast = lastWp ? Math.hypot(lastWp.x - p.x, lastWp.y - p.y) : 99;
            if (now - lastSend > 200 && (!lastWp || (wp !== lastWp && dLast <= 3) || (still > 0 && still % 4 === 0))) {
                lastWp = wp; lastSend = now;
                chrome.runtime.sendMessage({ target: 'bg', type: 'mh-move', x: wp.x, y: wp.y }).catch(() => { });
            }
        }, wcfg.tick);
    }

    // ---------- follow ----------
    function follow(name) {
        const w = MH.walk;
        clearInterval(w.followTimer);
        let dest = null, routing = false;
        w.followTimer = setInterval(() => {
            const now = Date.now(), p = MH.api.getMe();
            let t = null;
            for (const v of MH.tracked.values()) {
                if (v.name === name && now - v.lastSeen <= MH.cfg.ttl * 1000) t = v;
            }
            if (!t) return stopWalk('perdió a ' + name, true);
            if (routing || Math.hypot(t.x - p.x, t.y - p.y) <= 3) return;
            if (w.timer && dest && Math.hypot(t.x - dest.x, t.y - dest.y) < 4) return;
            dest = { x: t.x, y: t.y }; routing = true;
            goTo(t.x, t.y, 2.5).finally(() => { routing = false; });
        }, 2500);
    }

    // ---------- waitMapThenGo (usado por AUTO) ----------
    function waitMapThenGo(destMap, destX, destY) {
        const t0 = Date.now();
        const wt = setInterval(async () => {
            const m = MH.me, nowT = Date.now();
            if (nowT - t0 > 60000) {
                clearInterval(wt);
                if (MH.auto) MH.auto.pendingMoveUntil = 0;
                console.warn('[MH-AUTO] waitMapThenGo: timeout esperando mapa', destMap);
                return;
            }
            if (!m || m.map == null) return;
            if (m.map !== destMap) return;
            const terr = (await chrome.storage.local.get('map:' + m.map))['map:' + m.map];
            if (!terr) return;
            clearInterval(wt);
            if (MH.auto) MH.auto.pendingMoveUntil = 0;
            goTo(destX, destY).catch(() => { });
        }, 800);
    }

    // ---------- rubber: si el server te movió, corta el walk ----------
    window.addEventListener('mh-rubber-forward', () => {
        if (MH.walk.timer) stopWalk('servidor te movió', false);
    });

    // ---------- mensajes desde el panel/radar ----------
    chrome.runtime.onMessage.addListener((msg) => {
        if (msg.target !== 'content') return;
        if (msg.type === 'goto' && MH.me) {
            clearInterval(MH.walk.followTimer); MH.walk.followTimer = null;
            goTo(msg.x, msg.y);
        }
        if (msg.type === 'follow' && MH.me) follow(msg.name);
        if (msg.type === 'stopwalk') stopWalk();
    });

    // ---------- API pública ----------
    MH.api.stopWalk = stopWalk;
    MH.api.goTo = goTo;
    MH.api.follow = follow;
    MH.api.waitMapThenGo = waitMapThenGo;
    MH.api.isWalking = () => !!MH.walk.timer || !!MH.walk.followTimer;
    MH.api.getWalkState = () => ({
        walking: !!MH.walk.timer || !!MH.walk.followTimer,
        msg: MH.walk.msg,
        route: MH.walk.path ? MH.walk.path.map((n) => [n.x, n.y]) : null,
        routeIdx: MH.walk.idx
    });

    console.log('[MH] autowalk.js cargado');
})();