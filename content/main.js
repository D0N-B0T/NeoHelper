(() => {
    if (window.__mhContentInjected) return;
    window.__mhContentInjected = true;

    const MH = window.__MH;
    if (!MH) { console.error('[MH] _bus.js no cargado'); return; }

    window.addEventListener('mh-real-click', (ev) => {
        try {
            const { x, y, dbl } = JSON.parse(ev.detail);
            chrome.runtime.sendMessage({ target: 'bg', type: 'realClick', x, y, dbl }).catch(() => { });
        } catch (_) { }
    });

    window.addEventListener('mh-map', (ev) => {
        try {
            const d = JSON.parse(ev.detail);
            MH.tracked.clear();
            chrome.storage.local.set({ ['map:' + d.map]: d.b64 });
        } catch (_) { }
    });

    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (msg.target !== 'content') return;

        // Handle simulation commands
        if (msg.type === 'sim-start') {
            MH.api.simulation?.start(msg.gridStep);
            sendResponse({ ok: true });
            return;
        }
        if (msg.type === 'sim-stop') {
            MH.api.simulation?.stop();
            sendResponse({ ok: true });
            return;
        }
        if (msg.type === 'sim-export') {
            MH.api.simulation?.exportData();
            sendResponse({ ok: true });
            return;
        }

        if (msg.type !== 'getState') return;
        if (!MH.tracked.size && !MH.me) return;
        const now = Date.now();
        const m = MH.api.getMe();
        const players = [];
        for (const [, t] of MH.tracked) {
            if (now - t.lastSeen > MH.cfg.ttl * 1000) continue;
            players.push({
                n: t.name, x: t.x, y: t.y, src: t.src,
                age: now - t.lastSeen,
                dist: Math.round(Math.hypot(t.x - m.x, t.y - m.y))
            });
        }
        const ws = MH.api.getWalkState();
        sendResponse({
            ok: true, me: m, map: MH.me?.map ?? null, players, lastData: MH.lastData,
            walking: ws.walking, walkMsg: ws.msg,
            route: ws.route, routeIdx: ws.routeIdx,
            mobs: MH.api.getMobs(),
            hunt: MH.hunt ? {
                active: MH.hunt.active,
                state: MH.hunt.state,
                map: MH.hunt.map,
                idx: MH.hunt.idx,
                total: MH.hunt.points.length,
                kills: MH.hunt.stats.kills,
                byName: MH.hunt.stats.byName,
                target: MH.hunt.target ? { n: MH.hunt.target.n, x: MH.hunt.target.x, y: MH.hunt.target.y } : null,
            } : null,
            sim: MH.api.simulation?.getData?.() || null,
        });
    });

    console.log('[MH] main.js cargado');
})();

// ========== SIMULATION MODE (integrado en main.js) ==========
(() => {
    const MH = window.__MH;
    if (!MH) { console.error('[MH] _bus.js no cargado'); return; }
    console.log('[MH] Cargando modo simulación...');

    const SIM = {
        enabled: false,
        currentMapIndex: 0,
        gridStep: 12,
        scanComplete: false,
        lastKills: [],
        mobStats: {},
        currentMap: null,
        phase: 'idle',
        scanStartTime: null,
        scanPoint: null,
        scanLeg: null,
        scanTarget: null,
        visitedTiles: new Set(),
        avoidanceRadius: 16,
        mapOrder: [
            { id: 0, variants: ['/move lorencia'] },
            { id: 3, variants: ['/move noria'] },
            { id: 2, variants: ['/move devias', '/move devias2', '/move devias3', '/move devias4'] },
            { id: 1, variants: ['/move dungeon', '/move dungeon2', '/move dungeon3'] },
            { id: 6, variants: ['/move arena', '/move arena2', '/move arena3', '/move arena4'] },
            { id: 4, variants: ['/move losttower', '/move losttower2', '/move losttower3', '/move losttower4', '/move losttower5', '/move losttower6', '/move losttower7'] },
            { id: 7, variants: ['/move atlans', '/move atlans2', '/move atlans3'] },
            { id: 8, variants: ['/move tarkan', '/move tarkan2'] },
            { id: 10, variants: ['/move icarus'] },
        ],
    };

    chrome.storage.local.get(['simCfg', 'simGridStep'], (c) => {
        if (!c.simCfg) return;
        if (c.simGridStep != null) SIM.gridStep = +c.simGridStep || SIM.gridStep;
        if (c.simCfg) {
            // 'visitedTiles' se serializa como {} en storage (un Set no sobrevive JSON).
            // Filtrarlo: si no, al recargar la página queda un objeto plano y
            // `for (const t of SIM.visitedTiles)` revienta con "not iterable".
            const { visitedTiles, lastKills, mobStats, ...safe } = c.simCfg;
            Object.assign(SIM, safe);
            SIM.enabled = false;
            SIM.phase = 'idle';
            SIM.visitedTiles = new Set();
            SIM.lastKills = [];
            SIM.mobStats = {};
            SIM.gridStep = +safe.gridStep || 12;
        }
    });

    // Guarda solo lo que sobrevive a JSON. El Set se pierde a propósito:
    // el sweep se regenera al empezar cada mapa.
    const saveCfg = () => chrome.storage.local.set({
        simCfg: { gridStep: SIM.gridStep, currentMapIndex: SIM.currentMapIndex },
        simGridStep: SIM.gridStep
    }).catch(() => { });

    const getMapList = () => {
        if (SIM.mapOrder && SIM.mapOrder.length > 0) {
            return SIM.mapOrder
                .map(m => ({
                    id: m.id,
                    name: MH.cfg.mu.maps[m.id],
                    variants: m.variants
                }))
                .filter(m => m.name);
        }
        return Object.entries(MH.cfg.mu.maps)
            .filter(([id, name]) => name && id !== '0')
            .map(([id, name]) => ({ id: parseInt(id), name, variants: [`/move ${name.toLowerCase()}`] }));
    };

    const recordKill = (mobName, exp) => {
        const now = Date.now();
        const mobType = mobName.toLowerCase();
        SIM.lastKills.push({
            map: SIM.currentMap,
            x: MH.me?.x,
            y: MH.me?.y,
            mobName,
            mobType,
            exp,
            timestamp: now
        });
        if (!SIM.mobStats[mobType]) {
            SIM.mobStats[mobType] = {
                count: 0,
                totalExp: 0,
                minExp: Infinity,
                maxExp: 0,
                samples: []
            };
        }
        const stats = SIM.mobStats[mobType];
        stats.count++;
        stats.totalExp += exp;
        stats.minExp = Math.min(stats.minExp, exp);
        stats.maxExp = Math.max(stats.maxExp, exp);
        stats.samples.push({ exp, timestamp, map: SIM.currentMap, x: MH.me?.x, y: MH.me?.y });
        chrome.storage.local.set({
            simData: {
                lastKills: SIM.lastKills,
                mobStats: SIM.mobStats,
                lastUpdate: now
            }
        }).catch(() => { });
        console.log('[MH-SIM] kill registrado:', mobName, 'exp:', exp);
    };

    const moveTo = async (x, y) => {
        console.log('[MH-SIM] moviendo a', x, y);
        await MH.api.goTo(x, y);
    };

    // ---------- esperas reales (goTo NO devuelve promesa al llegar) ----------
    const SIM_MAP_TIMEOUT_MS = 5 * 60 * 1000;

    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    // Espera a que el walk en curso termine de verdad: mira MH.walk.msg.
    // 'llegó' -> llegó; atascado/sin ruta/... -> se quedó; timeout -> sigue andando.
    const waitArrived = async (timeoutMs = 15000) => {
        const t0 = Date.now();
        while (Date.now() - t0 < timeoutMs) {
            if (!SIM.enabled) return 'stopped';
            const msg = (MH.api.getWalkState?.().msg || '').toLowerCase();
            if (msg === 'llegó') return 'arrived';
            if (msg) return 'stuck';
            await sleep(250);
        }
        return 'timeout';
    };

    // Chequeo de atasco con cache de 2 s: la mayoria de los puntos no bloquean.
    let stuckCheckedAt = 0, stuckCached = false;
    const isStuckCached = async () => {
        if (Date.now() - stuckCheckedAt < 2000) return stuckCached;
        await sleep(1500);
        const msg = (MH.api.getWalkState?.().msg || '').toLowerCase();
        stuckCached = /atascado|sin ruta|no hay punto caminable|sin terreno/.test(msg);
        stuckCheckedAt = Date.now();
        return stuckCached;
    };

    const waitingForMap = { on: false, map: null, watch: null, t0: 0 };
    // Ultimo mapa visto por el content (via mh-mypos). MH.me.map lo escribe otro
    // modulo y puede ir por detras del juego; esto es la fuente directa.
    let lastSeenMap = null;
    window.addEventListener('mh-mypos', (ev) => {
        try {
            const d = JSON.parse(ev.detail);
            if (d && d.map != null) lastSeenMap = d.map;
        } catch (_) { }
    });
    const currentMapId = () => (lastSeenMap != null ? lastSeenMap : (MH.me?.map ?? null));
    const startWaitMap = (wantId) => {
        const candidates = (SIM.mapOrder.find(m => m.id === wantId)?.variants || [])
            .map(c => c.toLowerCase().replace(/\s+/g, ''));
        waitingForMap.on = true;
        waitingForMap.map = wantId;
        waitingForMap.watch = { id: wantId, candidates };
        waitingForMap.t0 = Date.now();
    };
    window.addEventListener('mh-map', (ev) => {
        if (!waitingForMap.on) return;
        try {
            const idx = JSON.parse(ev.detail).map;
            const w = waitingForMap.watch;
            const name = String(MH.cfg.mu.maps[idx] || '').toLowerCase().replace(/\s+/g, '');
            if (idx === w.id || (!!name && w.candidates.includes('/move ' + name))) {
                waitingForMap.on = false;
                console.log('[MH-SIM] llegada al mapa confirmada:', idx, MH.cfg.mu.maps[idx]);
            }
        } catch (_) { }
    });

    // Tras mandar el /move, espera a que el mapa cambie DE VERDAD (o timeout).
    const waitMapChange = async (wantId, timeoutMs = 20000) => {
        const before = currentMapId();
        // Si ya estamos en el mapa pedido, el /move no puede cambiarlo: es éxito.
        if (before != null && before === wantId) {
            console.log('[MH-SIM] ya estoy en el mapa pedido', wantId, MH.cfg.mu.maps[wantId]);
            return true;
        }
        startWaitMap(wantId);
        const t0 = Date.now();
        while (Date.now() - t0 < timeoutMs) {
            if (!SIM.enabled) { waitingForMap.on = false; return false; }
            if (!waitingForMap.on) return true;
            const cur = currentMapId();
            if (cur != null && cur !== before) {
                waitingForMap.on = false;
                console.log('[MH-SIM] mapa cambió', before, '->', cur, '(pedido', wantId, ')');
                return true;
            }
            await sleep(400);
        }
        waitingForMap.on = false;
        console.warn('[MH-SIM] el mapa no cambió en', timeoutMs, 'ms (pedido', wantId, ')');
        return false;
    };

    const moveToMap = async (mapId, variantCommand = null) => {
        // 1. cortar cualquier walk en curso: si sigue, el walk muere solo con
        // 'cambió de mapa' (autowalk.js) y el chequeo de atasco da falsos positivos.
        MH.api.stopWalk?.('sim-mapchange', false);
        await sleep(150);

        let cmd = variantCommand;
        if (!cmd) {
            const mapName = MH.cfg.mu.maps[mapId];
            if (!mapName) {
                console.error('[MH-SIM] mapa no encontrado:', mapId);
                return false;
            }
            cmd = `/move ${mapName.toLowerCase().replace(/\s+/g, '')}`;
        }
        console.log('[MH-SIM] moviendo al mapa', mapId, 'con comando:', cmd);

        // 2. mandar el comando y ESPERAR a que el mapa cambie de verdad.
        await MH.api.stopHoldThenChat?.(cmd);
        return await waitMapChange(mapId, 20000);
    };

    const startMapScan = async (mapId) => {
        SIM.currentMap = mapId;
        SIM.phase = 'scanning_map';
        SIM.scanStartTime = Date.now();
        console.log('[MH-SIM] iniciando scan del mapa', mapId, MH.cfg.mu.maps[mapId]);

        // El terreno se guarda bajo el id REAL del mapa (mh-map -> storage).
        // Si el /move fue a una variante, `mapId` es el pedido, no el actual.
        let realMap = currentMapId();
        let b64 = null;
        for (let i = 0; i < 25; i++) {
            realMap = currentMapId() ?? realMap;
            if (realMap != null) {
                b64 = (await chrome.storage.local.get('map:' + realMap))['map:' + realMap];
                if (b64) break;
            }
            await sleep(200);
        }

        if (!b64) {
            console.error('[MH-SIM] no se pudo cargar el terreno del mapa', realMap ?? mapId);
            SIM.phase = 'idle';
            return;
        }
        if (realMap != null && realMap !== mapId) {
            console.log('[MH-SIM] el mapa real es', realMap, MH.cfg.mu.maps[realMap], '(se pidió', mapId, ')');
            SIM.currentMap = realMap;
        }

        const bin = atob(b64);
        const ok = (x, y) => x >= 0 && y >= 0 && x < 256 && y < 256 && !(bin.charCodeAt(y * 256 + x) & 12);

        const startMe = MH.api.getMe();
        if (!startMe) {
            console.error('[MH-SIM] sin posición del personaje');
            SIM.phase = 'idle';
            return;
        }

        const start = startMe.y * 256 + startMe.x;
        const visited = new Uint8Array(65536);
        const accessibleTiles = [];
        const q = [start];
        visited[start] = 1;

        for (let h = 0; h < q.length; h++) {
            const c = q[h], cx = c & 255, cy = c >> 8;
            accessibleTiles.push({ x: cx, y: cy });
            for (let dx = -1; dx <= 1; dx++) {
                for (let dy = -1; dy <= 1; dy++) {
                    if (!dx && !dy) continue;
                    const nx = cx + dx, ny = cy + dy, n = ny * 256 + nx;
                    if (!ok(nx, ny) || visited[n]) continue;
                    if (dx && dy && (!ok(cx + dx, cy) || !ok(cx, cy + dy))) continue;
                    visited[n] = 1;
                    q.push(n);
                }
            }
        }

        console.log('[MH-SIM] tiles accesibles:', accessibleTiles.length);

        // ---------- sweep ida/vuelta (boustrophedon) ----------
        // En vez de filtrar por x%step && y%step (que solo pisa una diagonal
        // de la grilla), barremos fila por fila: izquierda->derecha, bajamos
        // `step` tiles y volvemos derecha->izquierda, etc.
        const step = Math.max(2, +SIM.gridStep || 12);
        const walkable = new Uint8Array(65536);
        for (const t of accessibleTiles) walkable[t.y * 256 + t.x] = 1;

        const rowHas = (y) => {
            if (y < 0 || y > 255) return false;
            for (let x = 0; x < 256; x++) if (walkable[y * 256 + x]) return true;
            return false;
        };
        const nearestWalkable = (y, dir) => {
            if (y < 0 || y > 255) return null;
            for (let i = 0; i < 256; i++) {
                const x = dir > 0 ? i : 255 - i;
                if (walkable[y * 256 + x]) return x;
            }
            return null;
        };

        const ys = accessibleTiles.map((t) => t.y);
        const yMin = Math.min.apply(null, ys), yMax = Math.max.apply(null, ys);

        // Piernas del sweep: cada pierna es una fila recorrida de lado a lado.
        const legs = [];
        let dir = 1;
        for (let y = yMin; y <= yMax; y += step) {
            let rowY = y;
            if (!rowHas(rowY)) {
                for (let k = 0; k < step && !rowHas(rowY); k++) rowY++;
                if (!rowHas(rowY)) rowY = -1;
            }
            if (rowY < 0 || rowY > 255) { dir = -dir; continue; }
            const xFrom = nearestWalkable(rowY, dir);
            const xTo = nearestWalkable(rowY, -dir);
            if (xFrom == null || xTo == null) { dir = -dir; continue; }
            legs.push({ y: rowY, xFrom, xTo });
            dir = -dir;
        }

        // Puntos intermedios cada `step` a lo largo de cada pierna.
        const expanded = [];
        for (let li = 0; li < legs.length; li++) {
            const L = legs[li];
            const sgn = Math.sign(L.xTo - L.xFrom) || 1;
            for (let x = L.xFrom; ; x += sgn * step) {
                const clamped = sgn > 0 ? Math.min(x, L.xTo) : Math.max(x, L.xTo);
                expanded.push({ x: clamped, y: L.y, leg: li });
                if (clamped === L.xTo) break;
            }
        }

        console.log('[MH-SIM] filas del barrido:', legs.length, 'Â· puntos:', expanded.length);

        // ---------- recorrido con fallback a reconocimiento ----------
        // Al atascarse, en vez de insistir buscamos un tile caminable cercano
        // EN LA DIRECCION DEL FINAL de la pierna, que es lo que desatasco el
        // personaje; al recuperar ruta volvemos al barrido.
        const nearWalkableToward = (px, py, tx, ty) => {
            const dx0 = Math.sign(tx - px), dy0 = Math.sign(ty - py);
            for (let r = 1; r <= 24; r++) {
                let best = null, bestD = Infinity;
                for (let dx = -r; dx <= r; dx++) {
                    for (let dy = -r; dy <= r; dy++) {
                        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
                        const nx = px + dx, ny = py + dy;
                        if (nx < 0 || ny < 0 || nx > 255 || ny > 255) continue;
                        if (!walkable[ny * 256 + nx]) continue;
                        if (dx0 && Math.sign(dx) !== dx0) continue;
                        if (dy0 && Math.sign(dy) !== dy0) continue;
                        const d = Math.hypot(dx, dy);
                        if (d < bestD) { bestD = d; best = { x: nx, y: ny }; }
                    }
                }
                if (best) return best;
            }
            return null;
        };

        for (let i = 0; i < expanded.length; i++) {
            if (!SIM.enabled) {
                console.log('[MH-SIM] simulacion detenida');
                SIM.scanPoint = null;
                SIM.scanTarget = null;
                SIM.phase = 'idle';
                await MH.api.unholdMouse?.();
                return;
            }

            const point = expanded[i];
            const leg = legs[point.leg];
            const endOfLeg = { x: leg.xTo, y: leg.y };

            SIM.scanPoint = (i + 1) + '/' + expanded.length;
            SIM.scanTarget = { x: point.x, y: point.y };
            SIM.scanLeg = (point.leg + 1) + '/' + legs.length;
            SIM.phase = 'sweeping';
            console.log('[MH-SIM] ' + (i + 1) + '/' + expanded.length + ' -> (' + point.x + ', ' + point.y + ') [pierna ' + (point.leg + 1) + '/' + legs.length + ']');

            await moveTo(point.x, point.y);

            // Espera real: goTo no resuelve al llegar, el walk avisa por MH.walk.msg.
            let status = await waitArrived(15000);
            if (status === 'stopped') break;

            // Chequeo de atasco (con cache, no en cada punto: iria 1.5 s por punto).
            const stuck = (status === 'stuck') || await isStuckCached();
            if (stuck) {
                const ws = MH.api.getWalkState?.() || {};
                let me0 = MH.api.getMe();
                let alt = me0 ? nearWalkableToward(me0.x, me0.y, endOfLeg.x, endOfLeg.y) : null;
                if (alt) {
                    SIM.phase = 'reconnoitering';
                    console.log('[MH-SIM] atasco (' + (ws.msg || '?') + ') -> reconocimiento hacia (' + alt.x + ', ' + alt.y + ') rumbo al final de pierna (' + endOfLeg.x + ', ' + endOfLeg.y + ')');
                    for (let k = 0; k < 3 && SIM.enabled; k++) {
                        MH.api.stopWalk?.('sim-recon', false);
                        await moveTo(alt.x, alt.y);
                        const st2 = await waitArrived(12000);
                        if (st2 === 'arrived' || st2 === 'timeout') break;
                        const me2 = MH.api.getMe();
                        const alt2 = me2 ? nearWalkableToward(me2.x, me2.y, endOfLeg.x, endOfLeg.y) : null;
                        if (!alt2) break;
                        alt = alt2;
                    }
                    SIM.phase = 'sweeping';
                }
            }

            SIM.visitedTiles.add(point.x + ',' + point.y);

            const mobs = MH.api.getMobs?.() || [];
            const me = MH.api.getMe();
            if (me && mobs.length > 0) {
                const nearbyMobs = mobs.filter(([name, x, y]) => Math.hypot(x - me.x, y - me.y) <= 10);
                if (nearbyMobs.length > 0) {
                    console.log('[MH-SIM] mobs cercanos:', nearbyMobs.length);
                    await MH.api.holdMouse?.(false);
                    await sleep(3000);
                    await MH.api.unholdMouse?.();
                }
            }

            // Tope de tiempo por mapa: si el barrido se cuelga, se pasa al siguiente.
            if (Date.now() - SIM.scanStartTime > SIM_MAP_TIMEOUT_MS) {
                console.warn('[MH-SIM] tiempo agotado en el mapa', SIM.currentMap, '- paso al siguiente');
                SIM.mapTimedOut = true;
                break;
            }
            await sleep(200);
        }

        console.log('[MH-SIM] scan', SIM.mapTimedOut ? 'cortado por timeout' : 'completo', 'del mapa', mapId);
        SIM.mapTimedOut = false;
        SIM.scanPoint = null;
        SIM.scanTarget = null;
        SIM.scanLeg = null;
        SIM.phase = 'idle';
    };

    let simTimer = null;
    const runSimulation = async () => {
        if (!SIM.enabled || SIM.phase !== 'idle') return;

        const maps = getMapList();
        if (SIM.currentMapIndex >= maps.length) {
            console.log('[MH-SIM] simulación completa!');
            SIM.phase = 'complete';
            SIM.scanComplete = true;
            return;
        }

        const targetMap = maps[SIM.currentMapIndex];
        console.log('[MH-SIM] siguiente mapa:', targetMap.id, targetMap.name);

        const variants = targetMap.variants || [`/move ${targetMap.name.toLowerCase().replace(/\s+/g, '')}`];
        let done = false;
        for (let vi = 0; vi < variants.length; vi++) {
            if (!SIM.enabled) return;
            const variant = variants[vi];
            console.log('[MH-SIM] probando variante:', variant);
            SIM.phase = 'moving_to_map';
            const moved = await moveToMap(targetMap.id, variant);
            if (!moved) {
                console.warn('[MH-SIM] no llegué al mapa con', variant, '- siguiente variante');
                continue;
            }
            await startMapScan(targetMap.id);
            // Las variantes son sub-mapas del mismo id: con UNA llegada alcanza.
            done = true;
            break;
        }

        if (!done && SIM.enabled) {
            console.warn('[MH-SIM] mapa', targetMap.id, targetMap.name, 'inalcanzable - lo salto');
        }

        SIM.currentMapIndex++;
        saveCfg();

        if (SIM.enabled) {
            setTimeout(() => runSimulation(), 1000);
        }
    };

    const startLoop = () => {
        if (simTimer) clearInterval(simTimer);
        simTimer = setInterval(() => {
            if (SIM.enabled && SIM.phase === 'idle') {
                runSimulation().catch(e => console.error('[MH-SIM]', e));
            }
        }, 1000);
    };

    startLoop();

    MH.api.simulation = {
        start: (step) => {
            if (+step >= 2) SIM.gridStep = +step;
            SIM.enabled = true;
            SIM.currentMapIndex = 0;
            SIM.phase = 'idle';
            SIM.scanComplete = false;
            SIM.lastKills = [];
            SIM.mobStats = {};
            SIM.visitedTiles.clear();
            SIM.scanPoint = null;
            SIM.scanLeg = null;
            SIM.scanTarget = null;
            saveCfg();
            console.log('[MH-SIM] simulación iniciada');
        },
        stop: () => {
            SIM.enabled = false;
            SIM.phase = 'idle';
            SIM.scanPoint = null;
            SIM.scanLeg = null;
            SIM.scanTarget = null;
            MH.api.unholdMouse?.();
            saveCfg();
            console.log('[MH-SIM] simulación detenida');
        },
        isEnabled: () => SIM.enabled,
        getData: () => ({
            enabled: SIM.enabled,
            phase: SIM.phase,
            scanPoint: SIM.scanPoint,
            scanLeg: SIM.scanLeg,
            scanTarget: SIM.scanTarget,
            walkMsg: MH.api.getWalkState?.().msg || '',
            gridStep: SIM.gridStep,
            progress: SIM.currentMapIndex,
            lastKills: SIM.lastKills,
            mobStats: SIM.mobStats,
            currentMap: SIM.currentMap,
            currentMapName: SIM.currentMap != null ? (MH.cfg.mu.maps[SIM.currentMap] || null) : null,
            progress: SIM.currentMapIndex,
            totalMaps: getMapList().length
        }),
        recordKill: (mobName, exp) => {
            recordKill(mobName, exp);
        },
        exportData: () => {
            const data = {
                mobStats: SIM.mobStats,
                lastKills: SIM.lastKills,
                exportDate: new Date().toISOString()
            };
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.download = `sim_data_${Date.now()}.json`;
            a.click();
            URL.revokeObjectURL(url);
        }
    };

    console.log('[MH] modo simulación cargado');
})();
