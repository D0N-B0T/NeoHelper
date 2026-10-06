// content/simulation.js
// Modo simulación: recorre todos los mapas en grid, registra exp de mobs
// Objetivo: recolectar datos para optimizar rutas de farmeo

console.log('[MH] Cargando simulation.js...');

(() => {
    const MH = window.__MH;
    if (!MH) { console.error('[MH] _bus.js no cargado'); return; }
    console.log('[MH] simulation.js cargado');

    const SIM = {
        enabled: false,
        currentMapIndex: 0,
        mapsToScan: [],
        gridStep: 5,  // cada 5 tiles
        scanComplete: false,
        currentX: 0,
        currentY: 0,
        targetX: 0,
        targetY: 0,
        lastKills: [],  // { map, x, y, mobName, mobType, exp, timestamp }
        mobStats: {},  // { mobType: { count, totalExp, minExp, maxExp, samples: [] } }
        currentMap: null,
        phase: 'idle',  // idle, scanning_map, moving_to_map, complete
        scanStartTime: null,
        visitedTiles: new Set(),  // tiles ya visitados (coordenadas "x,y")
        avoidanceRadius: 16,  // radio de tiles a evitar
        // Orden personalizado de mapas con variantes
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

    // ---------- Configuración desde storage ----------
    chrome.storage.local.get('simCfg', (c) => {
        if (c.simCfg) {
            // NO cargar enabled desde storage para evitar activación automática
            Object.assign(SIM, c.simCfg);
            SIM.enabled = false;  // siempre false al cargar
        }
    });
    chrome.storage.onChanged.addListener((ch, area) => {
        if (area === 'local' && ch.simCfg) {
            Object.assign(SIM, ch.simCfg.newValue || {});
            SIM.enabled = false;  // nunca auto-activar desde storage
        }
    });

    // ---------- Helpers ----------
    const getMapList = () => {
        // Usar el orden personalizado con variantes
        if (SIM.mapOrder && SIM.mapOrder.length > 0) {
            return SIM.mapOrder
                .map(m => ({
                    id: m.id,
                    name: MH.cfg.mu.maps[m.id],
                    variants: m.variants
                }))
                .filter(m => m.name);
        }
        // Fallback a todos los mapas
        return Object.entries(MH.cfg.mu.maps)
            .filter(([id, name]) => name && id !== '0')
            .map(([id, name]) => ({ id: parseInt(id), name, variants: [`/move ${name.toLowerCase()}`] }));
    };

    const recordKill = (mobName, exp) => {
        const now = Date.now();
        const mobType = mobName.toLowerCase();

        // Registro individual
        SIM.lastKills.push({
            map: SIM.currentMap,
            x: MH.me?.x,
            y: MH.me?.y,
            mobName,
            mobType,
            exp,
            timestamp: now
        });

        // Estadísticas por tipo
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

        // Guardar en storage
        chrome.storage.local.set({
            simData: {
                lastKills: SIM.lastKills,
                mobStats: SIM.mobStats,
                lastUpdate: now
            }
        }).catch(() => { });

        console.log('[MH-SIM] kill registrado:', mobName, 'exp:', exp, 'map:', SIM.currentMap);
    };

    const moveTo = async (x, y) => {
        console.log('[MH-SIM] moviendo a', x, y);
        await MH.api.goTo(x, y);
    };

    const moveToMap = async (mapId, variantCommand = null) => {
        if (variantCommand) {
            console.log('[MH-SIM] moviendo al mapa', mapId, 'con comando:', variantCommand);
            await MH.api.stopHoldThenChat?.(variantCommand);
        } else {
            const mapName = MH.cfg.mu.maps[mapId];
            if (!mapName) {
                console.error('[MH-SIM] mapa no encontrado:', mapId);
                return false;
            }
            console.log('[MH-SIM] moviendo al mapa', mapId, mapName);
            const cmd = `/move ${mapName.toLowerCase().replace(/\s+/g, '')}`;
            await MH.api.stopHoldThenChat?.(cmd);
        }
        return true;
    };

    // ---------- Grid Scan ----------
    const startMapScan = async (mapId) => {
        SIM.currentMap = mapId;
        SIM.phase = 'scanning_map';
        SIM.scanStartTime = Date.now();

        console.log('[MH-SIM] iniciando scan del mapa', mapId, MH.cfg.mu.maps[mapId]);

        // Esperar a llegar al mapa
        await new Promise(r => setTimeout(r, 3000));

        // Obtener terreno del mapa
        const mapIdKey = 'map:' + mapId;
        let b64 = null;
        for (let i = 0; i < 25; i++) {
            b64 = (await chrome.storage.local.get(mapIdKey))[mapIdKey];
            if (b64) break;
            await new Promise(r => setTimeout(r, 200));
        }

        if (!b64) {
            console.error('[MH-SIM] no se pudo cargar el terreno del mapa');
            SIM.phase = 'idle';
            return;
        }

        const bin = atob(b64);
        const ok = (x, y) => x >= 0 && y >= 0 && x < 256 && y < 256 && !(bin.charCodeAt(y * 256 + x) & 12);

        // BFS para encontrar todos los tiles accesibles desde la posición actual
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
                    // Evitar cortar esquinas
                    if (dx && dy && (!ok(cx + dx, cy) || !ok(cx, cy + dy))) continue;
                    visited[n] = 1;
                    q.push(n);
                }
            }
        }

        console.log('[MH-SIM] tiles accesibles:', accessibleTiles.length);

        // Filtrar tiles por grid step y evitar áreas ya visitadas
        const step = SIM.gridStep;
        const radius = SIM.avoidanceRadius;

        const scanPoints = accessibleTiles.filter(({ x, y }) => {
            // Grid step
            if (x % step !== 0 || y % step !== 0) return false;

            // Evitar tiles cerca de tiles ya visitados
            for (const visited of SIM.visitedTiles) {
                const [vx, vy] = visited.split(',').map(Number);
                const dist = Math.hypot(x - vx, y - vy);
                if (dist < radius) return false;
            }

            return true;
        });

        console.log('[MH-SIM] puntos a visitar:', scanPoints.length);

        // Visitar cada punto
        for (let i = 0; i < scanPoints.length; i++) {
            if (!SIM.enabled) {
                console.log('[MH-SIM] simulación detenida');
                SIM.phase = 'idle';
                await MH.api.unholdMouse?.();
                return;
            }

            const point = scanPoints[i];
            console.log(`[MH-SIM] ${i + 1}/${scanPoints.length} → (${point.x}, ${point.y})`);

            // Mover al punto
            await moveTo(point.x, point.y);
            await new Promise(r => setTimeout(r, 1000));  // esperar a llegar

            // Marcar como visitado
            SIM.visitedTiles.add(`${point.x},${point.y}`);

            // Detectar mobs cercanos y atacar
            const mobs = MH.api.getMobs?.() || [];
            const me = MH.api.getMe();
            if (me && mobs.length > 0) {
                // Encontrar mobs dentro de radio de 10 tiles
                const nearbyMobs = mobs.filter(([name, x, y]) => {
                    const dist = Math.hypot(x - me.x, y - me.y);
                    return dist <= 10;
                });

                if (nearbyMobs.length > 0) {
                    console.log('[MH-SIM] mobs cercanos:', nearbyMobs.length);
                    // Activar hold para atacar
                    await MH.api.holdMouse?.(false);
                    // Esperar a matar (3 segundos)
                    await new Promise(r => setTimeout(r, 3000));
                    await MH.api.unholdMouse?.();
                }
            }

            // Pausa breve antes del siguiente punto
            await new Promise(r => setTimeout(r, 500));
        }

        console.log('[MH-SIM] scan completo del mapa', mapId);
        SIM.phase = 'idle';
    };

    // ---------- Loop principal ----------
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

        // Iterar sobre todas las variantes del mapa
        const variants = targetMap.variants || [`/move ${targetMap.name.toLowerCase().replace(/\s+/g, '')}`];
        for (const variant of variants) {
            if (!SIM.enabled) return;

            console.log('[MH-SIM] probando variante:', variant);
            SIM.phase = 'moving_to_map';
            await moveToMap(targetMap.id, variant);
            await new Promise(r => setTimeout(r, 4000));  // esperar carga del mapa

            await startMapScan(targetMap.id);
        }

        SIM.currentMapIndex++;
        chrome.storage.local.set({ simCfg: SIM }).catch(() => { });

        // Continuar al siguiente mapa
        if (SIM.enabled) {
            setTimeout(() => runSimulation(), 1000);
        }
    };

    // ---------- Eventos ----------
    // Iniciar loop cuando se activa
    const startLoop = () => {
        if (simTimer) clearInterval(simTimer);
        simTimer = setInterval(() => {
            if (SIM.enabled && SIM.phase === 'idle') {
                runSimulation().catch(e => console.error('[MH-SIM]', e));
            }
        }, 1000);
    };

    startLoop();

    // ---------- API ----------
    MH.api.simulation = {
        start: () => {
            SIM.enabled = true;
            SIM.currentMapIndex = 0;
            SIM.phase = 'idle';
            SIM.scanComplete = false;
            SIM.lastKills = [];
            SIM.mobStats = {};
            SIM.visitedTiles.clear();
            chrome.storage.local.set({ simCfg: SIM }).catch(() => { });
            console.log('[MH-SIM] simulación iniciada');
        },
        stop: () => {
            SIM.enabled = false;
            SIM.phase = 'idle';
            await MH.api.unholdMouse?.();  // soltar hold al detener
            chrome.storage.local.set({ simCfg: SIM }).catch(() => { });
            console.log('[MH-SIM] simulación detenida');
        },
        isEnabled: () => SIM.enabled,
        getData: () => ({
            lastKills: SIM.lastKills,
            mobStats: SIM.mobStats,
            currentMap: SIM.currentMap,
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

    console.log('[MH] simulation.js cargado');
})();
