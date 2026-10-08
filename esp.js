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
        whitelist: [],   // antes: names
        blacklist: [],   // antes: showNames
        watch: ['Fantarta'],   // nombres en rojo (jugadores)
        mobs: true,            // dibujar mobs (netObjsQuery)
        mobDist: 30,           // distancia máx. de mobs (tiles)
    };

    const COLORS = {
        me: { main: '#f0b429', glow: 'rgba(240,180,41,.5)' },
        player: { main: '#3fb950', glow: 'rgba(63,185,80,.4)' },
        watch: { main: '#f85149', glow: 'rgba(248,81,73,.5)' },
        mob: { main: '#a371f7', glow: 'rgba(163,113,247,.3)' },
        golden: { main: '#f0b429', glow: 'rgba(240,180,41,.5)' },
    };

    // ---------- helpers de dibujo (overlay moderno) ----------
    function drawText(c, text, x, y, o = {}) {
        const { color = '#fff', font = '700 12px ui-monospace, Consolas, monospace',
            align = 'left', baseline = 'top',
            outline = 'rgba(0,0,0,.85)', outlineWidth = 3,
            bg = null, padding = 4 } = o;
        c.font = font; c.textAlign = align; c.textBaseline = baseline;
        const w = c.measureText(text).width;
        const lineH = parseInt((font.match(/(\d+)px/) || [])[1] || 12, 10) + 4;
        if (bg) {
            let bx = x, by = y;
            if (align === 'center') bx = x - w / 2 - padding;
            else if (align === 'right') bx = x - w - padding * 2;
            else bx = x - padding;
            if (baseline === 'middle') by = y - lineH / 2;
            else if (baseline === 'bottom') by = y - lineH;
            c.fillStyle = bg;
            c.beginPath();
            if (c.roundRect) c.roundRect(bx, by, w + padding * 2, lineH, 3);
            else c.rect(bx, by, w + padding * 2, lineH);
            c.fill();
        }
        c.lineWidth = outlineWidth; c.strokeStyle = outline; c.lineJoin = 'round';
        c.strokeText(text, x, y);
        c.fillStyle = color; c.fillText(text, x, y);
    }

    function drawCorners(c, x, y, w, h, color, o = {}) {
        const { len = 8, thickness = 2, glow = null } = o;
        c.save();
        if (glow) { c.shadowColor = glow; c.shadowBlur = 6; }
        c.strokeStyle = color; c.lineWidth = thickness; c.lineCap = 'round';
        c.beginPath(); c.moveTo(x, y + len); c.lineTo(x, y); c.lineTo(x + len, y); c.stroke();
        c.beginPath(); c.moveTo(x + w - len, y); c.lineTo(x + w, y); c.lineTo(x + w, y + len); c.stroke();
        c.beginPath(); c.moveTo(x + w, y + h - len); c.lineTo(x + w, y + h); c.lineTo(x + w - len, y + h); c.stroke();
        c.beginPath(); c.moveTo(x + len, y + h); c.lineTo(x, y + h); c.lineTo(x, y + h - len); c.stroke();
        c.restore();
    }

    function drawHpBar(c, x, y, w, h, pct, color) {
        c.fillStyle = 'rgba(0,0,0,.6)'; c.fillRect(x, y, w, h);
        c.fillStyle = color; c.fillRect(x, y, w * Math.max(0, Math.min(1, pct)), h);
        c.strokeStyle = 'rgba(255,255,255,.25)'; c.lineWidth = 1;
        c.strokeRect(x + .5, y + .5, w - 1, h - 1);
    }

    // Proyección mundo -> pantalla con la cámara real de la escena
    function project(wx, wy, wz) {
        const scene = window.__store?.world?.scene;
        const cam = scene?.activeCamera;
        if (!scene || !cam) return null;
        try {
            const t = cam.getViewMatrix(true).multiply(cam.getProjectionMatrix(true));
            const v = t.m;
            const cx = v[0] * wx + v[4] * wy + v[8] * wz + v[12];
            const cy = v[1] * wx + v[5] * wy + v[9] * wz + v[13];
            const cw = v[3] * wx + v[7] * wy + v[11] * wz + v[15];
            if (!cw) return null;
            return {
                x: (cx / cw * 0.5 + 0.5) * innerWidth,
                y: (-cy / cw * 0.5 + 0.5) * innerHeight
            };
        } catch (_) { return null; }
    }

    // Bounding box en pantalla de una entidad (pies + cabeza proyectados)
    function entityBox(entity, heightUnits = 2.2) {
        const t = entity?.transform;
        if (!t?.pos) return null;
        const pos = t.pos, off = t.posOffset || { x: 0, y: 0, z: 0 };
        const px = pos.x + (off.x || 0), py = pos.y + (off.y || 0), pz = pos.z + (off.z || 0);
        const feet = project(px, py, pz);
        const head = project(px, py + heightUnits, pz);
        if (!feet || !head) return null;
        const h = Math.abs(feet.y - head.y);
        if (!(h > 1)) return null;   // cámara de lado / detrás de la cámara
        return {
            cx: (feet.x + head.x) / 2, cy: (feet.y + head.y) / 2,
            w: h * 0.55, h, feet, head, px, py, pz
        };
    }


    function applyCfg() {
        if (!canvas) return;
        canvas.style.zIndex = String(cfg.zIndex ?? 999999);
    }

    // API pública desde la consola de la página (mundo MAIN)
    window.ESP = {
        COLORS, drawText, drawCorners, drawHpBar, project, entityBox,
        get canvas() { return canvas; },
        get ctx() { return ctx; },
        cfg,
        stop() { setEnabled(false); },   // apaga y destruye el overlay
    };

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

        const white = (cfg.whitelist || []).map(n => n.toLowerCase());
        const black = new Set((cfg.blacklist || []).map(n => n.toLowerCase()));

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
            const vigilado = (cfg.watch || []).some(w => lc.includes(String(w).toLowerCase()));
            const color = vigilado ? COLORS.watch.main : (hostil ? cfg.hostileColor : cfg.friendlyColor);

            const x = screen.x, y = screen.y;
            const bw = cfg.boxW, bh = cfg.boxH;
            // screen.y = punto de anclaje (pies); la caja se dibuja por encima
            const bx = x - bw / 2, by = y - bh;

            // caja
            ctx.save();
            if (vigilado) { ctx.shadowColor = COLORS.watch.glow; ctx.shadowBlur = 6; }
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

        drawMe(store);
        drawMobs(store, miX, miY);

        animId = requestAnimationFrame(render);
    }

    // ---------- tú (siempre, en dorado) ----------
    function drawMe(store) {
        if (!store.world?.playersQuery) return;
        const me = [...store.world.playersQuery].find(e => e.netId === store.playerId);
        if (!me) return;
        const box = entityBox(me);
        if (!box) return;
        const col = COLORS.me;
        drawCorners(ctx, box.cx - box.w / 2, box.cy - box.h / 2, box.w, box.h, col.main,
            { len: 8, thickness: 2, glow: col.glow });
        drawText(ctx, 'TÚ', box.cx, box.cy - box.h / 2 - 4, {
            color: col.main, align: 'center', baseline: 'bottom',
            bg: 'rgba(1,4,9,.85)', padding: 4,
            font: '700 11px ui-monospace, monospace',
        });
    }

    // ---------- mobs (cajas proyectadas 3D) ----------
    function drawMobs(store, miX, miY) {
        if (!cfg.mobs) return;
        const q = store.world?.netObjsQuery;
        if (!q) return;
        const me = store.world?.playersQuery
            ? [...store.world.playersQuery].find(e => e.netId === store.playerId)
            : null;
        const mx = me?.transform?.pos?.x ?? miX;
        const mz = me?.transform?.pos?.z ?? miY;
        const maxD = cfg.mobDist ?? 30;

        for (const e of q) {
            if (!e.monsterAnimation || 'dying' in e || e.droppedItem) continue;
            if (e.isPlayer || e.playerIndex != null || e.className?.includes('Player')) continue;
            if (e.isNPC || e.isVendor) continue;
            const box = entityBox(e, 1.6);
            if (!box) continue;
            if (box.cx < -200 || box.cx > innerWidth + 200) continue;

            const pos = e.transform.pos;
            const dist = Math.hypot(pos.x - mx, pos.z - mz);
            if (maxD > 0 && dist > maxD) continue;

            const nombre = e.objectNameInWorld || '?';
            const isGolden = /golden/i.test(nombre);
            const col = isGolden ? COLORS.golden : COLORS.mob;

            drawCorners(ctx, box.cx - box.w / 2, box.cy - box.h / 2, box.w, box.h, col.main,
                { len: 6, thickness: 1, glow: isGolden ? col.glow : null });
            drawText(ctx, `${nombre} · ${Math.round(dist)}t`, box.cx, box.cy - box.h / 2 - 3, {
                color: col.main, align: 'center', baseline: 'bottom',
                bg: 'rgba(1,4,9,.6)', padding: 3,
                font: '600 10px ui-monospace, monospace',
            });
        }
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