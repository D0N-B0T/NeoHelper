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
        showDistance: true,
        showClan: true,
        showBadges: true,
        showMe: true,
        showMobs: true,
        showGolden: true,
        glow: true,
        maxDist: 0,          // 0 = sin límite
        whitelist: [],       // solo estos nombres
        blacklist: [],       // ocultar estos nombres
        watch: [],           // nombres en lista de vigilancia (alerta / escape)
        admins: ['aslar'],   // nombres de Administradores / GMs
        showOverlay: true,   // dibujar overlay en pantalla (ON/OFF)
        autoEscape: false,   // escapar a Lorencia al detectar peligro/admin (ON/OFF)
        mobs: true,          // master mobs
        mobDist: 30,         // distancia máx. de mobs (tiles)
        colors: {},          // overrides de colores por relación
        shapes: {},          // overrides de formas por relación
    };

    const DEFAULT_COLORS = {
        admin: '#ff2d95',
        watch: '#f85149',
        hostile: '#ff3333',
        ally: '#3fb950',
        neutral: '#58a6ff',
        me: '#f0b429',
        mob: '#a371f7',
        golden: '#f0b429',
    };

    const DEFAULT_SHAPES = {
        admin: 'dashed',
        watch: 'cross',
        hostile: 'double',
        ally: 'box_corners',
        neutral: 'corners',
        me: 'corners',
        mob: 'corners',
        golden: 'corners',
    };

    const BOX_STYLE = { len: 8, thickness: 2 };
    const LABEL_FONT = '700 11px ui-monospace, monospace';
    const GAP = 4;   // separación caja <-> etiqueta

    function hexToRgba(hex, a = 0.5) {
        if (!hex || typeof hex !== 'string') return `rgba(88,166,255,${a})`;
        let h = hex.replace('#', '');
        if (h.length === 3) h = h.split('').map(c => c + c).join('');
        const num = parseInt(h, 16);
        return `rgba(${(num >> 16) & 255},${(num >> 8) & 255},${num & 255},${a})`;
    }

    function getStyle(key) {
        const hex = cfg.colors?.[key] || DEFAULT_COLORS[key] || '#58a6ff';
        const shape = cfg.shapes?.[key] || DEFAULT_SHAPES[key] || 'corners';
        return {
            main: hex,
            glow: cfg.glow !== false ? hexToRgba(hex, 0.45) : null,
            shape
        };
    }

    // ---------- relación de una entidad conmigo ----------
    // prioridad: admin > peligroso (lista) > hostil/PK > mismo clan > neutral > yo
    const sameClan = (a, b) => {
        const ga = a?.guild?.id, gb = b?.guild?.id;
        if (ga == null || gb == null) return false;
        return String(ga) === String(gb);
    };

    const classify = (e, me, lc) => {
        const adminList = (cfg.admins || ['aslar']).map(a => String(a).toLowerCase().trim()).filter(Boolean);
        const isAdmin = e?.isAdmin || e?.gm || e?.admin || e?.isGM ||
            adminList.includes(lc) ||
            /^\[(?:gm|adm|admin)\]/i.test(lc);
        if (isAdmin) return { key: 'admin', label: 'ADMIN' };
        const watched = (cfg.watch || []).some(w => w && lc.includes(String(w).toLowerCase().trim()));
        if (watched) return { key: 'watch', label: 'PELIGRO' };
        if (e?.heroState && e.heroState > 3) return { key: 'hostile', label: 'PK' };
        if (me && sameClan(e, me)) return { key: 'ally', label: 'CLAN' };
        return { key: 'neutral', label: '' };
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
    // Marco configurable: esquinas, cuadro simple, cuadro+esquinas, doble, cruz, punteado o sin caja
    function drawShape(c, x, y, w, h, shape, col) {
        if (shape === 'none') return;
        c.save();
        if (col.glow) { c.shadowColor = col.glow; c.shadowBlur = 6; }
        c.strokeStyle = col.main; c.lineJoin = 'miter';

        if (shape === 'box_corners') {              // cuadro fino + esquinas
            c.lineWidth = 1.5; c.strokeRect(x, y, w, h);
            drawCorners(c, x - 2, y - 2, w + 4, h + 4, col.main, { len: 7, thickness: 2 });
        } else if (shape === 'double') {            // doble cuadro
            c.lineWidth = 2; c.strokeRect(x, y, w, h);
            c.lineWidth = 1; c.strokeRect(x - 4, y - 4, w + 8, h + 8);
        } else if (shape === 'cross') {             // cuadro grueso + diagonales
            c.lineWidth = 2.5; c.strokeRect(x, y, w, h);
            c.lineWidth = 1; c.beginPath();
            c.moveTo(x, y); c.lineTo(x + w, y + h);
            c.moveTo(x + w, y); c.lineTo(x, y + h); c.stroke();
        } else if (shape === 'dashed') {            // cuadro punteado grueso
            c.lineWidth = 2.5; c.setLineDash([6, 4]); c.strokeRect(x - 2, y - 2, w + 4, h + 4);
        } else if (shape === 'box') {               // cuadro simple
            c.lineWidth = 2; c.strokeRect(x, y, w, h);
        } else {                                    // 'corners' (esquinas) por defecto
            drawCorners(c, x, y, w, h, col.main, { len: BOX_STYLE.len, thickness: BOX_STYLE.thickness });
        }
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
        DEFAULT_COLORS, DEFAULT_SHAPES,
        drawText, drawCorners, drawShape, drawFrame: drawShape, drawHpBar, project, entityBox, getStyle,
        get canvas() { return canvas; },
        get ctx() { return ctx; },
        cfg,
        setColors(newColors) { Object.assign(cfg.colors, newColors); },
        setShapes(newShapes) { Object.assign(cfg.shapes, newShapes); },
        toggleOverlay(v) {
            cfg.showOverlay = v !== undefined ? !!v : !cfg.showOverlay;
            return cfg.showOverlay;
        },
        toggleAutoEscape(v) {
            cfg.autoEscape = v !== undefined ? !!v : !cfg.autoEscape;
            return cfg.autoEscape;
        },
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

    let lastEscapeTrigger = 0;
    function triggerEscape(name, reason, mapId) {
        if (mapId === 0) return; // Si ya estamos en Lorencia, nunca escapar
        const now = Date.now();
        if (now - lastEscapeTrigger < 10000) return;
        lastEscapeTrigger = now;
        window.dispatchEvent(new CustomEvent('mh-escape-lorencia', {
            detail: JSON.stringify({ name, reason, mapId })
        }));
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

        // mi entidad: se usa para el color de "mismo clan" y para no dibujarla dos veces
        const meEnt = store.world?.playersQuery
            ? [...store.world.playersQuery].find(e => e.netId === store.playerId)
            : null;

        const white = (cfg.whitelist || []).map(n => n.toLowerCase());
        const black = new Set((cfg.blacklist || []).map(n => n.toLowerCase()));

        const clickables = [];

        for (const p of ents) {
            const nombre = p.name || p.playerName || p.nameTag?.name || p.objectNameInWorld;
            if (!nombre) continue;
            const lc = nombre.toLowerCase();
            if (white.length && !white.includes(lc)) continue;
            if (black.has(lc)) continue;
            if (p.netId === store.playerId) continue;   // yo lo dibuja drawMe (una sola vez)

            const box = entityBox(p);
            let sx, bx, by, bw, bh;
            if (box) { bw = box.w; bh = box.h; bx = box.cx - bw / 2; by = box.cy - bh / 2; sx = box.cx; }
            else {
                const s = p.screenPosition;
                if (!s || typeof s.x !== 'number' || typeof s.y !== 'number') continue;
                bw = cfg.boxW; bh = cfg.boxH; sx = s.x; bx = sx - bw / 2; by = s.y - bh;
            }

            let clan = 'Sin Clan';
            if (p.guild?.id && store.guilds) {
                const g = store.guilds.get?.(p.guild.id) || store.guilds[p.guild.id];
                if (g?.name) clan = g.name;
            }

            const px = Number(p.transform?.x ?? p.x ?? 0);
            const py = Number(p.transform?.y ?? p.y ?? 0);
            const dist = Math.round(Math.hypot(px - miX, py - miY));
            if (cfg.maxDist > 0 && dist > cfg.maxDist) continue;

            const rel = classify(p, meEnt, lc);
            const style = getStyle(rel.key);
            const curMap = Number(store.world?.mapIndex);

            // Auto-escapar a Lorencia SOLO si:
            // 1) autoEscape está activo (ON)
            // 2) El jugador está en la lista de nombres peligrosos (watch)
            // 3) NO estamos ya en Lorencia (mapa distinto de 0)
            if (cfg.autoEscape && rel.key === 'watch' && curMap !== 0) {
                triggerEscape(nombre, 'PELIGRO', curMap);
            }

            if (cfg.showOverlay !== false) {
                drawShape(ctx, bx, by, bw, bh, style.shape, style);

                // etiqueta sobre la cabeza: mismo font/bg/posición para todos
                const parts = [nombre];
                if (cfg.showClan !== false) parts.push(`[${clan}]`);
                if (cfg.showDistance !== false) parts.push(`(${dist}t)`);
                const texto = parts.join(' ');
                drawText(ctx, texto, sx, by - GAP, {
                    color: style.main, align: 'center', baseline: 'bottom',
                    bg: 'rgba(1,4,9,.85)', padding: 4, font: LABEL_FONT,
                });

                // marca de relación (PK / CLAN / PELIGRO / ADMIN) a la izquierda del nombre
                if (cfg.showBadges !== false && rel.label) {
                    drawText(ctx, rel.label, sx - bw / 2 - GAP, by - GAP, {
                        color: style.main, align: 'right', baseline: 'bottom',
                        bg: 'rgba(1,4,9,.85)', padding: 3, font: LABEL_FONT,
                    });
                }
            }

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
        if (cfg.showMe === false || cfg.showOverlay === false) return;
        if (!store.world?.playersQuery) return;
        const me = [...store.world.playersQuery].find(e => e.netId === store.playerId);
        if (!me) return;
        const box = entityBox(me);
        if (!box) return;
        const style = getStyle('me');
        drawShape(ctx, box.cx - box.w / 2, box.cy - box.h / 2, box.w, box.h, style.shape, style);
        drawText(ctx, meLabel(store, me), box.cx, box.cy - box.h / 2 - GAP, {
            color: style.main, align: 'center', baseline: 'bottom',
            bg: 'rgba(1,4,9,.85)', padding: 4, font: LABEL_FONT,
        });
    }

    // Etiqueta de mi personaje: "NOMBRE [Clan]" (sin distancia)
    function meLabel(store, me) {
        const nombre = me?.name || me?.playerName || me?.nameTag?.name || me?.objectNameInWorld || 'TÚ';
        const parts = [nombre];
        if (cfg.showClan !== false) {
            let clan = null;
            if (me?.guild?.id && store?.guilds) {
                const g = store.guilds.get?.(me.guild.id) || store.guilds[me.guild.id];
                if (g?.name) clan = g.name;
            }
            parts.push(`[${clan || 'Sin Clan'}]`);
        }
        return parts.join(' ');
    }

    // ---------- mobs (cajas proyectadas 3D) ----------
    function drawMobs(store, miX, miY) {
        if (cfg.showOverlay === false) return;
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

            const nombre = e.objectNameInWorld || '?';
            const isGolden = /golden/i.test(nombre);

            if (isGolden && cfg.showGolden === false) continue;
            if (!isGolden && (cfg.mobs === false || cfg.showMobs === false)) continue;

            const box = entityBox(e, 1.6);
            if (!box) continue;
            if (box.cx < -200 || box.cx > innerWidth + 200) continue;

            const pos = e.transform.pos;
            const dist = Math.hypot(pos.x - mx, pos.z - mz);
            if (maxD > 0 && dist > maxD) continue;

            const style = getStyle(isGolden ? 'golden' : 'mob');

            drawShape(ctx, box.cx - box.w / 2, box.cy - box.h / 2, box.w, box.h, style.shape, style);
            const mobLabel = cfg.showDistance !== false ? `${nombre} · ${Math.round(dist)}t` : nombre;
            drawText(ctx, mobLabel, box.cx, box.cy - box.h / 2 - GAP, {
                color: style.main, align: 'center', baseline: 'bottom',
                bg: 'rgba(1,4,9,.85)', padding: 4, font: LABEL_FONT,
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