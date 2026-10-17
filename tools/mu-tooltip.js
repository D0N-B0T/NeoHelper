/* =========================================================================
 * MU Tooltip Compare — script de consola
 * Lee los tooltips de ítems en pantalla (equipado vs. nuevo) y los compara.
 * No depende de clases CSS concretas: busca por TEXTO.
 *
 * Uso: pegar el contenido de este archivo en la consola de Chrome
 *      (pestaña del juego) y pulsar Enter.
 *      Luego:  MU_TOOLTIP.compare()     -> comparación puntual
 *              MU_TOOLTIP.auto(true)    -> comparación automática
 *              MU_TOOLTIP.auto(false)   -> desactivar automático
 * ========================================================================= */
(() => {
    'use strict';

    // ---------- Configuración ajustable ----------
    const CFG = {
        // Palabras que identifican un tooltip de ítem
        markers: ['Defense:', 'Durability:', 'Defensa:', 'Durabilidad:'],
        // Mínimo de marcadores presentes para considerar el nodo un tooltip
        minMarkers: 2,
        // Selectores candidatos a contener tooltips (se prueban todos)
        candidateSelectors: [
            '[class*="tooltip"]', '[class*="Tooltip"]',
            '[id*="tooltip"]', '[id*="Tooltip"]',
            '[class*="item-info"]', '[class*="itemInfo"]',
            '[class*="popup"]', '[class*="tip"]',
            'table', 'div', 'span'
        ],
        // Opciones especiales/excelentes a detectar
        specials: [
            'Luck', 'Reflect', 'Damage Decrease', 'Damage Reduction',
            'Excellent Damage', 'Excellent Damage Rate', 'Mana', 'Life',
            'Mana/8', 'Life/8', 'Attack Speed', '+7 Speed',
            'Ignore Defense', 'Increase Damage', 'Defense Success',
            'HP Recovery', 'SD', 'Zen', 'Rise', 'PvP'
        ],
        debug: false
    };

    // ---------- Utilidades ----------
    const log = (...a) => console.log(...a);
    const warn = (...a) => console.warn(...a);

    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();

    const textOf = (el) => norm(el.innerText || el.textContent || '');

    const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // ¿El nodo "parece" un tooltip de ítem? (contiene >= minMarkers marcadores)
    const looksLikeTooltip = (text) => {
        let hits = 0;
        for (const m of CFG.markers) if (text.includes(m)) hits++;
        return hits >= CFG.minMarkers;
    };

    // Recorre el DOM y localiza los tooltips visibles reales (el más profundo que cumpla)
    const findTooltips = () => {
        const found = new Set();
        const seen = CFG.candidateSelectors.join(',');

        let candidates;
        try { candidates = document.querySelectorAll(seen); }
        catch (e) { candidates = document.querySelectorAll('div,table,span'); }

        for (const el of candidates) {
            // visibilidad: descartar ocultos / no renderizados
            if (!el.isConnected) continue;
            const cs = getComputedStyle(el);
            if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') continue;
            const rect = el.getBoundingClientRect();
            if (rect.width < 20 || rect.height < 20) continue;

            const txt = textOf(el);
            if (!looksLikeTooltip(txt)) continue;
            found.add(el);
        }

        // Elimina contenedores que engloban a otros tooltips detectados
        const arr = [...found];
        return arr.filter(el => !arr.some(other => other !== el && el.contains(other)));
    };

    // Devuelve la línea que contiene un marcador
    const lineWith = (text, marker) => {
        const lines = text.split('\n').map(norm).filter(Boolean);
        return lines.find(l => l.includes(marker)) || '';
    };

    // ---------- Parser de un tooltip ----------
    const parseTooltip = (el) => {
        const text = textOf(el);
        const lines = text.split('\n').map(norm).filter(Boolean);

        // Nombre: primera línea con letras y sin marcadores conocidos ni números dominantes
        const nameLine = lines.find(l =>
            /[A-Za-zÁÉÍÓÚÑ]/.test(l) &&
            !CFG.markers.some(m => l.includes(m)) &&
            !/^[+\d\s()%.,-]+$/.test(l) &&
            l.length <= 60
        ) || '(sin nombre)';

        // Nivel: "+9", "+11", "(Level 9)", "Level 11"
        let level = null;
        const lvM = text.match(/\+(\d{1,2})\b/);
        if (lvM) level = Number(lvM[1]);
        else {
            const lvM2 = text.match(/level\s*\+?\s*(\d{1,2})/i);
            if (lvM2) level = Number(lvM2[1]);
        }

        // Defensa base: del texto "Defense: 245 (230+15)" -> 230 base y 15 extra
        let defense = null, defenseBase = null, defenseBonus = null;
        const defLine = lineWith(text, 'Defense:') || lineWith(text, 'Defensa:');
        if (defLine) {
            const nums = defLine.match(/\d[\d.,]*/g) || [];
            if (nums.length) {
                defense = Number(nums[0].replace(/[.,]/g, ''));
                if (nums.length > 2) { // formato base+bonus
                    defenseBase = Number(nums[1].replace(/[.,]/g, ''));
                    defenseBonus = Number(nums[2].replace(/[.,]/g, ''));
                }
            }
        }

        // Durabilidad
        const durLine = lineWith(text, 'Durability:') || lineWith(text, 'Durabilidad:');
        const durability = durLine ? (durLine.match(/\d+/g) || []).map(Number) : null;

        // Opciones especiales detectadas
        const specials = CFG.specials.filter(s => new RegExp(escapeRe(s), 'i').test(text));

        return { el, name: nameLine, level, defense, defenseBase, defenseBonus, durability, specials, raw: text };
    };

    // ---------- Detección de "equipado" vs "nuevo" ----------
    // Heurística: el tooltip anclado más a la izquierda/arriba suele ser el equipado
    // (ventana de personaje, lado izquierdo) y el del cursor el nuevo. Ajustable.
    const classify = (a, b) => {
        const ra = a.el.getBoundingClientRect(), rb = b.el.getBoundingClientRect();
        const aLeft = ra.left <= rb.left;
        return aLeft ? { equipped: a, newItem: b } : { equipped: b, newItem: a };
    };

    // ---------- Comparación y salida ----------
    const stars = (n) => '★'.repeat(Math.max(0, Math.min(5, n))) || '—';

    const score = (it) => {
        // Puntuación simple: defensa + 5*nivel + 3*nº opciones
        let s = 0;
        if (it.defense != null) s += it.defense;
        if (it.level != null) s += it.level * 5;
        s += it.specials.length * 3;
        return s;
    };

    const fmtItem = (it, title) => {
        log(`%c${title}`, 'font-weight:bold;font-size:13px;color:#ffe27a');
        log(`  Nombre     : ${it.name}`);
        log(`  Nivel      : ${it.level != null ? '+' + it.level : '—'}`);
        log(`  Defensa    : ${it.defense != null ? it.defense : '—'}` +
            (it.defenseBase != null ? `  (base ${it.defenseBase} + ${it.defenseBonus})` : ''));
        log(`  Durabilidad: ${it.durability ? it.durability.join(' / ') : '—'}`);
        log(`  Opciones   : ${it.specials.length ? it.specials.join(', ') : '—'}`);
        log(`  Score      : ${score(it)}`);
    };

    const compare = () => {
        const tips = findTooltips();

        if (tips.length === 0) {
            warn('[MU-Tooltip] No se ha detectado ningún tooltip con Defense/Durability. Abre el ítem y prueba de nuevo.');
            return;
        }

        const items = tips.map(parseTooltip);

        if (items.length === 1) {
            log('%c[MU-Tooltip] Solo hay 1 tooltip visible — mostrando su información:', 'color:#7ec8ff');
            fmtItem(items[0], 'ÍTEM DETECTADO');
            return;
        }

        const pair = classify(items[0], items[1]);
        const eq = pair.equipped, nw = pair.newItem;

        const dEq = score(eq), dNw = score(nw);
        let verdict, color;
        if (dNw > dEq) { verdict = 'MEJOR -> el ítem nuevo gana'; color = '#66e06a'; }
        else if (dNw < dEq) { verdict = 'PEOR -> quédate con el equipado'; color = '#ff6b6b'; }
        else { verdict = 'EMPATE -> decide por opciones'; color = '#ffd166'; }

        log('%c===== COMPARADOR DE ÍTEMS MU =====', 'font-weight:bold;font-size:14px;color:#a78bfa');
        fmtItem(eq, 'EQUIPADO ACTUAL');
        log('%c-----------------------------------', 'color:#555');
        fmtItem(nw, 'ÍTEM NUEVO (cursor)');

        const defDiff = (nw.defense ?? 0) - (eq.defense ?? 0);
        const lvDiff = (nw.level ?? 0) - (eq.level ?? 0);
        const newSpecials = nw.specials.filter(s => !eq.specials.includes(s));
        const lostSpecials = eq.specials.filter(s => !nw.specials.includes(s));

        log('%c===== DIFERENCIAS =====', 'font-weight:bold;color:#a78bfa');
        log(`  Defensa    : ${defDiff >= 0 ? '+' : ''}${defDiff}`);
        log(`  Nivel      : ${lvDiff >= 0 ? '+' : ''}${lvDiff}`);
        log(`  Gana opcs. : ${newSpecials.length ? newSpecials.join(', ') : '—'}`);
        log(`  Pierde opcs: ${lostSpecials.length ? lostSpecials.join(', ') : '—'}`);
        log(`%cVEREDICTO: ${verdict}  ${stars(Math.round(dNw / 50))}`, 'font-weight:bold;color:' + color);

        if (CFG.debug) {
            log('%c--- RAW ---', 'color:#888');
            items.forEach((it, i) => log(`#${i}\n${it.raw}`));
        }
    };

    // ---------- Arranque ----------
    const MU_TOOLTIP = {
        compare,
        findTooltips,
        parseTooltip,
        // Vigilancia automática: compara cada vez que aparecen 2 tooltips
        auto(on = true) {
            if (this._ob) { this._ob.disconnect(); this._ob = null; }
            if (!on) { log('[MU-Tooltip] auto OFF'); return; }
            let last = '';
            this._ob = new MutationObserver(() => {
                const tips = findTooltips();
                if (tips.length >= 2) {
                    const key = tips.map(textOf).join('|');
                    if (key !== last) { last = key; compare(); }
                }
            });
            this._ob.observe(document.body, { childList: true, subtree: true, characterData: true });
            log('[MU-Tooltip] auto ON — compara solo cuando hay 2 tooltips abiertos.');
        },
        cfg: CFG
    };

    window.MU_TOOLTIP = MU_TOOLTIP;

    log('%c[MU-Tooltip] listo. Ejecuta: MU_TOOLTIP.compare()  (o MU_TOOLTIP.auto(true))',
        'color:#7ec8ff;font-weight:bold');
})();
