// content/mobs.js
// Lista viva de mobs + heatmap por mapa (persistido en chrome.storage.local).
// Expone: MH.api.getMobs()
// Consume: nada

(() => {
    const MH = window.__MH;
    if (!MH) { console.error('[MH] _bus.js no cargado'); return; }

    const mobs = new Map();
    const heat = {
        map: null,
        h: new Uint8Array(65536),
        i: new Uint8Array(65536),
        names: [],
        dirty: false,
        loading: false,
        saved: 0
    };

    const enc = (u) => {
        let s = '';
        for (let j = 0; j < u.length; j += 8192) {
            s += String.fromCharCode.apply(null, u.subarray(j, j + 8192));
        }
        return btoa(s);
    };
    const dec = (b) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
    const dump = () => JSON.stringify({ n: heat.names, h: enc(heat.h), i: enc(heat.i) });

    window.addEventListener('mh-mobs', async (ev) => {
        try {
            const d = JSON.parse(ev.detail), now = Date.now();

            // cambio de mapa: guarda el heat actual y carga el del nuevo
            if (heat.map !== d.map) {
                if (heat.loading) return;
                heat.loading = true;
                try {
                    if (heat.map != null && heat.dirty) {
                        await chrome.storage.local.set({ ['heat:' + heat.map]: dump() });
                    }
                    const raw = (await chrome.storage.local.get('heat:' + d.map))['heat:' + d.map];
                    const o = raw ? JSON.parse(raw) : null;
                    heat.h = o ? dec(o.h) : new Uint8Array(65536);
                    heat.i = o ? dec(o.i) : new Uint8Array(65536);
                    heat.names = o ? o.n : [];
                    heat.map = d.map;
                    heat.dirty = false;
                    heat.saved = now;
                    mobs.clear();
                } finally {
                    heat.loading = false;
                }
            }

            // actualiza lista viva y heatmap
            const prev = new Map(mobs);
            mobs.clear();
            for (const [id, n, x, y] of d.list) {
                mobs.set(id, [n, x, y]);
                const pv = prev.get(id);
                // solo cuenta si cambió de tile (evita inflar por frames quietos)
                if ((pv && pv[1] === x && pv[2] === y) || x < 0 || y < 0 || x > 255 || y > 255) continue;
                let ni = heat.names.indexOf(n);
                if (ni < 0) ni = heat.names.push(n) - 1;
                if (ni > 254) continue;
                const c = y * 256 + x;
                if (heat.h[c] < 255) heat.h[c]++;
                heat.i[c] = ni;
                heat.dirty = true;
            }

            // autosave cada 20 s si hubo cambios
            if (heat.dirty && now - heat.saved > 20000) {
                heat.saved = now;
                heat.dirty = false;
                chrome.storage.local.set({ ['heat:' + heat.map]: dump() });
            }
        } catch (_) { }
    });

    // API pública
    MH.api.getMobs = () => [...mobs.values()];

    console.log('[MH] mobs.js cargado');
})();