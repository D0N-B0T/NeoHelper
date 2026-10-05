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
        if (msg.target !== 'content' || msg.type !== 'getState') return;
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
            mobs: MH.api.getMobs()
        });
    });

    console.log('[MH] main.js cargado');
})();