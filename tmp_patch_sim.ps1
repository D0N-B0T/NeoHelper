$path = 'content/main.js'
$lines = [System.IO.File]::ReadAllLines($path)

# Reemplaza las lineas 261..308 (1-based) = indice 260..307
$start = 260
$end = 307

$new = @'
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

        console.log('[MH-SIM] filas del barrido:', legs.length, '· puntos:', expanded.length);

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
            await new Promise(r => setTimeout(r, 1000));

            const ws = MH.api.getWalkState?.() || {};
            const isStuck = /atascado|sin ruta|no hay punto caminable/.test(ws.msg || '');
            if (isStuck) {
                let me0 = MH.api.getMe();
                let alt = me0 ? nearWalkableToward(me0.x, me0.y, endOfLeg.x, endOfLeg.y) : null;
                if (alt) {
                    SIM.phase = 'reconnoitering';
                    console.log('[MH-SIM] atasco (' + ws.msg + ') -> reconocimiento hacia (' + alt.x + ', ' + alt.y + ') rumbo al final de pierna (' + endOfLeg.x + ', ' + endOfLeg.y + ')');
                    for (let k = 0; k < 3 && SIM.enabled; k++) {
                        await moveTo(alt.x, alt.y);
                        await new Promise(r => setTimeout(r, 1200));
                        const w2 = MH.api.getWalkState?.() || {};
                        if (!/atascado|sin ruta/.test(w2.msg || '')) break;
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
                    await new Promise(r => setTimeout(r, 3000));
                    await MH.api.unholdMouse?.();
                }
            }
            await new Promise(r => setTimeout(r, 500));
        }

        console.log('[MH-SIM] scan completo del mapa', mapId);
        SIM.scanPoint = null;
        SIM.scanTarget = null;
        SIM.scanLeg = null;
        SIM.phase = 'idle';
    };
'@ -split "`r?`n"

$out = @()
$out += $lines[0..($start - 1)]
$out += $new
$out += $lines[($end + 1)..($lines.Length - 1)]

[System.IO.File]::WriteAllLines((Resolve-Path $path), $out)
Write-Output ('lineas antes: ' + $lines.Length + ' despues: ' + $out.Length)
