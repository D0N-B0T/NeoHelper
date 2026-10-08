// ui/shared.js
// Lógica común entre popup.js (side panel) y radar.js (ventana flotante).
// Se importa con: <script type="module" src="..."></script>

export const GAME_URL = '*://*.mu.mormon.garden/*';
export const $ = (id) => document.getElementById(id);

// ---------- búsqueda de pestaña del juego ----------
let gameTabId = null;
let lastScan = 0;

export async function askTab(id) {
    try {
        return await chrome.tabs.sendMessage(id, { target: 'content', type: 'getState' });
    } catch (_) {
        return null;
    }
}

export async function findGameTab() {
    let st = gameTabId != null ? await askTab(gameTabId) : null;
    if (st?.ok) return { id: gameTabId, st };

    gameTabId = null;
    if (Date.now() - lastScan < 3000) return null;
    lastScan = Date.now();

    const tabs = await chrome.tabs.query({ url: GAME_URL });
    const res = await Promise.all(
        tabs.filter((t) => t.id).map(async (t) => ({ id: t.id, s: await askTab(t.id) }))
    );
    const best = res.filter((r) => r.s?.ok).sort((a, b) => b.s.lastData - a.s.lastData)[0];
    if (best) {
        gameTabId = best.id;
        return { id: best.id, st: best.s };
    }
    return null;
}

export function sendToGame(msg) {
    if (gameTabId == null) return;
    chrome.tabs.sendMessage(gameTabId, { target: 'content', ...msg }).catch(() => { });
}

// ---------- decodificación de terreno ----------
const COL = {
    0: [22, 27, 34],
    1: [35, 134, 54],
    4: [1, 4, 9],
    5: [1, 40, 15],
    8: [1, 4, 9],
    16: [31, 111, 235]
};

export function decodeTerrain(b64) {
    if (!b64) return null;
    const bin = atob(b64);
    const img = new ImageData(256, 256);
    for (let i = 0; i < 65536; i++) {
        const k = COL[bin.charCodeAt(i)] || [110, 64, 201];
        img.data.set([k[0], k[1], k[2], 255], i * 4);
    }
    return img;
}

// ---------- decodificación de heatmap + spots ----------
export function decodeHeat(raw, mode = 'completo') {   // mode: completo | tenue | nucleos
    if (!raw) return { img: null, spots: [], names: [] };
    const o = JSON.parse(raw);
    const dec = (b) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
    const h = dec(o.h), ix = dec(o.i);
    const img = new ImageData(256, 256);
    const sum = new Float32Array(1024);
    const best = new Int32Array(1024).fill(-1);
    const nm = Array.from({ length: 1024 }, () => ({}));

    // "nucleos": pinta solo el 30% más caliente de las celdas con datos
    // (en pasillos saturados separa lo realmente bueno). No afecta a los spots.
    let thr = 0;
    if (mode === 'nucleos') {
        const vals = [];
        for (let k = 0; k < 65536; k++) if (h[k]) vals.push(h[k]);
        vals.sort((a, b) => a - b);
        thr = vals[Math.floor(vals.length * 0.7)] || 0;
    }

    for (let k = 0; k < 65536; k++) {
        if (!h[k]) continue;
        if (h[k] >= thr) {
            const al = mode === 'tenue' ? Math.min(110, 20 + h[k] * 5)
                : mode === 'nucleos' ? Math.min(255, 90 + h[k] * 10)
                    : Math.min(255, 70 + h[k] * 12);
            img.data.set([240, 180, 41, al], k * 4);
        }
        const bk = ((k >> 8) >> 3) * 32 + ((k & 255) >> 3);
        sum[bk] += h[k];
        nm[bk][ix[k]] = (nm[bk][ix[k]] || 0) + h[k];
        if (best[bk] < 0 || h[k] > h[best[bk]]) best[bk] = k;
    }

    const spots = [];
    for (const bk of [...sum.keys()].sort((a, b) => sum[b] - sum[a])) {
        if (sum[bk] < 6 || spots.length >= 6) break;
        const x = best[bk] & 255, y = best[bk] >> 8;
        if (spots.some((s) => Math.hypot(s.x - x, s.y - y) < 10)) continue;
        const top = Object.entries(nm[bk]).sort((a, b) => b[1] - a[1])[0][0];
        spots.push({ x, y, n: o.n[top] });
    }

    const hc = document.createElement('canvas');
    hc.width = hc.height = 256;
    hc.getContext('2d').putImageData(img, 0, 0);
    return { img: hc, spots, names: o.n };
}

// ---------- dibujo del mapa ----------
export function drawMap(canvas, { terrain, heatImg, mobs, players, watch, route, routeIdx, me, heatSpots }) {
    const g = canvas.getContext('2d');
    g.clearRect(0, 0, 256, 256);
    g.imageSmoothingEnabled = false;
    if (terrain) {   // drawImage (no putImageData) para que el terreno respete el zoom/transform
        if (!terrain._cv) {
            const tc = document.createElement('canvas');
            tc.width = tc.height = 256;
            tc.getContext('2d').putImageData(terrain, 0, 0);
            terrain._cv = tc;
        }
        g.drawImage(terrain._cv, 0, 0);
    }
    if (heatImg) g.drawImage(heatImg, 0, 0);

    for (const [, x, y] of mobs || []) {
        g.fillStyle = '#a371f7';
        g.fillRect(x - 1, y - 1, 2, 2);
    }

    if (heatSpots?.length) {
        heatSpots.forEach((s, k) => {
            g.strokeStyle = '#f0b429'; g.lineWidth = 1;
            g.beginPath(); g.arc(s.x + .5, s.y + .5, 5, 0, 7); g.stroke();
            g.save();
            g.translate(s.x + 7, s.y - 5);
            g.scale(-1, 1);
            g.fillStyle = '#f0b429';
            g.font = '700 9px monospace';
            g.fillText(k + 1, 0, 0);
            g.restore();
        });
    }

    for (const p of players) {
        const w = watch.includes(p.n.toLowerCase());
        g.fillStyle = w ? '#f85149' : '#f0b429';
        g.fillRect(p.x - 1, p.y - 1, 3, 3);
        if (w) {
            g.strokeStyle = '#f85149';
            g.strokeRect(p.x - 4, p.y - 4, 9, 9);
        }
    }

    if (route?.length) {
        const end = route[route.length - 1];
        g.save();
        g.strokeStyle = '#58a6ff';
        g.lineWidth = 1.2;
        g.setLineDash([3, 2]);
        g.beginPath();
        g.moveTo(me.x + .5, me.y + .5);
        for (const [x, y] of route.slice(routeIdx || 0)) g.lineTo(x + .5, y + .5);
        g.stroke();
        g.restore();
        g.strokeStyle = '#3fb950';
        g.strokeRect(end[0] - 2, end[1] - 2, 5, 5);
    }

    g.strokeStyle = '#58a6ff';
    g.strokeRect(me.x - 2, me.y - 2, 5, 5);
}

// ---------- tabla de jugadores ----------
export function renderPlayersTable(container, players, { watch, minDist, ttl, onGo, onFollow, extraCols = false }) {
    if (!players.length) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = 'Sin jugadores.';
        container.replaceChildren(empty);
        return;
    }

    const table = document.createElement('table');
    table.innerHTML = `<thead><tr>
    <th>Jugador</th><th>Dist</th><th>Coords</th><th>Visto</th>${extraCols ? '<th>Fuente</th>' : ''}
  </tr></thead>`;

    const tbody = document.createElement('tbody');
    for (const p of players) {
        const tr = document.createElement('tr');
        const cls = [];
        if (watch.includes(p.n.toLowerCase()) && p.dist >= minDist) cls.push('interest');
        if (p.age > ttl * 500) cls.push('stale');
        tr.className = cls.join(' ');
        tr.title = 'Clic: ir · Shift+clic: seguir';
        tr.onclick = (e) => e.shiftKey ? onFollow(p.n) : onGo(p.x, p.y);

        const cells = [p.n, p.dist + 't', `(${p.x}, ${p.y})`, Math.round(p.age / 1000) + 's'];
        if (extraCols) cells.push(p.src);

        for (const v of cells) {
            const td = document.createElement('td');
            td.textContent = v;
            tr.appendChild(td);
        }
        tbody.appendChild(tr);
    }

    table.appendChild(tbody);
    container.replaceChildren(table);
}

// ---------- chips: spots + guardadas + guardar aquí ----------
export function renderChips(container, { heatSpots, savedLocs, currentMap, onGo, onDeleteSaved, onSave }) {
    const chips = [];

    heatSpots.forEach((s, k) => {
        const b = document.createElement('button');
        b.className = 'chp';
        b.textContent = (k + 1) + ' · ' + s.n;
        b.title = `Spot (${s.x}, ${s.y}) · clic = ir`;
        b.onclick = () => onGo(s.x, s.y);
        chips.push(b);
    });

    savedLocs.forEach((l, i) => {
        const other = currentMap != null && l.map != null && l.map !== currentMap;
        const b = document.createElement('button');
        b.className = 'chp sv' + (other ? ' other' : '');
        b.textContent = l.name + (l.map != null ? ' · m' + l.map : '');
        b.title = (other ? '⚠️ Otro mapa (m' + l.map + ') · ' : '') + `(${l.x}, ${l.y}) · clic = ir · clic derecho = borrar`;
        b.onclick = () => onGo(l.x, l.y);
        b.oncontextmenu = (e) => { e.preventDefault(); onDeleteSaved(i); };
        chips.push(b);
    });

    const add = document.createElement('button');
    add.className = 'chp add';
    add.textContent = '+ guardar aquí';
    add.title = 'Clic: guarda tu posición · Shift+clic: con nombre';
    add.onclick = (e) => onSave(e.shiftKey);
    chips.push(add);

    container.replaceChildren(...chips);
}

// ---------- log de eventos ----------
export function createEventLog(container, max = 30) {
    const evs = [];
    return function ev(txt, cls) {
        evs.unshift({ t: new Date().toTimeString().slice(0, 5), txt, cls });
        if (evs.length > max) evs.pop();
        container.replaceChildren(...evs.slice(0, 4).map((e) => {
            const d = document.createElement('div');
            const s = document.createElement('span');
            s.className = e.cls;
            s.textContent = e.t;
            d.append(s, ' ' + e.txt);
            return d;
        }));
    };
}

// ---------- helpers de storage ----------
export async function loadSavedLocs() {
    const c = await chrome.storage.local.get('savedLocs');
    return Array.isArray(c.savedLocs) ? c.savedLocs : [];
}

export function saveSavedLocs(savedLocs) {
    return chrome.storage.local.set({ savedLocs });
}

export function splitNames(s) {
    return (s || '').split(',').map((x) => x.trim()).filter(Boolean);
}