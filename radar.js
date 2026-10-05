const $ = (id) => document.getElementById(id);
const watchInput = $('watchlist');
const radarContainer = $('radar-container');
const radarStatus = $('radar-status');
const radarDist = $('radar-dist');
const radarTtl = $('radar-ttl');
const meX = $('me-x');
const meY = $('me-y');
const GAME = '*://*.mu.mormon.garden/*';

chrome.storage.local.get(['watchlist', 'radarMinDist', 'radarTTL', 'radarMeX', 'radarMeY'], (c) => {
    if (c.watchlist) watchInput.value = c.watchlist;
    if (c.radarMinDist != null) radarDist.value = c.radarMinDist;
    if (c.radarTTL != null) radarTtl.value = c.radarTTL;
    if (c.radarMeX != null) meX.value = c.radarMeX;
    if (c.radarMeY != null) meY.value = c.radarMeY;
});
watchInput.oninput = () => chrome.storage.local.set({ watchlist: watchInput.value });
radarDist.oninput = () => chrome.storage.local.set({ radarMinDist: +radarDist.value || 0 });
radarTtl.oninput = () => chrome.storage.local.set({ radarTTL: Math.max(3, +radarTtl.value || 15) });
meX.oninput = () => chrome.storage.local.set({ radarMeX: meX.value === '' ? 226 : +meX.value });
meY.oninput = () => chrome.storage.local.set({ radarMeY: meY.value === '' ? 236 : +meY.value });
$('goto-btn').onclick = () => {
    if (gameTabId == null || $('goto-x').value === '' || $('goto-y').value === '') return;
    chrome.tabs.sendMessage(gameTabId, { target: 'content', type: 'goto', x: +$('goto-x').value, y: +$('goto-y').value }).catch(() => { });
};
let gameTabId = null; // pestaña del juego cacheada

// ---- UBICACIONES GUARDADAS: clic en una entrada = autowalk a esas coords ----
let lastSt = null;               // último estado recibido del juego
let lastSavedMap = null;         // para repintar el aviso "otro mapa" al cambiar de mapa
let savedLocs = [];              // [{ name, x, y, map }]
const savedList = $('saved-list');
chrome.storage.local.get('savedLocs', (c) => {
    savedLocs = Array.isArray(c.savedLocs) ? c.savedLocs : [];
    renderSaved();
});
const persistSaved = () => chrome.storage.local.set({ savedLocs });

function renderSaved() {
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
        go.textContent = l.name + ' · (' + l.x + ', ' + l.y + ')' + (l.map != null ? ' · m' + l.map : '');
        go.title = other ? '⚠️ Guardada en otro mapa (m' + l.map + ') · clic = intentar ir igual' : 'Clic: ir a esta ubicación';
        go.onclick = () => {
            if (gameTabId == null) return;
            chrome.tabs.sendMessage(gameTabId, { target: 'content', type: 'goto', x: l.x, y: l.y }).catch(() => { });
        };
        const del = document.createElement('button');
        del.className = 'del';
        del.textContent = '✕';
        del.title = 'Borrar';
        del.onclick = (e) => {
            e.stopPropagation();
            savedLocs.splice(i, 1);
            persistSaved();
            renderSaved();
        };
        row.append(go, del);
        return row;
    }));
}

function addSaved(name) {
    if (!lastSt?.ok) {
        radarStatus.textContent = 'Sin datos del juego: camina un poco antes de guardar.';
        return;
    }
    const { x, y } = lastSt.me;
    const nm = (name ?? '').trim() || 'Pos (' + x + ', ' + y + ')';
    savedLocs.push({ name: nm, x, y, map: lastSt.map });
    if (savedLocs.length > 100) savedLocs.shift();
    persistSaved();
    renderSaved();
}
$('save-cur').onclick = () => addSaved(null);
$('save-as').onclick = () => {
    const n = prompt('Nombre de la ubicación:', lastSt?.ok ? 'Spot ' + (savedLocs.length + 1) : '');
    if (n !== null) addSaved(n);
};


let lastScan = 0;
let mapId = null, terrain = null;
let heatMap = null, heatImg = null, heatAt = 0, heatSpots = [];
let busy = false;

// Las alertas las dispara content.js (no dependen de que esta ventana esté abierta);
// aquí solo se pinta el estado.
setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
        const ask = async (id) => {
            try { return await chrome.tabs.sendMessage(id, { target: 'content', type: 'getState' }); }
            catch (_) { return null; }
        };

        let st = gameTabId != null ? await ask(gameTabId) : null;
        if (!st?.ok) {
            gameTabId = null;
            if (Date.now() - lastScan > 3000) {
                lastScan = Date.now();
                const tabs = await chrome.tabs.query({ url: '*://*.mu.mormon.garden/*' });
                const res = await Promise.all(tabs.filter((t) => t.id).map(async (t) => ({ id: t.id, s: await ask(t.id) })));
                const best = res.filter((r) => r.s?.ok).sort((a, b) => b.s.lastData - a.s.lastData)[0];
                if (best) { gameTabId = best.id; st = best.s; }
            }
        }

        if (!st?.ok) {
            radarStatus.textContent = 'Abre la pestaña del juego… camina un poco.';
            radarStatus.classList.remove('active');
            radarContainer.innerHTML = '<div class="empty">Sin datos aún.</div>';
            return;
        }

        lastSt = st;
        if (st.map !== lastSavedMap) { lastSavedMap = st.map; renderSaved(); }

        const watch = (watchInput.value || '').split(',').map((n) => n.trim().toLowerCase()).filter(Boolean);
        const minDist = +radarDist.value || 0;
        const ttl = Math.max(3, +radarTtl.value || 15);
        const lista = st.players.sort((a, b) => a.dist - b.dist);
        const meTxt = `pos (${st.me.x}, ${st.me.y}) ${st.me.auto ? 'auto' : 'manual'}`;
        const hits = lista.filter((p) => watch.includes(p.n.toLowerCase()) && p.dist >= minDist);        // Mapa: carga el terreno guardado del mapa actual y dibuja jugadores encima
        if (st.map != null && (st.map !== mapId || !terrain)) {
            mapId = st.map;
            const b64 = (await chrome.storage.local.get('map:' + mapId))['map:' + mapId];
            terrain = null;
            if (b64) {
                const bin = atob(b64);
                const img = new ImageData(256, 256);
                const COL = { 0: [22, 27, 34], 1: [35, 134, 54], 4: [1, 4, 9], 5: [1, 40, 15], 8: [1, 4, 9], 16: [31, 111, 235] };
                for (let i = 0; i < 65536; i++) {
                    const c = COL[bin.charCodeAt(i)] || [110, 64, 201];
                    img.data.set([c[0], c[1], c[2], 255], i * 4);
                }
                terrain = img;
            }
        }
        // Heatmap de mobs (recarga cada 10 s) + spots calientes (bloques de 8x8, los 6 más densos, separados >10 tiles)
        if (st.map != null && (st.map !== heatMap || Date.now() - heatAt > 10000)) {
            heatAt = Date.now();
            const raw = (await chrome.storage.local.get('heat:' + st.map))['heat:' + st.map];
            heatMap = st.map; heatImg = null;
            $('spots').replaceChildren();
            if (raw) {
                const o = JSON.parse(raw), dec = (b) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
                const h = dec(o.h), ix = dec(o.i), img = new ImageData(256, 256);
                const sum = new Float32Array(1024), best = new Int32Array(1024).fill(-1), nm = Array.from({ length: 1024 }, () => ({}));
                for (let c = 0; c < 65536; c++) {
                    if (!h[c]) continue;
                    img.data.set([240, 180, 41, Math.min(255, 70 + h[c] * 12)], c * 4);
                    const bk = (c >> 8 >> 3) * 32 + ((c & 255) >> 3);
                    sum[bk] += h[c];
                    nm[bk][ix[c]] = (nm[bk][ix[c]] || 0) + h[c];
                    if (best[bk] < 0 || h[c] > h[best[bk]]) best[bk] = c; // destino = tile donde más se vio un mob (seguro caminable)
                }
                const spots = [];
                for (const bk of [...sum.keys()].sort((a, b) => sum[b] - sum[a])) {
                    if (sum[bk] < 6 || spots.length >= 6) break;
                    const x = best[bk] & 255, y = best[bk] >> 8;
                    if (spots.some((s) => Math.hypot(s.x - x, s.y - y) < 10)) continue;
                    const top = Object.entries(nm[bk]).sort((a, b) => b[1] - a[1])[0][0];
                    spots.push({ x, y, n: o.n[top] });
                }
                const hc = document.createElement('canvas'); hc.width = hc.height = 256;
                hc.getContext('2d').putImageData(img, 0, 0);
                heatImg = hc; heatSpots = spots;
                $('spots').replaceChildren(...spots.map((s, k) => {
                    const b = document.createElement('button');
                    b.textContent = (k + 1) + ' · ' + s.n + ' (' + s.x + ',' + s.y + ')';
                    b.style.cssText = 'padding:4px 8px;background:#0d1117;color:#f0b429;border:1px solid #30363d;border-radius:4px;font:700 10px ui-monospace,monospace;cursor:pointer';
                    b.onclick = () => { if (gameTabId != null) chrome.tabs.sendMessage(gameTabId, { target: 'content', type: 'goto', x: s.x, y: s.y }).catch(() => { }); };
                    return b;
                }));
            }
        }
        const g = $('map').getContext('2d');
        g.clearRect(0, 0, 256, 256);
        if (terrain) g.putImageData(terrain, 0, 0);
        if (heatImg) g.drawImage(heatImg, 0, 0);
        for (const [, x, y] of st.mobs || []) { g.fillStyle = '#a371f7'; g.fillRect(x - 1, y - 1, 2, 2); }
        heatSpots.forEach((s, k) => { // el canvas está volteado por CSS: el texto se contra-espeja para leerse bien
            g.strokeStyle = '#f0b429'; g.lineWidth = 1; g.beginPath(); g.arc(s.x + .5, s.y + .5, 5, 0, 7); g.stroke();
            g.save(); g.translate(s.x + 7, s.y - 5); g.scale(-1, 1); g.fillStyle = '#f0b429'; g.font = '700 9px monospace'; g.fillText(k + 1, 0, 0); g.restore();
        });
        for (const p of lista) {
            g.fillStyle = watch.includes(p.n.toLowerCase()) ? '#f85149' : '#f0b429';
            g.fillRect(p.x - 1, p.y - 1, 3, 3);
        }
        // Ruta del autowalk: línea punteada desde mi posición hasta el destino (verde)
        if (st.route?.length) {
            const end = st.route[st.route.length - 1];
            g.save();
            g.strokeStyle = '#58a6ff'; g.lineWidth = 1.2; g.setLineDash([3, 2]);
            g.beginPath(); g.moveTo(st.me.x + .5, st.me.y + .5);
            for (const [x, y] of st.route.slice(st.routeIdx)) g.lineTo(x + .5, y + .5);
            g.stroke();
            g.restore();
            g.strokeStyle = '#3fb950'; g.strokeRect(end[0] - 2, end[1] - 2, 5, 5);
        }
        g.strokeStyle = '#58a6ff';
        g.strokeRect(st.me.x - 2, st.me.y - 2, 5, 5);
        radarStatus.textContent = lista.length
            ? `${lista.length} jugador(es) · cercano: ${lista[0].n} (${lista[0].dist}t) · ${meTxt}`
            : `Sin jugadores visibles · ${meTxt}`;
        radarStatus.classList.toggle('active', hits.length > 0);
        if (st.walking) radarStatus.textContent += ' · 🚶 caminando';
        if (st.route?.length) radarStatus.textContent += ' · ruta ' + (st.route.length - st.routeIdx) + 't';
        else if (st.walkMsg) radarStatus.textContent += ' · ' + st.walkMsg;

        if (!lista.length) {
            radarContainer.innerHTML = '<div class="empty">Sin jugadores.</div>';
            return;
        }
        if (st.mobs?.length) radarStatus.textContent += ' · ' + st.mobs.length + ' mobs';

        const table = document.createElement('table');
        table.innerHTML = '<thead><tr><th>Jugador</th><th>Dist</th><th>Coords</th><th>Visto</th><th>Fuente</th></tr></thead>';
        const tbody = document.createElement('tbody');
        for (const p of lista) {
            const tr = document.createElement('tr');
            const classes = [];
            if (watch.includes(p.n.toLowerCase()) && p.dist >= minDist) classes.push('interest');
            if (p.age > ttl * 500) classes.push('stale'); // más de la mitad del TTL sin verse
            tr.className = classes.join(' ');
            tr.style.cursor = 'pointer';
            tr.title = 'Clic: ir · Shift+clic: seguir';
            tr.onclick = (e) => { if (gameTabId != null) chrome.tabs.sendMessage(gameTabId, e.shiftKey ? { target: 'content', type: 'follow', name: p.n } : { target: 'content', type: 'goto', x: p.x, y: p.y }).catch(() => { }); };
            // textContent: los nombres vienen del juego, nunca como HTML
            for (const v of [p.n, p.dist + 't', `(${p.x}, ${p.y})`, Math.round(p.age / 1000) + 's', p.src]) {
                const td = document.createElement('td');
                td.textContent = v;
                tr.appendChild(td);
            }
            tbody.appendChild(tr);
        }
        table.appendChild(tbody);
        radarContainer.replaceChildren(table);

        const sendToGame = (msg) => {
            if (gameTabId == null) return;
            chrome.tabs.sendMessage(gameTabId, { target: 'content', ...msg }).catch(() => { });
        };
        $('map').onclick = (e) => {
            if (gameTabId == null) return;
            const r = e.target.getBoundingClientRect();
            const x = 255 - Math.floor((e.clientX - r.left) * 256 / r.width); // canvas espejado por CSS
            const y = Math.floor((e.clientY - r.top) * 256 / r.height);
            sendToGame({ type: 'goto', x, y });
        };
        $('map').oncontextmenu = (e) => { e.preventDefault(); sendToGame({ type: 'stopwalk' }); };
        $('walk-stop').onclick = () => sendToGame({ type: 'stopwalk' });
        addEventListener('keydown', (e) => { if (e.key === 'Escape') sendToGame({ type: 'stopwalk' }); });

    } catch (e) {
        radarStatus.textContent = 'Error: ' + e.message;
        console.error(e);
    } finally {
        busy = false;
    }
}, 1000);