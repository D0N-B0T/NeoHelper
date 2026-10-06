(() => {
    const MH = window.__MH;
    if (!MH) return;



    const SALT = 12;   // separación entre puntos del sweep (tiles)
    const DETECT_RADIUS = 40;   // radio de detección de Goldens

    MH.hunt = {
        active: false,
        map: null,
        points: [],
        idx: 0,
        state: 'idle',           // idle | sweep | chase | kill | loot
        target: null,            // {n, x, y}
        lastSeenTick: 0,
        savedAutoEnabled: null,  // para restaurar AUTO
        stats: { kills: 0, byName: {} },
        lastLoot: null,
    };

    // ---------- generación del sweep ----------
    async function buildSweep(map, salt = 12) {
        const b64 = (await chrome.storage.local.get('map:' + map))['map:' + map];
        if (!b64) return [];
        const bin = atob(b64);
        const ok = (x, y) => x >= 0 && y >= 0 && x < 256 && y < 256 && !(bin.charCodeAt(y * 256 + x) & 12);
        const points = [];
        for (let y = 4; y < 252; y += salt) {
            const xs = [];
            for (let x = 4; x < 252; x += salt) if (ok(x, y)) xs.push(x);
            if (!xs.length) continue;
            const row = Math.floor(y / salt);
            if (row % 2 === 1) xs.reverse();
            for (const x of xs) points.push({ x, y });
        }
        return points;
    }

    // ---------- Goldens visibles ahora ----------
    function findGoldens(map) {
        const names = MH.cfg.mu.goldens[map] || [];
        if (!names.length) return [];
        const enabled = MH.hunt.enabled || {};
        const active = names.filter(n => enabled[n] !== false);
        if (!active.length) return [];
        const mobs = MH.api.getMobs?.() || [];
        return mobs
            .filter(([id, n, x, y]) => active.includes(n) && x >= 0 && y >= 0)
            .map(([id, n, x, y]) => ({ id, n, x, y }));
    }

    // ---------- API pública ----------
    MH.api.startHunt = async (map, cfg = {}) => {
        if (MH.hunt.active) return;
        if (MH.me?.map !== map) {
            console.warn('[MH-HUNT] no estás en el mapa', map, ', estás en', MH.me?.map);
            return;
        }
        const salt = cfg.salt || 12;
        const points = await buildSweep(map, salt);
        if (!points.length) return;

        const { autoEnabled } = await chrome.storage.local.get('autoEnabled');
        MH.hunt.savedAutoEnabled = !!autoEnabled;
        if (autoEnabled) await chrome.storage.local.set({ autoEnabled: false });

        await chrome.runtime.sendMessage({ target: 'bg', type: 'stop' }).catch(() => { });
        MH.api.stopWalk?.('hunt-start', false);

        Object.assign(MH.hunt, {
            active: true,
            map,
            points,
            idx: 0,
            state: 'sweep',
            target: null,
            radius: cfg.radius || 40,
            loot: cfg.loot !== false,
            enabled: cfg.enabled || {},
            stats: { kills: 0, byName: {} },
        });

        console.log('[MH-HUNT] iniciando cacería en mapa', map, '· puntos:', points.length);
    };

    MH.api.stopHunt = async () => {
        if (!MH.hunt.active) return;
        MH.api.stopWalk?.('hunt-stop', false);
        await chrome.runtime.sendMessage({ target: 'bg', type: 'stop' }).catch(() => { });
        const restore = MH.hunt.savedAutoEnabled;
        MH.hunt.active = false;
        MH.hunt.state = 'idle';
        MH.hunt.target = null;
        if (restore) await chrome.storage.local.set({ autoEnabled: true });
        console.log('[MH-HUNT] cacería detenida · kills:', MH.hunt.stats.kills);
    };

    // ---------- loop ----------
    setInterval(() => {
        if (!MH.hunt.active) return;
        try {
            const me = MH.me;
            if (!me || me.map !== MH.hunt.map) return;   // cambio de mapa: ignorar

            const goldens = findGoldens(MH.hunt.map);

            // ---- estado CHASE ----
            if (goldens.length) {
                const g = goldens[0];   // primer Golden detectado
                MH.hunt.target = g;
                MH.hunt.lastSeenTick = Date.now();
                if (MH.hunt.state !== 'chase' && MH.hunt.state !== 'kill') {
                    console.log('[MH-HUNT] Golden detectado:', g.n, 'en', g.x, g.y);
                    MH.api.stopWalk?.('hunt-chase', false);
                    MH.hunt.state = 'chase';
                }
                const dist = Math.hypot(g.x - me.x, g.y - me.y);
                if (dist > 3) {
                    if (!MH.api.isWalking()) MH.api.goTo(g.x, g.y);
                } else {
                    MH.hunt.state = 'kill';
                    // hacer hold sobre el golden
                    chrome.storage.local.get(['button', 'repeat']).then((cfg) => {
                        chrome.runtime.sendMessage({
                            target: 'bg', type: 'start',
                            tabId: (async () => (await chrome.tabs.query({ url: '*://*.mu.mormon.garden/*' }))[0]?.id)(),
                            button: cfg.button || 'right',
                            x: window.innerWidth / 2, y: window.innerHeight / 2,
                            repeat: cfg.repeat ?? 300,
                        });
                    });
                }
                return;
            }

            // ---- Golden desapareció ----
            if (MH.hunt.state === 'chase' || MH.hunt.state === 'kill') {
                // si pasó 1 s sin verlo, asumimos muerte
                if (Date.now() - MH.hunt.lastSeenTick < 1000) return;
                const t = MH.hunt.target;
                if (t) {
                    MH.hunt.stats.kills++;
                    MH.hunt.stats.byName[t.n] = (MH.hunt.stats.byName[t.n] || 0) + 1;
                    console.log('[MH-HUNT] Kill confirmado:', t.n, '· total:', MH.hunt.stats.kills);
                    MH.hunt.lastLoot = { x: t.x, y: t.y, n: t.n };
                }
                // soltar hold
                chrome.runtime.sendMessage({ target: 'bg', type: 'stop' }).catch(() => { });
                // ir a recoger el drop
                if (t) {
                    MH.hunt.state = 'loot';
                    MH.api.goTo(t.x, t.y, 1);
                } else {
                    MH.hunt.state = 'sweep';
                }
                MH.hunt.target = null;
                return;
            }

            // ---- estado LOOT ----
            if (MH.hunt.state === 'loot') {
                const loot = MH.hunt.lastLoot;
                if (!loot) { MH.hunt.state = 'sweep'; return; }
                // Espera a que termine cualquier walk en curso
                if (MH.api.isWalking()) return;
                const d = Math.hypot(me.x - loot.x, me.y - loot.y);
                if (d > 1) { MH.api.goTo(loot.x, loot.y, 1); return; }

                // Ya estamos encima (o casi): manda Space para recoger.
                // Algunas veces hay que insistir 2-3 veces para que el drop se levante.
                console.log('[MH-HUNT] recogiendo drop en', loot.x, loot.y);
                (async () => {
                    for (let i = 0; i < 3; i++) {
                        await chrome.runtime.sendMessage({
                            target: 'bg', type: 'keys', seq: ['Space']
                        }).catch(() => { });
                        await new Promise(r => setTimeout(r, 400));
                    }
                    MH.hunt.lastLoot = null;
                    MH.hunt.state = 'sweep';
                })();
                MH.hunt.state = 'loot-pending';   // evita reentrar mientras se mandan los Space
                return;
            }

            // Espera a que se resuelva el loot
            if (MH.hunt.state === 'loot-pending') return;

            // ---- estado SWEEP ----
            if (MH.hunt.state === 'sweep') {
                if (MH.api.isWalking()) return;
                if (MH.hunt.idx >= MH.hunt.points.length) {
                    console.log('[MH-HUNT] sweep terminado');
                    MH.api.stopHunt();
                    return;
                }
                const p = MH.hunt.points[MH.hunt.idx++];
                MH.api.goTo(p.x, p.y);
            }
        } catch (e) {
            console.warn('[MH-HUNT]', e);
        }
    }, 500);
    // Mensajes desde el panel
    chrome.runtime.onMessage.addListener((msg) => {
        if (msg.target !== 'content') return;
        if (msg.type === 'hunt-start') {
            MH.api.startHunt(msg.map, msg.cfg).catch((e) => console.warn('[MH-HUNT] start error:', e));
        }
        if (msg.type === 'hunt-stop') {
            MH.api.stopHunt().catch((e) => console.warn('[MH-HUNT] stop error:', e));
        }
    });
    console.log('[MH] hunt.js cargado');
})();