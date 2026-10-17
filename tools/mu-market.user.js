// ==UserScript==
// @name         MU Market Search
// @match        *://*/*
// @run-at       document-start
// @grant        none
// ==/UserScript==
(() => {
    'use strict';
    if (window.__muTrade) window.__muTrade.destroy();

    /* ═══════════════ 0. CONFIG + STORE (localStorage) ═══════════════ */
    const LS_KEY = 'muTrade.v2';
    const NEW_WIN = 1800;        // seg que un ítem cuenta como NUEVO
    const DROP_WIN = 86400;      // seg que se muestra un cambio de precio
    const MIN_GROUP = 4;         // ítems mínimos para calcular una mediana confiable
    const PARTIAL_RATIO = 0.7;   // si el dump trae <70% del anterior, se asume incompleto y NO se registran ventas
    const store = { snap: null, sold: [], saved: [], alerts: [], akeys: [], unread: 0 };
    try { Object.assign(store, JSON.parse(localStorage.getItem(LS_KEY) || '{}')); } catch (e) { }
    const persist = () => { try { localStorage.setItem(LS_KEY, JSON.stringify(store)); } catch (e) { console.warn('[MU Trade] no se pudo guardar', e); } };
    const nowS = () => Math.floor(Date.now() / 1000);

    /* ═══════════════ 1. DECODER ═══════════════ */
    const hex2bytes = h => { const b = []; for (let i = 0; i + 1 < h.length; i += 2) b.push(parseInt(h.substr(i, 2), 16)); return b; };
    const popcount = n => { let c = 0; while (n) { c += n & 1; n >>= 1; } return c; };

    // [nombre, abreviatura] — excellent estándar MU (alas, anillos y pendants usan otras tablas)
    const EXC_ARMOR = [['Zen +40%', 'ZEN'], ['Def. rate +10%', 'DEF'], ['Reflect 5%', 'REF'], ['Dmg dec. 4%', 'DD'], ['Max Mana +4%', 'MP'], ['Max HP +4%', 'HP']];
    const EXC_WEAPON = [['Mana/8 al matar', 'M8'], ['Vida/8 al matar', 'L8'], ['Vel. ataque +7', 'AS'], ['Daño +2%', 'D2'], ['Daño +lvl/20', 'DL'], ['Exc. dmg rate +10%', 'ER']];
    const TYPES = [['ESPADA', '0'], ['HACHA', '1'], ['MAZA', '2'], ['LANZA', '3'], ['ARCO', '4'], ['STAFF', '5'], ['ESCUDO', '6'], ['CASCO', '7'], ['ARMADURA', '8'], ['PANTALÓN', '9'], ['GUANTES', '10'], ['BOTAS', '11'], ['OTROS', '12,13,14,15']];

    // Layout (12 bytes), validado contra 1514 ítems:
    // [0] índice · [1] skill(7) nivel(3-6) luck(2) add-bajo(0-1) · [2] durabilidad
    // [3] índice+256(7) add-alto(6) excellent(0-5) · [4] ancient: variante(>>2) + stamina(&3)*5
    // [5] grupo(>>4) · [6] 00 · [7-11] FF (sin uso en este server)
    function decodeItem(hex) {
        const b = hex2bytes(hex || '');
        if (b.length < 6) return null;
        const group = b[5] >> 4;
        const exc = b[3] & 0x3F;
        const on = (group <= 5 ? EXC_WEAPON : EXC_ARMOR).filter((_, i) => exc & (1 << i));
        return {
            group,
            index: b[0] + ((b[3] & 0x80) ? 256 : 0),
            level: (b[1] >> 3) & 0xF,
            skill: !!(b[1] & 0x80),
            luck: !!(b[1] & 0x04),
            add: ((b[1] & 3) + ((b[3] & 0x40) ? 4 : 0)) * 4,
            dur: b[2],
            exc, excCount: popcount(exc),
            excNames: on.map(x => x[0]),
            excShort: on.map(x => x[1]),
            ancient: b[4] ? { variant: b[4] >> 2, stamina: (b[4] & 3) * 5 } : null,
            bytes: b
        };
    }

    /* ═══════════════ 2. MOTOR: búsqueda, gangas, diff de dumps, ventas, alertas ═══════════════ */
    const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    const subseq = (nd, hy) => { let i = 0; for (const c of hy) { if (c === nd[i]) i++; if (i === nd.length) return true; } return false; };
    const median = a => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
    // "Ítems comparables": mismo grupo/índice/nivel/opción/luck/skill/cantidad de exc/ancient
    const gkey = d => d ? [d.group, d.index, d.level, d.add, +d.luck, +d.skill, d.excCount, d.ancient ? 1 : 0].join('.') : null;

    function mk(it, x) {
        const d = decodeItem(it.item);
        const h = norm(it.name + (d ? ' ' + d.excNames.join(' ') + (d.luck ? ' luck' : '') + (d.skill ? ' skill' : '') + (d.ancient ? ' ancient' : '') : ''));
        return { it, d, h, s: norm(it.seller), key: gkey(d), f: 0, pp: 0, ct: 0, med: 0, gn: 0, disc: 0, ts: it.listedAt, ...x };
    }

    let entries = [], soldEntries = [], soldComp = new Map();
    let lastInfo = { baseline: true, newN: 0, goneN: 0, partial: false };

    function build(raw) {
        const arr = Array.isArray(raw) ? raw : Object.values(raw || {});
        const t = nowS(), pm = store.snap && store.snap.m;
        const nm = {}, newIds = new Set(), dropIds = new Set();

        // 1) entradas + comparación contra el snapshot anterior (nuevos / cambios de precio)
        entries = arr.map(it => {
            const p = pm && pm[it.id], x = {};
            if (pm) {
                if (!p) { x.f = t; newIds.add(it.id); }
                else {
                    x.f = p.f; x.pp = p.pp || 0; x.ct = p.ct || 0;
                    if (p.p !== it.price) { x.pp = p.p; x.ct = t; if (it.price < p.p) dropIds.add(it.id); }
                }
            }
            nm[it.id] = { n: it.name, s: it.seller, p: it.price, i: it.item, l: it.listedAt, m: it.mine ? 1 : 0, f: x.f || 0, pp: x.pp || 0, ct: x.ct || 0 };
            return mk(it, x);
        });

        // 2) ítems que desaparecieron = vendidos o retirados (con guardia contra dumps incompletos)
        const partial = !!pm && arr.length < Object.keys(pm).length * PARTIAL_RATIO;
        const mineGone = []; let goneN = 0;
        if (pm && !partial) {
            for (const id in pm) {
                if (id in nm) continue;
                const p = pm[id];
                store.sold.unshift({ id: +id, n: p.n, s: p.s, p: p.p, i: p.i, l: p.l, m: p.m, g: t });
                if (p.m) mineGone.push(p);
                goneN++;
            }
            if (store.sold.length > 1000) store.sold.length = 1000;
        }

        // 3) medianas por grupo comparable -> % de ganga
        const grp = new Map();
        for (const e of entries) if (e.key) (grp.get(e.key) || grp.set(e.key, []).get(e.key)).push(e.it.price);
        const gm = new Map(); grp.forEach((v, k) => gm.set(k, { n: v.length, med: median(v) }));
        for (const e of entries) {
            const s = gm.get(e.key);
            if (s) { e.gn = s.n; e.med = s.med; e.disc = s.n >= MIN_GROUP && s.med > 0 ? Math.max(0, 1 - e.it.price / s.med) : 0; }
        }

        // 4) historial de ventas + precios de venta comparables
        soldEntries = store.sold.map(s => mk({ id: s.id, name: s.n, seller: s.s, price: s.p, item: s.i, listedAt: s.l, mine: !!s.m }, { ts: s.g, g: s.g, c: s.c }));
        const sc = new Map();
        soldEntries.forEach(e => { if (e.key) (sc.get(e.key) || sc.set(e.key, []).get(e.key)).push(e.it.price); });
        soldComp = new Map(); sc.forEach((v, k) => soldComp.set(k, { n: v.length, med: median(v) }));

        if (!partial) store.snap = { ts: t, m: nm };
        lastInfo = { baseline: !pm, newN: newIds.size, goneN, partial };
        if (pm && !partial) checkAlerts(newIds, dropIds, t, mineGone);
        persist();
        return entries.length;
    }

    function search(q, src = entries) {
        const t = nowS(), exs = q.excSel || [], grp = q.grp || [];
        const tokens = norm(q.text).split(/\s+/).filter(Boolean);
        const inc = [], exc = [];
        norm(q.seller).split(/[,\s]+/).filter(Boolean).forEach(s => s[0] === '-' ? (s.length > 1 && exc.push(s.slice(1))) : inc.push(s));
        const out = [];
        for (const e of src) {
            const { it, d } = e;
            if (q.pMin != null && it.price < q.pMin) continue;
            if (q.pMax != null && it.price > q.pMax) continue;
            if (inc.length && !inc.some(s => e.s.includes(s))) continue;
            if (exc.length && exc.some(s => e.s.includes(s))) continue;
            if (q.mine && !it.mine) continue;
            if (q.lvl > 0 && (!d || d.level < q.lvl)) continue;
            if (q.add > 0 && (!d || d.add < q.add)) continue;
            if (q.exc > 0 && (!d || d.excCount < q.exc)) continue;
            if (q.luck && !(d && d.luck)) continue;
            if (q.skill && !(d && d.skill)) continue;
            if (q.anc && !(d && d.ancient)) continue;
            if (grp.length && !(d && grp.includes(d.group))) continue;
            if (exs.length && !(d && exs.every(n => d.excNames.includes(n)))) continue;
            if (q.gan > 0 && e.disc < q.gan) continue;
            if (q.isNew && !(e.f && t - e.f < NEW_WIN)) continue;
            if (q.drop && !(e.ct && e.pp > it.price && t - e.ct < DROP_WIN)) continue;
            let score = 0;
            for (const w of tokens) {                    // AND entre tokens: substring > subsecuencia (fuzzy "drgn shld")
                const p = e.h.indexOf(w);
                if (p >= 0) score += 100 - Math.min(p, 50) + (p === 0 ? 20 : 0);
                else if (w.length >= 3 && subseq(w, e.h)) score += 10;
                else { score = -1; break; }
            }
            if (score < 0) continue;
            out.push({ e, score });
        }
        const cmp = {
            relevance: (a, b) => b.score - a.score || a.e.it.price - b.e.it.price || b.e.ts - a.e.ts,
            'price-asc': (a, b) => a.e.it.price - b.e.it.price || b.e.ts - a.e.ts,
            'price-desc': (a, b) => b.e.it.price - a.e.it.price || b.e.ts - a.e.ts,
            'date-desc': (a, b) => b.e.ts - a.e.ts,
            'date-asc': (a, b) => a.e.ts - b.e.ts,
            bargain: (a, b) => b.e.disc - a.e.disc || a.e.it.price - b.e.it.price
        }[q.sort] || (() => 0);
        return out.sort(cmp);
    }

    // Alertas: búsquedas guardadas que matchean ítems NUEVOS o que BAJARON de precio, + ventas de tus ítems
    function checkAlerts(newIds, dropIds, t, mineGone) {
        if (!newIds.size && !dropIds.size && !mineGone.length) return;
        const fresh = [];
        for (const S of store.saved) {
            if (S.on === false) continue;
            for (const { e } of search({ ...S.q, sort: 'relevance' })) {
                const id = e.it.id, kind = newIds.has(id) ? 'NUEVO' : dropIds.has(id) ? 'BAJÓ' : '';
                const k = S.name + ':' + id + ':' + e.it.price;
                if (!kind || store.akeys.includes(k)) continue;
                store.akeys.push(k);
                fresh.push({ t, s: S.name, k: kind, id, n: e.it.name, p: e.it.price, pp: e.pp, sl: e.it.seller, i: e.it.item });
            }
        }
        mineGone.forEach(p => fresh.push({ t, s: 'MIS ÍTEMS', k: 'VENDIDO', id: 0, n: p.n, p: p.p, pp: 0, sl: p.s, i: p.i }));
        if (!fresh.length) return;
        store.alerts = fresh.concat(store.alerts).slice(0, 200);
        store.akeys = store.akeys.slice(-600);
        store.unread += fresh.length;
        fresh.forEach(fire);
    }

    function fire(a) {
        const txt = `🔔 ${a.s}: ${a.n} ${a.k === 'BAJÓ' ? `bajó ${a.pp}→${a.p}` : a.k === 'VENDIDO' ? `se fue (${a.p})` : `nuevo a ${a.p}`} — ${a.sl}`;
        try { ((window.__muTrade && window.__muTrade.onAlert) || []).forEach(fn => fn(a, txt)); } catch (e) { }
        const tg = window.muTradeTelegram;   // opcional: window.muTradeTelegram = { token:'...', chat:'...' }
        if (tg && tg.token && tg.chat) fetch(`https://api.telegram.org/bot${tg.token}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: tg.chat, text: txt }) }).catch(() => { });
    }

    /* ═══════════════ 3. UI (Shadow DOM, sin tocar el canvas) ═══════════════ */
    const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const ago = ts => { const s = Math.max(0, Date.now() / 1000 - ts); return s < 3600 ? (s / 60 | 0) + 'm' : s < 86400 ? (s / 3600 | 0) + 'h' : (s / 86400 | 0) + 'd'; };
    const num = v => { const n = parseFloat(v); return isNaN(n) ? null : n; };

    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;pointer-events:none';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
<style>
:host{all:initial}
*{box-sizing:border-box}
::-webkit-scrollbar{width:8px;height:8px}::-webkit-scrollbar-thumb{background:#2a343d}::-webkit-scrollbar-track{background:#090c0f}
.panel{position:fixed;top:40px;right:20px;width:880px;height:min(700px,90vh);display:none;flex-direction:column;pointer-events:auto;
 background:#0d1217;border:1px solid #1e272f;color:#aebac4;font:12px/1.35 Consolas,'Courier New',monospace;box-shadow:0 10px 40px #000c}
.panel.open{display:flex}
.haz{height:4px;flex:none;background:repeating-linear-gradient(-45deg,#ffb000 0 6px,#0d1217 6px 12px)}
.hd{display:flex;align-items:center;gap:10px;padding:6px 10px;background:#10171d;border-bottom:1px solid #1e272f;cursor:move;user-select:none;flex:none}
.hd b{color:#ffb000;letter-spacing:2px}.dim{color:#5a6670}.dl{color:#5a6670;font-size:11px}.wn{color:#ff5555;font-size:11px}
.led{width:8px;height:8px;border-radius:50%;background:#ff5555;box-shadow:0 0 6px #ff5555}
.led.ok{background:#3ddc97;box-shadow:0 0 6px #3ddc97}
.cnt{margin-left:auto;color:#3ddc97}
.x{cursor:pointer;color:#7b8794;padding:0 4px}.x:hover{color:#ff5555}
.bd{display:flex;flex:1;min-height:0}
.sb{width:230px;flex:none;overflow:auto;border-right:1px solid #1e272f;padding:8px;display:flex;flex-direction:column;gap:8px;background:#0a0e12}
.mn{flex:1;display:flex;flex-direction:column;min-width:0}
label{display:flex;flex-direction:column;gap:2px;color:#5a6670;font-size:10px;text-transform:uppercase;letter-spacing:.5px;white-space:nowrap}
.row2,.row3{display:grid;gap:6px}.row2{grid-template-columns:1fr 1fr}.row3{grid-template-columns:1fr 1fr 1fr}
input[type=text],select{background:#05080b;border:1px solid #1e272f;color:#e6edf3;padding:4px 6px;font:inherit;outline:none;width:100%;min-width:0;border-radius:0}
input:focus,select:focus{border-color:#ffb000}
.sec{color:#5a6670;font-size:10px;letter-spacing:1px;border-bottom:1px solid #1e272f;padding-bottom:2px;margin-top:2px}
.tgs,.cps{display:flex;flex-wrap:wrap;gap:4px}
.tg,.cp{padding:2px 7px;font-size:10px;border:1px solid #26313a;color:#8fa1ae;cursor:pointer;user-select:none;background:#0d1217}
.tg:hover,.cp:hover{border-color:#ffb000;color:#ffb000}
.tg.on{background:#3ddc97;border-color:#3ddc97;color:#05080b;font-weight:bold}
.cp.on{background:#ffb000;border-color:#ffb000;color:#05080b;font-weight:bold}
.cp.ty.on{background:#4fc3f7;border-color:#4fc3f7}
.hist{display:flex;align-items:flex-end;gap:1px;height:28px;border-bottom:1px solid #26313a}
.hist span{flex:1;background:#1d6b85;min-height:0}
.sf{display:flex;gap:4px}.sf input{flex:1}.sf button{flex:none;padding:4px 8px}
.svl{display:flex;flex-direction:column;gap:3px}
.sv{display:flex;align-items:center;gap:6px;padding:3px 5px;border:1px solid #1e272f;cursor:pointer}
.sv:hover{border-color:#ffb000}.svn{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#e6edf3}
.svc{color:#4fc3f7}.svx{color:#5a6670}.svx:hover{color:#ff5555}
.svb{display:inline-block;flex:none;width:8px;height:8px;border-radius:50%;background:#2a343d}
.svb.on{background:#3ddc97;box-shadow:0 0 5px #3ddc97}
.btns{display:flex;gap:6px;margin-top:auto}
button{flex:1;background:#131b22;border:1px solid #26313a;color:#aebac4;font:inherit;font-size:11px;letter-spacing:1px;padding:5px 8px;cursor:pointer}
button:hover{border-color:#ffb000;color:#ffb000}
button.mini{flex:none;padding:0 8px;margin-left:auto}
.vt{display:flex;background:#0a0e12;border-bottom:1px solid #1e272f;flex:none}
.vt span{padding:6px 14px;font-size:11px;letter-spacing:1px;color:#5a6670;cursor:pointer;border-right:1px solid #1e272f;user-select:none}
.vt span:hover{color:#ffb000}.vt span.on{color:#ffb000;background:#0d1217;box-shadow:inset 0 -2px #ffb000}
.vt em{font-style:normal;color:#4fc3f7;margin-left:4px}.vt em.al{color:#ff5555}
.st{display:flex;align-items:center;gap:16px;padding:5px 10px;background:#0a0e12;border-bottom:1px solid #1e272f;color:#5a6670;font-size:11px;flex:none;min-height:26px}
.st b{color:#4fc3f7;font-weight:normal}.st b.a{color:#ffb000}.st b.g{color:#3ddc97}
.r,.th{display:grid;grid-template-columns:170px 1fr 96px 56px 54px 40px;gap:8px;padding:3px 10px;align-items:center}
.th{background:#10171d;border-bottom:1px solid #1e272f;color:#5a6670;font-size:10px;letter-spacing:1px;padding-top:4px;padding-bottom:4px;flex:none}
.th span{cursor:pointer;user-select:none}.th span:hover,.th span.on{color:#ffb000}.th .rt{text-align:right}
.th em{font-style:normal;margin-left:3px;font-size:9px}
.list{flex:1;overflow:auto;min-height:0}
.r{border-bottom:1px solid #131a20;border-left:2px solid transparent;cursor:pointer}
.r:hover{background:#111a21}.r.qe{border-left-color:#ffb000}.r.qa{border-left-color:#c792ea}
.nm{color:#e6edf3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pp{display:flex;flex-wrap:wrap;gap:2px}
.tag{flex:none;padding:0 4px;font-size:10px;border:1px solid #26313a;color:#8fa1ae}
.tag.l{color:#3ddc97;border-color:#1c5a42}.tag.s{color:#4fc3f7;border-color:#1d4a60}.tag.o{color:#e6edf3}
.tag.e{color:#ffb000;border-color:#6a4a00}.tag.a{color:#c792ea;border-color:#4a3a6a}
.tag.n{background:#4fc3f7;border-color:#4fc3f7;color:#05080b;font-weight:bold}
.tag.dn{color:#3ddc97;border-color:#1c5a42}.tag.up{color:#ff5555;border-color:#6a2020}.tag.m{color:#ffb000;border-color:#ffb000}
.sl{color:#8fa1ae;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.sl:hover{color:#4fc3f7;text-decoration:underline}
.pr{color:#ffb000;text-align:right;font-weight:bold}.ag{color:#5a6670;text-align:right}
.vm{text-align:right;color:#3ddc97;font-weight:bold}.vm.d{color:#5a6670;font-weight:normal}
.dt{padding:8px 10px;background:#05080b;border-bottom:1px solid #1e272f;color:#8fa1ae;font-size:11px}
.bg{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px}
.bc{display:flex;flex-direction:column;align-items:center;min-width:34px;padding:2px 4px;border:1px solid #1e272f}
.bc b{color:#ffb000;font-weight:normal}.bc i{font-style:normal;font-size:9px;color:#5a6670}
.sm{padding:1px 0}.sm b{color:#e6edf3;font-weight:normal}
.more{padding:6px}
.empty{padding:28px 14px;color:#5a6670;text-align:center;line-height:1.6}
.tab{position:fixed;top:40px;right:0;pointer-events:auto;background:#10171d;border:1px solid #1e272f;border-right:0;border-left:3px solid #ffb000;
 color:#ffb000;font:bold 11px Consolas,monospace;padding:8px 6px;cursor:pointer;writing-mode:vertical-rl;letter-spacing:3px}
.panel.open ~ .tab{display:none}
</style>
<div class="panel" id="p">
 <div class="haz"></div>
 <div class="hd" id="hd"><i class="led" id="led"></i><b>MU TRADE</b><span class="dim">MARKET SCANNER</span><span class="dl" id="dl"></span><span class="wn" id="wn"></span><span class="cnt" id="cnt">0 / 0</span><span class="x" id="x">✕</span></div>
 <div class="bd">
  <aside class="sb">
   <label>Nombre / propiedad<input type="text" id="text" placeholder="plate helm reflect luck" autocomplete="off"></label>
   <label>Vendedor (-excluye)<input type="text" id="seller" placeholder="ale, -bot" autocomplete="off"></label>
   <div class="row2">
    <label>Precio min<input type="text" inputmode="numeric" id="pMin" autocomplete="off"></label>
    <label>Precio max<input type="text" inputmode="numeric" id="pMax" autocomplete="off"></label>
   </div>
   <div class="row3">
    <label>Nivel ≥<select id="lvl"></select></label>
    <label>Opción ≥<select id="add"><option value="">—</option><option value="4">+4</option><option value="8">+8</option><option value="12">+12</option><option value="16">+16</option><option value="20">+20</option><option value="24">+24</option><option value="28">+28</option></select></label>
    <label>Exc ≥<select id="exc"></select></label>
   </div>
   <label>Ganga: bajo la mediana ≥<select id="gan"><option value="">—</option><option value="0.2">20%</option><option value="0.3">30%</option><option value="0.5">50%</option><option value="0.7">70%</option></select></label>
   <div class="tgs">
    <span class="tg" data-k="luck">LUCK</span><span class="tg" data-k="skill">SKILL</span><span class="tg" data-k="anc">ANCIENT</span>
    <span class="tg" data-k="mine">MÍOS</span><span class="tg" data-k="isNew">NUEVOS</span><span class="tg" data-k="drop">BAJÓ</span>
   </div>
   <div class="sec">TIPO</div><div class="cps" id="cpT"></div>
   <div class="sec">EXCELLENT · ARMADURA</div><div class="cps" id="cpA"></div>
   <div class="sec">EXCELLENT · ARMA</div><div class="cps" id="cpW"></div>
   <div class="sec">PRECIOS (ESCALA LOG)</div><div class="hist" id="hist"></div>
   <div class="sec">BÚSQUEDAS GUARDADAS · ALERTAS</div>
   <div class="sf"><input type="text" id="svname" placeholder="nombre (opcional)" autocomplete="off"><button id="svsave">GUARDAR</button></div>
   <div class="svl" id="svl"></div>
   <div class="btns"><button id="rst">RESET</button><button id="rld">RECARGAR</button></div>
  </aside>
  <section class="mn">
   <div class="vt"><span data-v="list" class="on">MERCADO</span><span data-v="sold">VENDIDOS<em id="nS"></em></span><span data-v="alerts">ALERTAS<em class="al" id="nA"></em></span></div>
   <div class="st" id="st"></div>
   <div class="th"><span data-s="rel">ÍTEM</span><span>PROPIEDADES</span><span>VENDEDOR</span><span class="rt" data-s="price">PRECIO</span><span class="rt" data-s="bar">vs MED</span><span class="rt" data-s="date">EDAD</span></div>
   <div class="list" id="list"></div>
  </section>
 </div>
</div>
<div class="tab" id="tab">MARKET</div>`;

    const $ = id => root.getElementById(id);
    const panel = $('p'), list = $('list');
    let results = [], shown = 0, sortMode = 'relevance', view = 'list';
    const expanded = new Set();
    const PAGE = 120;

    $('lvl').innerHTML = '<option value="">—</option>' + Array.from({ length: 15 }, (_, i) => `<option value="${i + 1}">+${i + 1}</option>`).join('');
    $('exc').innerHTML = '<option value="">—</option>' + [1, 2, 3, 4, 5, 6].map(n => `<option value="${n}">${n}</option>`).join('');
    const chip = ([n]) => `<span class="cp ex" data-n="${esc(n)}">${esc(n)}</span>`;
    $('cpA').innerHTML = EXC_ARMOR.map(chip).join('');
    $('cpW').innerHTML = EXC_WEAPON.map(chip).join('');
    $('cpT').innerHTML = TYPES.map(([n, g]) => `<span class="cp ty" data-t="${n}" data-g="${g}">${n}</span>`).join('');

    const tg = k => !!root.querySelector(`.tg.on[data-k="${k}"]`);
    const readQuery = () => {
        const tys = [...root.querySelectorAll('.cp.ty.on')];
        return {
            text: $('text').value, seller: $('seller').value, sort: sortMode,
            pMin: num($('pMin').value), pMax: num($('pMax').value),
            lvl: num($('lvl').value) || 0, add: num($('add').value) || 0, exc: num($('exc').value) || 0, gan: num($('gan').value) || 0,
            luck: tg('luck'), skill: tg('skill'), anc: tg('anc'), mine: tg('mine'), isNew: tg('isNew'), drop: tg('drop'),
            excSel: [...root.querySelectorAll('.cp.ex.on')].map(c => c.dataset.n),
            tys: tys.map(c => c.dataset.t),
            grp: tys.flatMap(c => c.dataset.g.split(',').map(Number))
        };
    };
    const applyQuery = q => {
        $('text').value = q.text || ''; $('seller').value = q.seller || '';
        $('pMin').value = q.pMin ?? ''; $('pMax').value = q.pMax ?? '';
        $('lvl').value = q.lvl || ''; $('add').value = q.add || ''; $('exc').value = q.exc || ''; $('gan').value = q.gan || '';
        root.querySelectorAll('.tg').forEach(t => t.classList.toggle('on', !!q[t.dataset.k]));
        root.querySelectorAll('.cp.ex').forEach(c => c.classList.toggle('on', (q.excSel || []).includes(c.dataset.n)));
        root.querySelectorAll('.cp.ty').forEach(c => c.classList.toggle('on', (q.tys || []).includes(c.dataset.t)));
        sortMode = q.sort || 'relevance';
    };

    const moreBtn = () => shown < results.length ? `<div class="more"><button id="mb">MOSTRAR MÁS (${results.length - shown})</button></div>` : '';
    const LBL = ['índice', 'lvl·sk·lk·opt', 'dur', 'exc', 'ancient', 'grupo', '—', '—', '—', '—', '—', '—'];

    function rowHTML({ e }) {
        const { it, d } = e, t = nowS(), sold = !!e.g;
        const tags = [];
        if (!sold && e.f && t - e.f < NEW_WIN) tags.push('<span class="tag n">NEW</span>');
        if (!sold && e.ct && e.pp && t - e.ct < DROP_WIN) tags.push(it.price < e.pp ? `<span class="tag dn" title="bajó de precio">↓${e.pp}</span>` : `<span class="tag up" title="subió de precio">↑${e.pp}</span>`);
        if (it.mine) tags.push('<span class="tag m">MÍO</span>');
        if (sold && e.c) tags.push('<span class="tag dn" title="venta confirmada">✔</span>');
        if (d) {
            if (d.level) tags.push(`<span class="tag l">+${d.level}</span>`);
            if (d.add) tags.push(`<span class="tag o">OPT ${d.add}</span>`);
            if (d.skill) tags.push('<span class="tag s">SK</span>');
            if (d.luck) tags.push('<span class="tag s">LK</span>');
            d.excShort.forEach((c, i) => tags.push(`<span class="tag e" title="${esc(d.excNames[i])}">${c}</span>`));
            if (d.ancient) tags.push(`<span class="tag a" title="stamina +${d.ancient.stamina}">ANC${d.ancient.variant}</span>`);
        }
        const q = d && d.ancient ? 'qa' : d && d.excCount ? 'qe' : '';
        const vm = sold ? '<div class="vm d"></div>'
            : e.disc >= 0.2 ? `<div class="vm" title="mediana ${e.med} · n=${e.gn}">−${Math.round(e.disc * 100)}%</div>`
                : `<div class="vm d" title="mediana de comparables (n=${e.gn})">${e.gn >= MIN_GROUP ? '≈' + e.med : ''}</div>`;
        let html = `<div class="r ${q}" data-id="${it.id}"><div class="nm" title="${esc(it.name)}">${esc(it.name)}</div><div class="pp">${tags.join('')}</div>
    <div class="sl" data-seller="${esc(it.seller)}">${esc(it.seller)}</div><div class="pr">${it.price}</div>${vm}<div class="ag">${ago(e.ts)}</div></div>`;
        if (expanded.has(it.id) && d) {
            const cells = d.bytes.map((x, i) => `<span class="bc"><b>${x.toString(16).padStart(2, '0').toUpperCase()}</b><i>${LBL[i]}</i></span>`).join('');
            const sc = soldComp.get(e.key);
            html += `<div class="dt"><div class="bg">${cells}</div>
      <div class="sm">Grupo <b>${d.group}</b> · Índice <b>${d.index}</b></div>
      <div class="sm">Nivel <b>+${d.level}</b> · Opción <b>+${d.add}</b> · Skill <b>${d.skill ? 'sí' : 'no'}</b> · Luck <b>${d.luck ? 'sí' : 'no'}</b> · Durabilidad <b>${d.dur}</b></div>
      <div class="sm">Excellent: <b>${d.excNames.join(', ') || '—'}</b> · Ancient: <b>${d.ancient ? 'variante ' + d.ancient.variant + ' · +' + d.ancient.stamina + ' stamina' : '—'}</b></div>
      <div class="sm">Mercado similar: <b>${e.gn >= MIN_GROUP ? 'mediana ' + e.med + ' · n=' + e.gn : 'pocos datos'}</b> · Vendidos similares: <b>${sc ? 'mediana ' + sc.med + ' · n=' + sc.n : '—'}</b></div>
      ${e.pp && !sold ? `<div class="sm">Precio: <b>${e.pp} → ${it.price}</b> (hace ${ago(e.ct)})</div>` : ''}</div>`;
        }
        return html;
    }

    function paint(append) {
        if (!append) { list.scrollTop = 0; shown = 0; list.innerHTML = ''; }
        if (!results.length) {
            list.innerHTML = '<div class="empty">' + (view === 'sold'
                ? 'Sin ventas detectadas aún.<br>Se detectan comparando dos dumps: recarga el mercado más tarde y los ítems que ya no estén aparecerán acá.'
                : 'Sin resultados.') + '</div>';
            return;
        }
        list.querySelector('.more')?.remove();
        const slice = results.slice(shown, shown + PAGE);
        shown += slice.length;
        list.insertAdjacentHTML('beforeend', slice.map(rowHTML).join('') + moreBtn());
    }

    function updateBadges() {
        $('nS').textContent = store.sold.length ? ' ' + store.sold.length : '';
        $('nA').textContent = store.unread ? ' ' + store.unread : '';
        $('tab').textContent = 'MARKET' + (store.unread ? ' · ' + store.unread : '');
    }

    function renderSaved() {
        $('svl').innerHTML = store.saved.length ? store.saved.map((S, i) =>
            `<div class="sv" data-i="${i}" title="${esc(S.name)}"><i class="svb ${S.on === false ? '' : 'on'}" title="alertas on/off"></i><span class="svn">${esc(S.name)}</span><span class="svc">${search(S.q).length}</span><span class="svx" title="borrar">✕</span></div>`).join('')
            : '<span class="dim">Sin búsquedas guardadas</span>';
    }

    function renderAlerts() {
        store.unread = 0; persist(); updateBadges();
        results = []; shown = 0;
        $('st').innerHTML = `<span>ALERTAS <b class="a">${store.alerts.length}</b></span><button class="mini" id="clrA">LIMPIAR</button>`;
        list.innerHTML = store.alerts.length ? store.alerts.map(a =>
            `<div class="r" data-al="1"><div class="nm" title="${esc(a.n)}">${esc(a.n)}</div><div class="pp"><span class="tag ${a.k === 'BAJÓ' ? 'dn' : a.k === 'VENDIDO' ? 'm' : 'n'}">${a.k}</span><span class="tag">${esc(a.s)}</span></div>
    <div class="sl" data-seller="${esc(a.sl)}">${esc(a.sl)}</div><div class="pr">${a.p}</div><div class="vm d">${a.pp ? '↓' + a.pp : ''}</div><div class="ag">${ago(a.t)}</div></div>`).join('')
            : '<div class="empty">Sin alertas.<br>Guarda una búsqueda (barra lateral) y te avisa cuando aparezca algo nuevo que calce o baje de precio.</div>';
    }

    const ARW = { relevance: ['rel', '●'], 'price-asc': ['price', '▲'], 'price-desc': ['price', '▼'], 'date-desc': ['date', '▼'], 'date-asc': ['date', '▲'], bargain: ['bar', '▼'] };

    function run() {
        updateBadges();
        $('led').classList.toggle('ok', entries.length > 0);
        $('dl').textContent = lastInfo.baseline ? 'BASELINE' : `Δ +${lastInfo.newN} −${lastInfo.goneN}`;
        $('wn').textContent = lastInfo.partial ? '⚠ DUMP PARCIAL: ventas no registradas' : '';
        if (view === 'alerts') return renderAlerts();
        const sold = view === 'sold', q = readQuery();
        if (sold) { q.gan = 0; q.isNew = false; q.drop = false; if (q.sort === 'relevance') q.sort = 'date-desc'; }
        results = search(q, sold ? soldEntries : entries);
        const p = results.map(r => r.e.it.price).sort((a, b) => a - b);
        const med = p.length ? p[p.length >> 1] : '—';
        $('cnt').textContent = `${results.length} / ${sold ? soldEntries.length : entries.length}`;
        const t = nowS();
        $('st').innerHTML = sold
            ? `<span>VENDIDOS <b class="a">${results.length}</b></span><span>MIN <b>${p[0] ?? '—'}</b></span><span>MED <b>${med}</b></span><span>MAX <b>${p[p.length - 1] ?? '—'}</b></span><span class="dim">* desaparecidos: vendidos o retirados</span>`
            : `<span>RESULTADOS <b class="a">${results.length}</b></span><span>MIN <b>${p[0] ?? '—'}</b></span><span>MED <b>${med}</b></span><span>MAX <b>${p[p.length - 1] ?? '—'}</b></span>
       <span>NUEVOS <b>${results.filter(r => r.e.f && t - r.e.f < NEW_WIN).length}</b></span><span>BAJARON <b>${results.filter(r => r.e.ct && r.e.pp > r.e.it.price && t - r.e.ct < DROP_WIN).length}</b></span><span>GANGAS <b class="g">${results.filter(r => r.e.disc >= 0.3).length}</b></span>`;
        root.querySelectorAll('.th [data-s]').forEach(s => { s.querySelector('em')?.remove(); s.classList.remove('on'); });
        root.querySelector('.th [data-s="date"]').firstChild.textContent = sold ? 'SALIÓ' : 'EDAD';
        const [k, a] = ARW[sold && sortMode === 'relevance' ? 'date-desc' : sortMode];
        const th = root.querySelector(`.th [data-s="${k}"]`); th.classList.add('on'); th.insertAdjacentHTML('beforeend', `<em>${a}</em>`);
        if (p.length) {                                // histograma log de precios
            const lo = Math.log(Math.max(p[0], 1)), hi = Math.log(Math.max(p[p.length - 1], 1)), B = 26, bk = new Array(B).fill(0);
            p.forEach(v => { bk[hi === lo ? 0 : Math.min(B - 1, ((Math.log(Math.max(v, 1)) - lo) / (hi - lo) * B) | 0)]++; });
            const mx = Math.max(...bk);
            $('hist').innerHTML = bk.map(n => `<span style="height:${n ? Math.max(8, n / mx * 100) : 0}%"></span>`).join('');
        } else $('hist').innerHTML = '';
        paint(false);
        renderSaved();
    }

    function syncTabs() {
        root.querySelectorAll('.vt [data-v]').forEach(s => s.classList.toggle('on', s.dataset.v === view));
        root.querySelector('.th').style.display = view === 'alerts' ? 'none' : '';
    }

    function saveSearch() {
        const q = readQuery(), inp = $('svname');
        const name = inp.value.trim() || q.text.trim() || q.tys.join('+') || ('búsqueda ' + (store.saved.length + 1));
        store.saved.push({ name, q, on: true });
        inp.value = ''; persist(); renderSaved();
    }

    let t; const debounced = () => { clearTimeout(t); t = setTimeout(run, 120); };
    root.querySelectorAll('input[type=text],select').forEach(el => { if (el.id !== 'svname') el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', debounced); });

    root.querySelector('.sb').addEventListener('click', ev => {
        const el = ev.target;
        const c = el.closest('.cp,.tg'); if (c) { c.classList.toggle('on'); return run(); }
        const sv = el.closest('.sv');
        if (sv) {
            const i = +sv.dataset.i, S = store.saved[i];
            if (el.classList.contains('svx')) store.saved.splice(i, 1);
            else if (el.classList.contains('svb')) S.on = S.on === false;
            else { applyQuery(S.q); view = 'list'; syncTabs(); }
            persist(); return run();
        }
        if (el.id === 'svsave') saveSearch();
    });

    const SORT = { rel: () => 'relevance', price: () => sortMode === 'price-asc' ? 'price-desc' : 'price-asc', bar: () => 'bargain', date: () => sortMode === 'date-desc' ? 'date-asc' : 'date-desc' };
    root.querySelector('.th').addEventListener('click', ev => { const s = ev.target.closest('[data-s]'); if (s) { sortMode = SORT[s.dataset.s](); run(); } });
    root.querySelector('.vt').addEventListener('click', ev => { const s = ev.target.closest('[data-v]'); if (s) { view = s.dataset.v; syncTabs(); run(); } });
    $('st').addEventListener('click', ev => { if (ev.target.id === 'clrA') { store.alerts = []; persist(); run(); } });

    list.addEventListener('click', ev => {
        if (ev.target.id === 'mb') return paint(true);
        const s = ev.target.closest('[data-seller]');
        if (s) { $('seller').value = s.dataset.seller; if (view === 'alerts') { view = 'list'; syncTabs(); } return run(); }
        if (view === 'alerts') return;
        const r = ev.target.closest('.r'); if (!r) return;
        const id = +r.dataset.id; expanded.has(id) ? expanded.delete(id) : expanded.add(id);
        const keep = list.scrollTop;
        list.innerHTML = results.slice(0, shown).map(rowHTML).join('') + moreBtn();
        list.scrollTop = keep;
    });

    $('rst').onclick = () => {
        root.querySelectorAll('.cp.on,.tg.on').forEach(c => c.classList.remove('on'));
        root.querySelectorAll('input[type=text]:not(#svname)').forEach(i => i.value = '');
        root.querySelectorAll('select').forEach(s => s.value = '');
        sortMode = 'relevance'; run();
    };

    // Detecta solo cuando tu dump actualiza window.fullMarketCache (espera 1 poll estable para no leer dumps a medias)
    const sigOf = () => { const a = window.fullMarketCache; if (!a) return ''; const arr = Array.isArray(a) ? a : Object.values(a); let s = arr.length; for (const x of arr) s = (s + x.id * 31 + (x.price | 0)) % 2147483647; return s; };
    let sigCur = sigOf(), sigLast = sigCur;
    const pollTimer = setInterval(() => { const s = sigOf(); if (s !== sigCur && s === sigLast) reload(); sigLast = s; }, 4000);
    let rfTimer;
    const setRefetch = (fn, min = 2) => { clearInterval(rfTimer); if (fn) rfTimer = setInterval(async () => { try { await fn(); } catch (e) { console.warn('[MU Trade] refetch', e); } }, min * 60000); };

    function reload() { sigCur = sigLast = sigOf(); build(window.fullMarketCache); run(); }
    $('rld').onclick = reload;

    const open = () => { panel.classList.add('open'); if (!entries.length) reload(); $('text').focus(); };
    const close = () => panel.classList.remove('open');
    const toggle = () => panel.classList.contains('open') ? close() : open();
    $('x').onclick = close; $('tab').onclick = open;

    // Drag
    $('hd').addEventListener('mousedown', ev => {
        if (ev.target.id === 'x') return;
        const r = panel.getBoundingClientRect(), dx = ev.clientX - r.left, dy = ev.clientY - r.top;
        const mv = e => { panel.style.left = (e.clientX - dx) + 'px'; panel.style.top = (e.clientY - dy) + 'px'; panel.style.right = 'auto'; };
        const up = () => { removeEventListener('mousemove', mv); removeEventListener('mouseup', up); };
        addEventListener('mousemove', mv); addEventListener('mouseup', up);
    });

    // Aislamiento del gameplay: lo que pasa dentro del panel no llega al juego.
    // El juego hace preventDefault a Backspace/Delete/flechas, así que la edición de texto se hace a mano.
    const guard = ev => {
        if (!ev.composedPath().includes(host)) return;
        if (ev.type === 'keydown' && ev.altKey && ev.code === 'KeyM') return;
        const a = root.activeElement;
        if (ev.type === 'keydown' && ev.key === 'Escape') close();
        if (ev.type === 'keydown' && a && a.tagName === 'INPUT' && a.type === 'text') {
            const k = ev.key;
            let s = a.selectionStart, e = a.selectionEnd;
            if (k === 'Backspace' || k === 'Delete') {
                ev.preventDefault();
                if (s === e) k === 'Backspace' ? s = Math.max(0, s - 1) : e = Math.min(a.value.length, e + 1);
                a.setRangeText('', s, e, 'end');
                a.dispatchEvent(new Event('input', { bubbles: true }));
            } else if (k === 'ArrowLeft' || k === 'ArrowRight') {
                ev.preventDefault();
                const p = s !== e ? (k === 'ArrowLeft' ? s : e) : Math.max(0, Math.min(a.value.length, s + (k === 'ArrowLeft' ? -1 : 1)));
                a.setSelectionRange(p, p);
            } else if (k === 'Home' || k === 'End') {
                ev.preventDefault();
                const p = k === 'Home' ? 0 : a.value.length;
                a.setSelectionRange(p, p);
            } else if (ev.ctrlKey && k.toLowerCase() === 'a') {
                ev.preventDefault(); a.select();
            } else if (k === 'Enter' && a.id === 'svname') {
                ev.preventDefault(); saveSearch();
            }
        }
        ev.stopImmediatePropagation();
    };
    const hot = ev => { if (ev.altKey && ev.code === 'KeyM') { ev.preventDefault(); toggle(); } };
    const GUARDED = ['keydown', 'keyup', 'keypress', 'wheel', 'contextmenu'];
    GUARDED.forEach(n => window.addEventListener(n, guard, true));
    window.addEventListener('keydown', hot, true);

    const mount = () => document.documentElement.appendChild(host);
    document.documentElement ? mount() : addEventListener('DOMContentLoaded', mount);

    window.__muTrade = {
        open, close, toggle, reload, search, decodeItem, setRefetch, store,
        onAlert: [],                                   // __muTrade.onAlert.push((alerta, texto) => ...)
        confirmSold(id) { const s = store.sold.find(x => x.id === id); if (!s) return false; s.c = 1; const e = soldEntries.find(x => x.it.id === id); if (e) e.c = 1; persist(); run(); return true; },
        get entries() { return entries; },
        get sold() { return soldEntries; },
        destroy() { clearInterval(pollTimer); clearInterval(rfTimer); GUARDED.forEach(n => window.removeEventListener(n, guard, true)); window.removeEventListener('keydown', hot, true); host.remove(); delete window.__muTrade; }
    };
    if (window.fullMarketCache) { build(window.fullMarketCache); run(); } else { updateBadges(); renderSaved(); }
    console.log('[MU Trade] listo — Alt+M para abrir');
})();
