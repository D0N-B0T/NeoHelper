// radar.js
import {
    $, findGameTab, sendToGame,
    decodeTerrain, decodeHeat, drawMap,
    renderPlayersTable, createEventLog,
    loadSavedLocs, saveSavedLocs
} from './ui/shared.js';

(async () => {
    // ---------- carga inicial ----------
    const c = await chrome.storage.local.get([
        'watchlist', 'radarMinDist', 'radarTTL', 'radarMeX', 'radarMeY'
    ]);
    if (c.watchlist) $('watchlist').value = c.watchlist;
    if (c.radarMinDist != null) $('radar-dist').value = c.radarMinDist;
    if (c.radarTTL != null) $('radar-ttl').value = c.radarTTL;
    if (c.radarMeX != null) $('me-x').value = c.radarMeX;
    if (c.radarMeY != null) $('me-y').value = c.radarMeY;

    // ---------- persistencia ----------
    $('watchlist').oninput = () => chrome.storage.local.set({ watchlist: $('watchlist').value });
    $('radar-dist').oninput = () => chrome.storage.local.set({ radarMinDist: +$('radar-dist').value || 0 });
    $('radar-ttl').oninput = () => chrome.storage.local.set({ radarTTL: Math.max(3, +$('radar-ttl').value || 15) });
    $('me-x').oninput = () => chrome.storage.local.set({ radarMeX: $('me-x').value === '' ? 226 : +$('me-x').value });
    $('me-y').oninput = () => chrome.storage.local.set({ radarMeY: $('me-y').value === '' ? 236 : +$('me-y').value });

    // ---------- ubicaciones guardadas ----------
    let lastSt = null;
    let savedLocs = await loadSavedLocs();
    const savedList = $('saved-list');

    const renderSaved = () => {
        if (!savedLocs.length) {
            const d = document.createElement('div');
            d.className = 'empty';
            d.textContent = 'Sin ubicaciones guardadas.';
            savedList.replaceChildren(d);
            return;
        }
        savedList.replaceChildren(...savedLocs.map((l, i) => {
            const row = document.createElement('div');
            row.className = 'loc';

            const go = document.createElement('button');
            go.className = 'go';
            const other = lastSt?.ok && lastSt.map != null && l.map != null && l.map !== lastSt.map;
            if (other) go.classList.add('other');
            go.textContent = `${l.name} · (${l.x}, ${l.y})` + (l.map != null ? ' · m' + l.map : '');
            go.title = other ? '⚠️ Otro mapa (m' + l.map + ')' : 'Clic: ir';
            go.onclick = () => sendToGame({ type: 'goto', x: l.x, y: l.y });

            const del = document.createElement('button');
            del.className = 'del';
            del.textContent = '✕';
            del.title = 'Borrar';
            del.onclick = (e) => {
                e.stopPropagation();
                savedLocs.splice(i, 1);
                saveSavedLocs(savedLocs);
                renderSaved();
            };

            row.append(go, del);
            return row;
        }));
    };
    renderSaved();

    const addSaved = (name) => {
        if (!lastSt?.ok) { $('radar-status').textContent = 'Sin datos del juego.'; return; }
        const { x, y } = lastSt.me;
        const nm = (name ?? '').trim() || `Pos (${x}, ${y})`;
        savedLocs.push({ name: nm, x, y, map: lastSt.map });
        if (savedLocs.length > 100) savedLocs.shift();
        saveSavedLocs(savedLocs);
        renderSaved();
    };
    $('save-cur').onclick = () => addSaved(null);
    $('save-as').onclick = () => {
        const n = prompt('Nombre de la ubicación:', lastSt?.ok ? 'Spot ' + (savedLocs.length + 1) : '');
        if (n !== null) addSaved(n);
    };

    $('goto-btn').onclick = () => {
        if ($('goto-x').value === '' || $('goto-y').value === '') return;
        sendToGame({ type: 'goto', x: +$('goto-x').value, y: +$('goto-y').value });
    };
    $('walk-stop').onclick = () => sendToGame({ type: 'stopwalk' });
    addEventListener('keydown', (e) => { if (e.key === 'Escape') sendToGame({ type: 'stopwalk' }); });

    // ---------- loop ----------
    let mapId = null, terrain = null;
    let heatMap = null, heatImg = null, heatAt = 0, heatSpots = [];
    let busy = false, prevMapSeen = null;

    // ---------- zoom ----------
    // La vista dibuja solo la ventana [cx±v/2, cy±v/2] del mapa, donde v = 256/zoom.
    // El canvas sigue midiendo 256x256, así que drawMap() no cambia.
    const ZOOMS = [1, 1.5, 2, 3, 4, 6];
    let zoomIdx = 0;                         // 0 = 1x (mapa completo)
    let view = { x: 128, y: 128 };           // centro de la ventana (tiles)
    let viewBound = false;                   // false = sigue al jugador automáticamente

    const clampView = () => {
        const half = 128 / ZOOMS[zoomIdx];
        view.x = Math.max(half, Math.min(256 - half, view.x));
        view.y = Math.max(half, Math.min(256 - half, view.y));
    };
    const setZoom = (idx, center) => {
        zoomIdx = Math.max(0, Math.min(ZOOMS.length - 1, idx));
        if (center) { view.x = center.x; view.y = center.y; viewBound = false; }
        clampView();
        updateZoomUi();
    };
    const focusOnMe = () => {
        if (!lastSt?.ok) return;
        view.x = lastSt.me.x; view.y = lastSt.me.y;
        viewBound = false;
        clampView();
        updateZoomUi();
    };
    const updateZoomUi = () => {
        const z = ZOOMS[zoomIdx];
        const t = $('zoom-lbl');
        if (t) t.textContent = (z === 1 ? '1×' : z + '×') + (z === 1 ? ' · mapa completo' : (viewBound ? ' · auto' : ''));
    };

    $('zoom-in').onclick = () => setZoom(zoomIdx + 1, lastSt?.ok ? lastSt.me : null);
    $('zoom-out').onclick = () => {
        if (zoomIdx === 0) return;
        setZoom(zoomIdx - 1);
        if (zoomIdx === 0) viewBound = false;
        updateZoomUi();
    };
    $('zoom-reset').onclick = () => { zoomIdx = 0; view = { x: 128, y: 128 }; viewBound = false; updateZoomUi(); };
    $('zoom-me').onclick = focusOnMe;

    // Clic: convierte pantalla → tile con la misma matemática que el render.
    $('map').onclick = (e) => {
        const r = e.target.getBoundingClientRect();
        const v = 256 / ZOOMS[zoomIdx];
        // el canvas está espejado en X (radar.css: transform: scaleX(-1)),
        // así que la X de pantalla se invierte para volver a coords de tile
        const sx = 1 - (e.clientX - r.left) / r.width;
        const sy = (e.clientY - r.top) / r.height;
        const x = view.x - v / 2 + sx * v;
        const y = view.y - v / 2 + sy * v;
        sendToGame({ type: 'goto', x: Math.max(0, Math.min(255, Math.round(x))), y: Math.max(0, Math.min(255, Math.round(y))) });
    };
    $('map').oncontextmenu = (e) => { e.preventDefault(); sendToGame({ type: 'stopwalk' }); };
    // Rueda = zoom, centrado en el cursor.
    $('map').addEventListener('wheel', (e) => {
        e.preventDefault();
        const r = e.target.getBoundingClientRect();
        const v0 = 256 / ZOOMS[zoomIdx];
        const sx = 1 - (e.clientX - r.left) / r.width;
        const sy = (e.clientY - r.top) / r.height;
        const wx = view.x - v0 / 2 + sx * v0;
        const wy = view.y - v0 / 2 + sy * v0;
        const next = Math.max(0, Math.min(ZOOMS.length - 1, zoomIdx + (e.deltaY < 0 ? 1 : -1)));
        if (next === zoomIdx) return;
        const v1 = 256 / ZOOMS[next];
        view.x = wx + (0.5 - sx) * v1;
        view.y = wy + (0.5 - sy) * v1;
        zoomIdx = next;
        clampView();
        viewBound = false;
        updateZoomUi();
    }, { passive: false });
    // Arrastrar con el botón central = pan; doble clic = centrar en el jugador.
    let dragging = null;
    $('map').addEventListener('mousedown', (e) => {
        if (e.button !== 1) return;
        e.preventDefault();
        dragging = { px: e.clientX, py: e.clientY, vx: view.x, vy: view.y };
    });
    addEventListener('mousemove', (e) => {
        if (!dragging) return;
        const r = $('map').getBoundingClientRect();
        const v = 256 / ZOOMS[zoomIdx];
        view.x = dragging.vx + (e.clientX - dragging.px) / r.width * v;
        view.y = dragging.vy - (e.clientY - dragging.py) / r.height * v;
        clampView();
        updateZoomUi();
    });
    addEventListener('mouseup', () => { dragging = null; });
    $('map').addEventListener('dblclick', focusOnMe);
    updateZoomUi();

    setInterval(async () => {
        if (busy) return;
        busy = true;
        try {
            const found = await findGameTab();
            const st = found?.st;

            if (!st?.ok) {
                $('radar-status').textContent = 'Abre la pestaña del juego… camina un poco.';
                $('radar-status').classList.remove('active');
                $('radar-container').innerHTML = '<div class="empty">Sin datos aún.</div>';
                return;
            }

            lastSt = st;
            if (st.map !== prevMapSeen) { prevMapSeen = st.map; renderSaved(); }

            const watch = ($('watchlist').value || '').split(',').map(n => n.trim().toLowerCase()).filter(Boolean);
            const minDist = +$('radar-dist').value || 0;
            const ttl = Math.max(3, +$('radar-ttl').value || 15);
            const lista = st.players.sort((a, b) => a.dist - b.dist);
            const hits = lista.filter((p) => watch.includes(p.n.toLowerCase()) && p.dist >= minDist);

            if (st.map != null && (st.map !== mapId || !terrain)) {
                mapId = st.map;
                const b64 = (await chrome.storage.local.get('map:' + mapId))['map:' + mapId];
                terrain = decodeTerrain(b64);
            }

            if (st.map != null && (st.map !== heatMap || Date.now() - heatAt > 10000)) {
                heatAt = Date.now();
                const raw = (await chrome.storage.local.get('heat:' + st.map))['heat:' + st.map];
                heatMap = st.map;
                const decoded = decodeHeat(raw);
                heatImg = decoded.img;
                heatSpots = decoded.spots;
                const spotsEl = $('spots');
                spotsEl.replaceChildren(...heatSpots.map((s, k) => {
                    const b = document.createElement('button');
                    b.textContent = `${k + 1} · ${s.n} (${s.x},${s.y})`;
                    b.style.cssText = 'padding:4px 8px;background:#0d1117;color:#f0b429;border:1px solid #30363d;border-radius:4px;font:700 10px ui-monospace,monospace;cursor:pointer';
                    b.onclick = () => sendToGame({ type: 'goto', x: s.x, y: s.y });
                    return b;
                }));
            }

            // Si el zoom es 1x, dibuja igual que antes (sin transform, evita difuminado).
            if (ZOOMS[zoomIdx] === 1) {
                drawMap($('map'), {
                    terrain, heatImg,
                    mobs: st.mobs, players: lista, watch,
                    route: st.route, routeIdx: st.routeIdx,
                    me: st.me, heatSpots
                });
            } else {
                // En zoom, sigue al jugador salvo que hayas paneado manualmente.
                if (!viewBound) { view.x = st.me.x; view.y = st.me.y; }
                clampView();
                const v = 256 / ZOOMS[zoomIdx];
                const g = $('map').getContext('2d');
                g.setTransform(1, 0, 0, 1, 0, 0);
                g.clearRect(0, 0, 256, 256);
                g.translate(128, 128);
                g.scale(256 / v, 256 / v);
                g.translate(-view.x, -view.y);
                drawMap($('map'), {
                    terrain, heatImg,
                    mobs: st.mobs, players: lista, watch,
                    route: st.route, routeIdx: st.routeIdx,
                    me: st.me, heatSpots
                });
                g.setTransform(1, 0, 0, 1, 0, 0);
            }

            const meTxt = `pos (${st.me.x}, ${st.me.y}) ${st.me.auto ? 'auto' : 'manual'}`;
            $('radar-status').textContent = lista.length
                ? `${lista.length} jugador(es) · cercano: ${lista[0].n} (${lista[0].dist}t) · ${meTxt}`
                : `Sin jugadores visibles · ${meTxt}`;
            $('radar-status').classList.toggle('active', hits.length > 0);
            if (st.walking) $('radar-status').textContent += ' · 🚶 caminando';
            if (st.route?.length) $('radar-status').textContent += ` · ruta ${st.route.length - st.routeIdx}t`;
            else if (st.walkMsg) $('radar-status').textContent += ' · ' + st.walkMsg;
            if (st.mobs?.length) $('radar-status').textContent += ' · ' + st.mobs.length + ' mobs';

            renderPlayersTable($('radar-container'), lista, {
                watch, minDist, ttl, extraCols: true,
                onGo: (x, y) => sendToGame({ type: 'goto', x, y }),
                onFollow: (n) => sendToGame({ type: 'follow', name: n })
            });
        } catch (e) {
            $('radar-status').textContent = 'Error: ' + e.message;
            console.error(e);
        } finally {
            busy = false;
        }
    }, 1000);
})();