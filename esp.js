(function () {
    if (window.__mhEspLoaded) return;
    window.__mhEspLoaded = true;

    let canvas = null, ctx = null, animId = null;
    let enabled = false;
    let lastClickable = false;

    // Config local (se sincroniza desde storage)
    const cfg = {
        boxW: 44,
        boxH: 72,
        hostileColor: '#ff3333',
        friendlyColor: '#00ffcc',
        showDistance: true,
        showClan: true,
        showOnlyVisible: true,
        maxDist: 0,          // 0 = sin límite
        names: [],           // lista blanca (vacío = todos)
        showNames: []        // lista negra (vacío = ninguno)
    };

    chrome.storage.local.get(['espCfg'], (c) => {
        if (c.espCfg) Object.assign(cfg, c.espCfg);
        applyCfg();
    });
    chrome.storage.onChanged.addListener((ch, area) => {
        if (area === 'local' && ch.espCfg) {
            Object.assign(cfg, ch.espCfg.newValue || {});
            applyCfg();
        }
        if (area === 'local' && ch.espEnabled) {
            setEnabled(!!ch.espEnabled.newValue);
        }
    });
    chrome.storage.local.get('espEnabled', (c) => setEnabled(!!c.espEnabled));

    function applyCfg() {
        if (!canvas) return;
        canvas.style.zIndex = String(cfg.zIndex ?? 999999);
    }

    function ensureCanvas() {
        if (canvas) return;
        canvas = document.createElement('canvas');
        canvas.id = '__mh_esp_overlay';
        Object.assign(canvas.style, {
            position: 'fixed',
            top: '0',
            left: '0',
            width: '100vw',
            height: '100vh',
            pointerEvents: 'none',
            zIndex: String(cfg.zIndex ?? 999999)
        });
        document.documentElement.appendChild(canvas);
        ctx = canvas.getContext('2d');
    }

    function destroyCanvas() {
        if (animId) cancelAnimationFrame(animId), animId = null;
        if (canvas) canvas.remove(), canvas = null, ctx = null;
        lastClickable = false;
        window.dispatchEvent(new CustomEvent('mh-esp-clickthrough', { detail: JSON.stringify({ clickable: false }) }));
    }

    function setEnabled(v) {
        enabled = !!v;
        if (enabled) { ensureCanvas(); if (!animId) animId = requestAnimationFrame(render); }
        else destroyCanvas();
    }

    // Pide al content (aislado) que actualice pointer-events si cambia
    function setClickable(v) {
        if (v === lastClickable) return;
        lastClickable = v;
        window.dispatchEvent(new CustomEvent('mh-esp-clickthrough', { detail: JSON.stringify({ clickable: v }) }));
    }

    function render() {
        if (!enabled || !canvas) return;
        if (canvas.width !== innerWidth || canvas.height !== innerHeight) {
            canvas.width = innerWidth;
            canvas.height = innerHeight;
        }
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        const store = window.__store;
        if (!store) { animId = requestAnimationFrame(render); return; }

        const pData = store.playerData || {};
        const miX = Number(pData.x ?? pData.posX ?? 0);
        const miY = Number(pData.y ?? pData.posY ?? 0);

        const ents = store.world?.playersQuery?._entities;
        if (!ents) { animId = requestAnimationFrame(render); return; }

        const white = cfg.names.map(n => n.toLowerCase());
        const black = new Set(cfg.showNames.map(n => n.toLowerCase()));

        const clickables = [];

        for (const p of ents) {
            const nombre = p.name || p.playerName || p.nameTag?.name || p.objectNameInWorld;
            if (!nombre) continue;
            const lc = nombre.toLowerCase();
            if (white.length && !white.includes(lc)) continue;
            if (black.has(lc)) continue;

            const screen = p.screenPosition;
            if (!screen || typeof screen.x !== 'number' || typeof screen.y !== 'number') continue;

            let clan = 'Sin Clan';
            if (p.guild?.id && store.guilds) {
                const g = store.guilds.get?.(p.guild.id) || store.guilds[p.guild.id];
                if (g?.name) clan = g.name;
            }

            const px = Number(p.transform?.x ?? p.x ?? 0);
            const py = Number(p.transform?.y ?? p.y ?? 0);
            const dist = Math.round(Math.hypot(px - miX, py - miY));
            if (cfg.maxDist > 0 && dist > cfg.maxDist) continue;

            const hostil = (p.heroState && p.heroState > 3);
            const color = hostil ? cfg.hostileColor : cfg.friendlyColor;

            const x = screen.x, y = screen.y;
            const bw = cfg.boxW, bh = cfg.boxH;
            const bx = x - bw / 2, by = y - bh / 2;

            // caja
            ctx.save();
            ctx.strokeStyle = color;
            ctx.lineWidth = 1.5;
            ctx.strokeRect(bx, by, bw, bh);

            // etiqueta
            const parts = [nombre];
            if (cfg.showClan) parts.push(`[${clan}]`);
            if (cfg.showDistance) parts.push(`(${dist}t)`);
            const texto = parts.join(' ');
            ctx.font = 'bold 11px sans-serif';
            const tw = ctx.measureText(texto).width;
            const tx = x - tw / 2 - 5;
            const ty = by - 20;

            ctx.fillStyle = 'rgba(0,0,0,0.8)';
            ctx.fillRect(tx, ty, tw + 10, 18);
            ctx.strokeStyle = color;
            ctx.strokeRect(tx, ty, tw + 10, 18);
            ctx.fillStyle = '#fff';
            ctx.textAlign = 'center';
            ctx.fillText(texto, x, ty + 13);
            ctx.restore();

            clickables.push({ x: bx, y: by, w: bw, h: bh, nombre, x3: px, y3: py, dist });
        }

        // Guardar info para el content (para clicks / autowalk)
        window.__mhEspHitboxes = clickables;

        animId = requestAnimationFrame(render);
    }

    // Comandos desde content
    window.addEventListener('mh-esp', (ev) => {
        try {
            const m = JSON.parse(ev.detail);
            if (m.type === 'toggle') setEnabled(m.value);
            if (m.type === 'cfg') { Object.assign(cfg, m.value || {}); applyCfg(); }
        } catch (_) { }
    });

    console.log('[MH] ESP cargado');
})();