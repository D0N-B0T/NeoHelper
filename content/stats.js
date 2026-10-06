// content/stats.js
// Overlay de progreso: EXP/h, ETA a próximo nivel, ETA a reset, contador de resets.
// Expone: nada (trabaja solo con eventos y storage)
// Consume: MH.me, MH.cfg, MH.api.getMe, MH.api.isWalking, MH.api.stopWalk

(() => {
    const MH = window.__MH;
    if (!MH) { console.error('[MH] _bus.js no cargado'); return; }

    const ov = {
        el: null, name: null,
        exp0: 0, zen0: 0, t0: 0, samples: [],
        lastExp: null, lastLv: null,
        resetCount: 0, resetTimes: []
    };

    // ---------- hidratar contadores desde storage ----------
    chrome.storage.local.get(['resetCount', 'resetTimes']).then((c) => {
        ov.resetCount = c.resetCount || 0;
        ov.resetTimes = Array.isArray(c.resetTimes) ? c.resetTimes : [];
    }).catch(() => { });

    // ---------- atajo Alt+O ----------
    window.addEventListener('keydown', (e) => {
        if (e.altKey && e.key.toLowerCase() === 'o' && ov.el) {
            ov.el.style.display = ov.el.style.display === 'none' ? '' : 'none';
        }
    }, true);

    // ---------- helpers de formato ----------
    const sh = (n) => Math.abs(n) >= 1e6 ? (n / 1e6).toFixed(2) + 'M'
        : Math.abs(n) >= 1e3 ? (n / 1e3).toFixed(1) + 'k'
            : String(Math.round(n));
    const row = (a, b, c) =>
        `<div style="display:flex;justify-content:space-between;gap:12px"><span style="color:#8b949e">${a}</span><span style="color:${c || '#3fb950'}">${b}</span></div>`;
    const bar = (v, m, c) =>
        `<div style="height:4px;background:#161b22;margin:1px 0 3px"><div style="height:100%;width:${Math.max(0, Math.min(100, m ? v / m * 100 : 0))}%;background:${c}"></div></div>`;

    const fmtTime = (hours, ok) => {
        if (!Number.isFinite(hours)) return ok ? 'sin EXP' : 'midiendo…';
        if (hours <= 0) return 'AHORA';
        const totalMin = Math.max(1, Math.round(hours * 60));
        const h = Math.floor(totalMin / 60);
        const min = totalMin % 60;
        if (h >= 99) return '99h+';
        if (h > 0) return `${h}h ${min}m`;
        return `${min} min`;
    };

    const fmtClock = (date) => {
        let h = date.getHours();
        const min = String(date.getMinutes()).padStart(2, '0');
        const suffix = h >= 12 ? 'pm' : 'am';
        h %= 12; if (h === 0) h = 12;
        return `${h}:${min} ${suffix}`;
    };

    const baseExp = (L) =>
        (L + 8) * (L - 1) ** 2 +
        (L > 255 ? 100 * (L - 247) * (L - 256) ** 2 : 0);

    // ---------- listener principal ----------
    window.addEventListener('mh-stats', (ev) => {
        try {
            const s = JSON.parse(ev.detail), now = Date.now();
            if (s.lv != null && MH.auto) MH.auto.lv = s.lv;   // ⬅️ ahora sí
            const curMap = MH.me?.map;

            if (!ov.el) {
                ov.el = document.createElement('div');
                ov.el.style.cssText = 'position:fixed;top:8px;left:8px;z-index:2147483646;pointer-events:none;min-width:200px;padding:6px 8px;background:rgba(1,4,9,.82);border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font:11px/1.45 ui-monospace,Consolas,monospace;';
                document.documentElement.appendChild(ov.el);
            }
            if (ov.name !== s.n) Object.assign(ov, { name: s.n, exp0: s.exp, zen0: s.zen, t0: now, samples: [] });

            // Reset detectado por caída de EXP (solo si es caída real, no glitch)
            if (ov.lastExp != null && s.exp < ov.lastExp * 0.9) {
                Object.assign(ov, { exp0: s.exp, zen0: s.zen, t0: now, samples: [] });
                chrome.runtime.sendMessage({ target: 'bg', type: 'stop' }).catch(() => { });
                if (MH.auto) { MH.auto.holding = false; MH.auto.holdSpot = null; }
            }

            // Kill detectado por ganancia de EXP (para modo simulación)
            // Solo registrar si el modo simulación está explícitamente activado
            if (ov.lastExp != null && s.exp > ov.lastExp && MH.api.simulation && MH.api.simulation.isEnabled?.()) {
                const expGain = s.exp - ov.lastExp;
                const mobs = MH.api.getMobs?.() || [];
                // Encontrar el mob más cercano
                let closestMob = null;
                let closestDist = Infinity;
                for (const [name, x, y] of mobs) {
                    const dist = Math.abs(x - (MH.me?.x || 0)) + Math.abs(y - (MH.me?.y || 0));
                    if (dist < closestDist) {
                        closestDist = dist;
                        closestMob = name;
                    }
                }
                if (closestMob && closestDist < 10) {  // solo si está cerca
                    MH.api.simulation.recordKill?.(closestMob, expGain);
                }
            }
            ov.lastExp = s.exp;

            // muestras de EXP/zena cada 5s, ventana de 10 min
            if (!ov.samples.length || now - ov.samples[ov.samples.length - 1].t >= 5000) {
                ov.samples.push({ t: now, exp: s.exp, zen: s.zen });
            }
            while (ov.samples[0] && now - ov.samples[0].t > 600000) ov.samples.shift();

            const f = ov.samples[0];
            const dh = (now - f.t) / 3600000;
            const ok = dh >= 0.0083;   // al menos 30 s de datos
            const expH = ok ? Math.max(0, (s.exp - f.exp) / dh) : 0;
            const eta = expH > 0 ? (s.next - s.exp) / expH : 0;
            const pct = s.next > s.cur ? (s.exp - s.cur) / (s.next - s.cur) * 100 : 0;
            const ses = (now - ov.t0) / 60000;
            const nm = String(s.n).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

            const sendChat = async (text) => {
                await chrome.runtime.sendMessage({ target: 'bg', type: 'chat', text }).catch(() => { });
                await new Promise(r => setTimeout(r, 500));  // wait for Enter to process
            };
            const stopHoldThenChat = async (text) => {
                await chrome.runtime.sendMessage({ target: 'bg', type: 'stop' }).catch(() => { });
                await new Promise(r => setTimeout(r, 800));  // longer delay for hold release
                await sendChat(text);
            };

            // AUTO /reset
            if (!MH.cfg.resetLv || s.lv < MH.cfg.resetLv) ov.rst = { n: 0, t: 0 };
            else if (!s.lost) {
                ov.rst ??= { n: 0, t: 0 };
                if (ov.rst.n < 3 && now - ov.rst.t > 45000) {
                    ov.rst.n++;
                    ov.rst.t = now;
                    if (MH.api.isWalking()) MH.api.stopWalk('auto-reset', false);
                    (async () => { await stopHoldThenChat('/reset'); })();
                }
            }

            // ---- RESET REAL: lv cayó desde >= resetLv hasta <= 12 ----
            if (ov.lastLv != null && ov.lastLv >= (MH.cfg.resetLv || 400) && s.lv <= 12 && !s.lost) {
                ov.resetTimes = (ov.resetTimes || []).filter(t => now - t < 24 * 3600 * 1000);
                ov.resetTimes.push(now);
                ov.resetCount = (ov.resetCount || 0) + 1;
                chrome.storage.local.set({ resetCount: ov.resetCount, resetTimes: ov.resetTimes });
                console.log('[MH] reset confirmado · total acumulado:', ov.resetCount);
            }
            ov.lastLv = s.lv;

            // ---- tiempo estimado al próximo reset ----
            const tgt = MH.cfg.resetLv || 400;
            const nextBase = baseExp(s.lv + 1);
            const mul = nextBase > 0 ? s.next / nextBase : 0;
            const resetExp = baseExp(tgt) * mul;
            const resetLeft = Math.max(0, resetExp - s.exp);
            const resetHours = expH > 0 ? resetLeft / expH : Infinity;
            const resetDate = Number.isFinite(resetHours)
                ? new Date(now + resetHours * 3600000)
                : null;

            const rEta =
                s.lv >= tgt ? 'AHORA'
                    : !ok ? 'midiendo…'
                        : expH <= 0 ? 'sin EXP'
                            : `${fmtTime(resetHours, ok)} (${fmtClock(resetDate)})`;

            const totalResets = (MH.cfg.resetBase || 0) + (ov.resetCount || 0);
            const rLastHour = (ov.resetTimes || []).filter(t => now - t < 3600 * 1000).length;
            const rLastDay = (ov.resetTimes || []).filter(t => now - t < 24 * 3600 * 1000).length;

            ov.el.innerHTML =
                (s.lost ? '<div style="color:#fff;background:#da3633;text-align:center;font-weight:700;margin-bottom:3px">DESCONECTADO</div>' : '') +
                `<div style="color:#f0b429;font-weight:700">${nm} · Lv ${s.lv}${s.ml ? ' +' + s.ml : ''}</div>` +
                (s.res != null ? row('Resets (juego)', s.res, '#58a6ff') : '') +
                (s.gres != null ? row('Grand resets', s.gres, '#58a6ff') : '') +
                row('Resets (tú)', totalResets, '#f0b429') +
                row('Resets/h (1h)', rLastHour, '#f0b429') +
                row('Resets/día (24h)', rLastDay, '#f0b429') +
                row('EXP', pct.toFixed(1) + '%') + bar(s.exp - s.cur, s.next - s.cur, '#58a6ff') +
                row('EXP/h (10m)', ok ? sh(expH) : '…') +
                row('Próx. nivel', eta > 0 && eta < 100 ? Math.floor(eta) + 'h ' + Math.round(eta % 1 * 60) + 'm' : '—') +
                row('Tiempo p/ reset', rEta, '#f0b429') +
                row('Sesión', Math.floor(ses / 60) + 'h ' + Math.round(ses % 60) + 'm · +' + sh(s.exp - ov.exp0)) +
                (s.pts > 0 ? row('Puntos libres', s.pts, '#f0b429') : '') +
                (ov.rst && ov.rst.n ? row('Auto /reset', ov.rst.n >= 3 ? 'falló x3' : 'intento ' + ov.rst.n, ov.rst.n >= 3 ? '#f85149' : '#d29922') : '') +
                (ov.mv && ov.mv.n ? row('Auto /move', ov.mv.done ? 'hecho ✓' : 'intento ' + ov.mv.n, ov.mv.done ? '#3fb950' : '#d29922') : '');
        } catch (e) {
            console.warn('[MH] mh-stats:', e);
        }
    });

    console.log('[MH] stats.js cargado');
})();