// content/radar.js
// Tracking de entidades + alertas de interés.
// Expone: window.__MH.api.getMe()
// Consume: window.__MH.tracked, window.__MH.cfg, window.__MH.me, window.__MH.lastData

(() => {
    const MH = window.__MH;
    if (!MH) { console.error('[MH] _bus.js no cargado'); return; }

    const ALERT_COOLDOWN_MS = 60_000;

    // ---------- Config viva desde storage ----------
    const readCfg = () => chrome.storage.local
        .get(['watchlist', 'radarMinDist', 'radarTTL', 'radarMeX', 'radarMeY', 'resetLv', 'resetBase'])
        .then((c) => {
            MH.cfg.watch = (c.watchlist || '').split(',').map((n) => n.trim().toLowerCase()).filter(Boolean);
            MH.cfg.minDist = +c.radarMinDist || 0;
            MH.cfg.ttl = Math.max(3, +c.radarTTL || 15);
            MH.cfg.meX = +(c.radarMeX ?? 226);
            MH.cfg.meY = +(c.radarMeY ?? 236);
            MH.cfg.resetLv = +(c.resetLv ?? 400);
            MH.cfg.resetBase = +(c.resetBase ?? 0);
        }).catch(() => { });

    readCfg();
    chrome.storage.onChanged.addListener((_, area) => { if (area === 'local') readCfg(); });

    // ---------- Posición propia ----------
    // La detectada si es reciente; si no, la manual de la config
    const getMe = () => {
        if (MH.me && Date.now() - MH.me.ts < 5000) {
            return { x: MH.me.x, y: MH.me.y, map: MH.me.map, auto: true };
        }
        return { x: MH.cfg.meX, y: MH.cfg.meY, map: MH.me?.map ?? null, auto: false };
    };

    // ⬇️ ESTA LÍNEA FALTABA
    MH.api.getMe = getMe;

    window.addEventListener('mh-mypos', (ev) => {
        try {
            const d = JSON.parse(ev.detail);
            if (Number.isFinite(+d.x) && Number.isFinite(+d.y)) {
                MH.me = { x: +d.x, y: +d.y, map: d.map, ts: Date.now() };   // ⬅️ acá SÍ está map
            }
        } catch (_) { }
    });

    // ---------- Tracking de entidades ----------
    // Cada avistamiento actualiza el estado. Se alerta UNA vez por "visita":
    // cuando el jugador aparece (o reaparece tras ttl sin verse) y cumple la distancia.
    // Mientras siga visible, solo se actualiza su posición.
    window.addEventListener('mh-entity', (ev) => {
        try {
            const { src, list } = JSON.parse(ev.detail);
            const now = Date.now();
            const ttlMs = MH.cfg.ttl * 1000;
            const m = getMe();
            MH.lastData = now;

            const seen = {};
            for (const e of list) {
                const k = seen[e.n] = (seen[e.n] ?? -1) + 1;
                const key = k ? `${e.n}#${k}` : e.n;
                let t = MH.tracked.get(key);
                const wasPresent = !!t && now - t.lastSeen <= ttlMs;
                if (!t) { t = { lastAlert: 0 }; MH.tracked.set(key, t); }
                if (!wasPresent) { t.firstSeen = now; t.notified = false; }
                t.name = e.n; t.x = e.x; t.y = e.y; t.lastSeen = now; t.src = src;

                if (t.notified || !MH.cfg.watch.includes(e.n.toLowerCase())) continue;
                const dist = Math.round(Math.hypot(e.x - m.x, e.y - m.y));
                if (dist < MH.cfg.minDist) continue;
                t.notified = true;
                if (now - t.lastAlert < ALERT_COOLDOWN_MS) continue;
                t.lastAlert = now;
                chrome.runtime.sendMessage({
                    target: 'bg', type: 'alert_interest',
                    nombre: e.n, distancia: dist, x: e.x, y: e.y
                }).catch(() => { });
            }

            // limpieza si la tabla crece demasiado
            if (MH.tracked.size > 300) {
                for (const [k, v] of MH.tracked) {
                    if (now - v.lastSeen > 300_000) MH.tracked.delete(k);
                }
            }
        } catch (_) { }
    });

    console.log('[MH] radar.js cargado');
})();