// content/routes.js
(() => {
    const MH = window.__MH;
    if (!MH) { console.error('[MH] _bus.js no cargado'); return; }

    MH.routes = { list: [], activeId: 'default' };

    const DEFAULT = [{
        id: 'default',
        name: 'Farm estándar',
        steps: [
            { lv: 0, map: 0, spot: { x: 202, y: 124 }, untilLv: 16 },
            { lv: 16, map: 2, spot: { x: 225, y: 217 }, untilLv: 113 },
            { lv: 113, map: 10, spot: { x: 46, y: 199 }, untilLv: 400 },
        ],
    }];

    const persist = () => chrome.storage.local.set({
        routes: MH.routes.list,
        activeRoute: MH.routes.activeId,
    });

    const load = async () => {
        const c = await chrome.storage.local.get(['routes', 'activeRoute']);
        MH.routes.list = (Array.isArray(c.routes) && c.routes.length) ? c.routes : structuredClone(DEFAULT);
        MH.routes.activeId = c.activeRoute || MH.routes.list[0].id;
        if (!MH.routes.list.find(r => r.id === MH.routes.activeId)) {
            MH.routes.activeId = MH.routes.list[0].id;
        }
        console.log('[MH-ROUTES] cargadas:', MH.routes.list.length);
    };
    load();

    chrome.storage.onChanged.addListener((ch, area) => {
        if (area !== 'local') return;
        if (ch.routes) {
            MH.routes.list = Array.isArray(ch.routes.newValue) ? ch.routes.newValue : [];
            console.log('[MH-ROUTES] sincronizadas:', MH.routes.list.length);
        }
        if (ch.activeRoute) {
            MH.routes.activeId = ch.activeRoute.newValue;
        }
    });

    const getActiveStep = () => {
        const route = MH.routes.list.find(r => r.id === MH.routes.activeId);
        if (!route) return null;
        const lv = Number(MH.auto?.lv ?? 0);
        return [...route.steps]
            .sort((a, b) => Number(b.lv) - Number(a.lv))
            .find(s => lv >= Number(s.lv) && lv < Number(s.untilLv)) || null;
    };

    // ⬇️ NUEVO: cooldown por comando. Si pasan 15s sin llegar, se reintenta.
    const MOVE_COOLDOWN_MS = 15000;

    MH.api.applyActiveStep = async () => {
        const a = MH.auto;
        if (!a) return;
        const step = getActiveStep();
        if (!step) return;

        const me = MH.api.getMe?.();
        if (!me || me.map == null) return;

        // 1. MAPA DISTINTO → viaje
        if (me.map !== step.map) {
            // `step.cmd` = variante elegida en el popup (ej. '/move devias2').
            // Si no hay, la primera variante del mapa (moveCommands[step.map]).
            const cmd = step.cmd || MH.cfg.mu.moveCommands[step.map];

            // MODO VENTANA M: abre el menú de mapas y clica el nombre. Se pide
            // al background, que lo ejecuta en el MAIN world (window.__mhWarpWindow).
            if (step.warp === 'window') {
                const nombre = step.warpName || step.mapName || cmd || String(step.map);
                const lastAtW = a.lastMoveAt || 0;
                if (a.lastMoveCmd === 'warp:' + nombre && Date.now() - lastAtW < MOVE_COOLDOWN_MS) return;
                console.log('[ROUTES] viaje por ventana M →', nombre);
                a.lastMoveCmd = 'warp:' + nombre;
                a.lastMoveMap = step.map;
                a.lastMoveAt = Date.now();
                if (a.holding) await MH.api.unholdMouse?.();
                chrome.runtime.sendMessage({ target: 'bg', type: 'mh-warp', name: nombre }).catch(() => { });
                return;
            }

            if (!cmd) {
                console.warn('[ROUTES] no hay comando /move para mapa', step.map);
                return;
            }

            // Reintentar cada MOVE_COOLDOWN_MS en lugar de bloquear para siempre
            const lastAt = a.lastMoveAt || 0;
            const sameCmd = a.lastMoveCmd === cmd && a.lastMoveMap === step.map;
            if (sameCmd && Date.now() - lastAt < MOVE_COOLDOWN_MS) {
                // todavía en cooldown, esperar
                return;
            }

            console.log('[ROUTES] mandando', cmd, '(reintento si pasan', MOVE_COOLDOWN_MS / 1000, 's)');
            a.lastMoveCmd = cmd;
            a.lastMoveMap = step.map;
            a.lastMoveAt = Date.now();

            if (a.holding) await MH.api.unholdMouse?.();
            MH.api.stopHoldThenChat?.(cmd);
            return;
        }

        // 2. Ya estoy en el mapa correcto → limpiar marcas de move
        if (a.lastMoveCmd) {
            console.log('[ROUTES] llegué al mapa', step.map, '· limpiando marca de move');
        }
        a.lastMoveCmd = null;
        a.lastMoveMap = null;
        a.lastMoveAt = 0;

        // 3. Estoy caminando → esperar
        if (MH.api.isWalking?.()) {
            return;
        }

        // 4. Ir al spot
        const d = Math.hypot(me.x - step.spot.x, me.y - step.spot.y);
        if (d > 2) {
            if (a.holding) await MH.api.unholdMouse?.();
            console.log('[ROUTES] caminando al spot, d=', d.toFixed(1));
            MH.api.goTo?.(step.spot.x, step.spot.y, 1);
            return;
        }

        // 5. Hold
        if (!a.holding) {
            console.log('[ROUTES] HOLD en el spot');
            a.holdSpot = { x: step.spot.x, y: step.spot.y, map: step.map };
            await MH.api.holdMouse?.();
        }
    };

    MH.api.getRoutes = () => MH.routes.list;
    MH.api.getActiveRoute = () => MH.routes.list.find(r => r.id === MH.routes.activeId);

    chrome.runtime.onMessage.addListener((msg) => {
        if (msg.target !== 'content' || msg.type !== 'route-save' || !msg.route) return;
        const i = MH.routes.list.findIndex(r => r.id === msg.route.id);
        if (i >= 0) MH.routes.list[i] = msg.route;
        else MH.routes.list.push(msg.route);
        persist();
    });

    console.log('[MH] routes.js cargado');
})();