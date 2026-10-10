import { withDebugger } from './debugger.js';
import { sendKey, keyParams } from './input.js';

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => { });

let timer;
let busy = 0;
let AUTO_WANTS_HOLD = false;

const BTN = {
    right: { button: 'right', buttons: 2 },
    left: { button: 'left', buttons: 1 },
    middle: { button: 'middle', buttons: 4 }
};

chrome.storage.session
    .setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' })
    .catch(() => { });

chrome.debugger.onDetach.addListener(async (src) => {
    const { run } = await chrome.storage.session.get('run');
    if (run && run.tabId === src.tabId) {
        clearInterval(timer);
        await chrome.storage.session.remove('run');
        chrome.action.setBadgeText({ text: '' });
    }
});

async function resolveTabId(m, sender) {
    let tabId = m.tabId ?? sender?.tab?.id;
    if (!tabId) {
        const [t] = await chrome.tabs.query({ url: '*://*.mu.mormon.garden/*' });
        tabId = t?.id;
    }
    return tabId;
}

chrome.runtime.onMessage.addListener((m, sender) => {
    if (m.target !== 'bg') return;
    (async () => {
        // ---------- PICK ----------
        if (m.type === 'pick') {
            const tabId = m.tabId ?? sender?.tab?.id;
            if (!tabId) return;
            const t = { tabId };
            await chrome.debugger.attach(t, '1.3')
                .catch((e) => { if (!/already attached/i.test(e.message)) throw e; });
            const expr = `new Promise((resolve) => {
                const root = document.fullscreenElement || document.documentElement;
                const ov = document.createElement('div');
                ov.style.cssText = 'position:fixed;inset:0;z-index:2147483647;cursor:crosshair;background:rgba(0,0,0,.45);';
                const tip = document.createElement('div');
                tip.textContent = '\uD83C\uDFAF Haz clic para fijar el punto (Esc cancela)';
                tip.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);background:#0d1117;color:#3fb950;border:2px solid #3fb950;padding:8px 18px;border-radius:8px;font:bold 13px ui-monospace,monospace;pointer-events:none;';
                ov.appendChild(tip);
                root.appendChild(ov);
                const done = (v) => { window.removeEventListener('keydown', esc, true); ov.remove(); resolve(v); };
                const esc = (e) => { if (e.key === 'Escape') done(null); };
                window.addEventListener('keydown', esc, true);
                ov.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); done({ x: Math.round(e.clientX), y: Math.round(e.clientY) }); }, true);
                })`;
            try {
                const r = await chrome.debugger.sendCommand(t, 'Runtime.evaluate', {
                    expression: expr, awaitPromise: true, returnByValue: true
                });
                const pt = r?.result?.value;
                if (pt && typeof pt.x === 'number') {
                    if (m.kind === 'chat') await chrome.storage.local.set({ chatX: pt.x, chatY: pt.y });
                    else await chrome.storage.local.set({ x: pt.x, y: pt.y });
                    chrome.action.setBadgeBackgroundColor({ color: '#238636' });
                    chrome.action.setBadgeText({ text: 'OK' });
                    setTimeout(async () => {
                        const { run } = await chrome.storage.session.get('run');
                        chrome.action.setBadgeText({ text: run ? 'HOLD' : '' });
                    }, 1500);
                }
            } finally {
                const { run } = await chrome.storage.session.get('run');
                if (!run || run.tabId !== tabId) await chrome.debugger.detach(t).catch(() => { });
            }
            return;
        }



        // ---------- REAL CLICK ----------
        if (m.type === 'realClick') {
            const tabId = await resolveTabId(m, sender);
            if (!tabId) return;
            const t = { tabId };
            const send = (type, p) => chrome.debugger.sendCommand(t, type, p);
            try {
                await chrome.debugger.attach(t, '1.3')
                    .catch(e => { if (!/already attached/i.test(e.message)) throw e; });
                await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: m.x, y: m.y });
                await new Promise(r => setTimeout(r, 40));
                await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: m.x, y: m.y, button: 'left', buttons: 1, clickCount: 1 });
                await new Promise(r => setTimeout(r, 50));
                await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: m.x, y: m.y, button: 'left', buttons: 0, clickCount: 1 });
                if (m.dbl) {
                    await new Promise(r => setTimeout(r, 80));
                    await send('Input.dispatchMouseEvent', {
                        type: 'mousePressed', x: m.x, y: m.y, button: 'left', buttons: 1, clickCount: 2
                    });
                    await new Promise(r => setTimeout(r, 50));
                    await send('Input.dispatchMouseEvent', {
                        type: 'mouseReleased', x: m.x, y: m.y, button: 'left', buttons: 0, clickCount: 2
                    });
                }
            } catch (e) {
                console.error('[MH] realClick:', e);
            } finally {
                const { run } = await chrome.storage.session.get('run');
                if (!run) await chrome.debugger.detach(t).catch(() => { });
            }
            return;
        }

        // ---------- MH-MOVE (autowalk) ----------
        if (m.type === 'mh-move') {
            const tabId = await resolveTabId(m, sender);
            if (!tabId) return;
            const t = { tabId };
            try {
                await chrome.debugger.attach(t, '1.3')
                    .catch(e => { if (!/already attached/i.test(e.message)) throw e; });
                const r = await chrome.debugger.sendCommand(t, 'Runtime.evaluate', {
                    expression: `window.__mhMove(${m.x}, ${m.y})`,
                    returnByValue: true
                });
                if (!r?.result?.value?.ok) {
                    console.warn('[MH-MOVE] falló:', r?.result?.value);
                }
            } catch (e) {
                console.warn('[MH-MOVE] error:', e);
            } finally {
                const { run } = await chrome.storage.session.get('run');
                if (!run || run.tabId !== tabId) {
                    await chrome.debugger.detach(t).catch(() => { });
                }
            }
            return;
        }
        // ---------- PRESS ENTER ----------
        if (m.type === 'pressEnter') {
            const tabId = await resolveTabId(m, sender);
            if (!tabId) return;
            try {
                await withDebugger(tabId, async (t) => { await sendKey(t, 'Enter'); });
            } catch (e) { console.error('[MH] pressEnter:', e); }
            return;
        }

        // ---------- ALERT ----------
        if (m.type === 'alert_interest') {
            chrome.notifications.create({
                type: 'basic', iconUrl: 'icon.png',
                title: m.title || '⚠️ ¡ALERTA EN RADAR!',
                message: m.message || `¡El jugador "${m.nombre}" apareció a ${m.distancia} tiles! Coordenadas: (${m.x}, ${m.y})`,
                priority: 2
            });
            return;
        }

        // ---------- START (mouse hold) ----------
        if (m.type === 'start') {
            const tabId = await resolveTabId(m, sender);
            if (!tabId) return;
            const t = { tabId };
            const b = BTN[m.button] || BTN.right;
            await chrome.debugger.attach(t, '1.3')
                .catch((e) => { if (!/already attached/i.test(e.message)) throw e; });
            await chrome.debugger.sendCommand(t, 'Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => { });

            let x = m.x, y = m.y;
            if (x == null || y == null) {
                const r = await chrome.debugger.sendCommand(t, 'Runtime.evaluate', {
                    expression: '[innerWidth/2, innerHeight/2]', returnByValue: true
                });
                [x, y] = r.result.value;
            }
            await chrome.storage.session.set({ run: { tabId, x, y, repeat: m.repeat, ...b } });
            clearInterval(timer);

            // pausesChat: deja el hold armado pero SIN pulsar el botón ni
            // arrancar el loop de clics, para no robar el foco del chat.
            if (m.pausesChat) {
                await chrome.storage.session.remove('run').catch(() => { });
                await chrome.debugger.sendCommand(t, 'Input.dispatchMouseEvent', {
                    type: 'mouseReleased', x, y, button: b.button, buttons: 0, clickCount: 1
                }).catch(() => { });
                chrome.action.setBadgeBackgroundColor({ color: '#d33' });
                chrome.action.setBadgeText({ text: 'HOLD' });
                return;
            }

            await chrome.debugger.sendCommand(t, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
            await chrome.debugger.sendCommand(t, 'Input.dispatchMouseEvent', {
                type: 'mousePressed', x, y, button: b.button, buttons: b.buttons, clickCount: 1
            });
            if (m.repeat > 0) timer = setInterval(() => {
                if (busy) return;
                chrome.debugger.sendCommand(t, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: b.button, buttons: b.buttons })
                    .then(() => chrome.debugger.sendCommand(t, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: b.button, buttons: b.buttons, clickCount: 1 }))
                    .catch(() => clearInterval(timer));
            }, m.repeat);
            chrome.action.setBadgeBackgroundColor({ color: '#d33' });
            chrome.action.setBadgeText({ text: 'HOLD' });
            return;
        }

        // ---------- CHAT ----------
        if (m.type === 'chat') {
            const tabId = await resolveTabId(m, sender);
            if (!tabId) return;
            const text = m.text || '';
            if (!text) return;

            // 1. Si nos piden mantener hold, guardamos estado y soltamos
            const keepHold = !!m.keepHold;
            let savedRun = null;
            if (keepHold) AUTO_WANTS_HOLD = true;   // el content cree que hay hold armado
            if (keepHold) {
                const { run } = await chrome.storage.session.get('run');
                if (run) {
                    savedRun = run;
                    // soltar el hold actual
                    try {
                        const t = { tabId: run.tabId };
                        await chrome.debugger.attach(t, '1.3')
                            .catch(e => { if (!/already attached/i.test(e.message)) throw e; });
                        await chrome.debugger.sendCommand(t, 'Input.dispatchMouseEvent', {
                            type: 'mouseMoved', x: run.x, y: run.y
                        });
                        await chrome.debugger.sendCommand(t, 'Input.dispatchMouseEvent', {
                            type: 'mouseReleased', x: run.x, y: run.y,
                            button: run.button, buttons: 0, clickCount: 1
                        });
                        // OJO: 'run' NO se borra aqui. El paso 3 lo usa como
                        // savedRun para volver a pulsar; se reescribe intacto.
                    } catch (e) {
                        console.warn('[MH] chat: no pude soltar hold', e);
                    }
                }
            }

            // 2. Mandar el chat (código actual)
            try {
                await withDebugger(tabId, async (t) => {
                    await chrome.debugger.sendCommand(t, 'Emulation.setFocusEmulationEnabled', { enabled: true });
                    // El chat puede estar CERRADO (sin el campo en el DOM). Antes se
                    // comprobaba una sola vez; si el juego tardaba en abrirlo, el
                    // foco caia en el canvas y el texto se perdia -> el comando
                    // (/move, /reset...) nunca llegaba. Reintentamos hasta tener el
                    // campo visible y ENFOCADO de verdad.
                    const CHAT_SEL = '.v097d-chat-field.line.to-normal';
                    const FOCUS_EXPR = `(() => { const el = document.querySelector('${CHAT_SEL}'); if (!el) return false; el.focus(); return document.activeElement === el; })()`;
                    let chatOk = false;
                    for (let i = 0; i < 12; i++) {
                        const res = await chrome.debugger.sendCommand(t, 'Runtime.evaluate', {
                            expression: FOCUS_EXPR, returnByValue: true
                        });
                        if (res?.result?.value) { chatOk = true; break; }
                        // Abrir el chat: Enter (el juego lo abre si esta cerrado)
                        await sendKey(t, 'Enter');
                        await new Promise(r => setTimeout(r, 250));
                    }
                    if (!chatOk) console.warn('[MH] chat: el campo de chat no aparecio, mando igual:', text);
                    for (const ch of text) {
                        const p = keyParams(ch);
                        const base = {
                            key: p.key, code: p.code,
                            windowsVirtualKeyCode: p.vk, nativeVirtualKeyCode: p.vk,
                            modifiers: p.modifiers || 0
                        };
                        await chrome.debugger.sendCommand(t, 'Input.dispatchKeyEvent', {
                            ...base, type: p.text ? 'keyDown' : 'rawKeyDown',
                            text: p.text, unmodifiedText: p.text
                        });
                        await new Promise(r => setTimeout(r, 25));
                        await chrome.debugger.sendCommand(t, 'Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
                        await new Promise(r => setTimeout(r, 25));
                    }
                    // Verificar que el texto ENTRO en el campo. Si el foco se perdio,
                    // se escribio en el vacio: reenfocar y reescribir antes del Enter.
                    const typed0 = String((await chrome.debugger.sendCommand(t, 'Runtime.evaluate', {
                        expression: `(document.querySelector('${CHAT_SEL}')?.value || '')`,
                        returnByValue: true
                    }))?.result?.value || '');
                    if (!typed0.toLowerCase().includes(text.toLowerCase())) {
                        console.warn('[MH] chat: el texto no entro (campo =', JSON.stringify(typed0), ') -> reescribo');
                        await chrome.debugger.sendCommand(t, 'Runtime.evaluate', { expression: FOCUS_EXPR, returnByValue: true });
                        for (const ch of text) {
                            const p = keyParams(ch);
                            const base = {
                                key: p.key, code: p.code,
                                windowsVirtualKeyCode: p.vk, nativeVirtualKeyCode: p.vk,
                                modifiers: p.modifiers || 0
                            };
                            await chrome.debugger.sendCommand(t, 'Input.dispatchKeyEvent', {
                                ...base, type: p.text ? 'keyDown' : 'rawKeyDown',
                                text: p.text, unmodifiedText: p.text
                            });
                            await new Promise(r => setTimeout(r, 25));
                            await chrome.debugger.sendCommand(t, 'Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
                            await new Promise(r => setTimeout(r, 25));
                        }
                    }
                    await new Promise(r => setTimeout(r, keepHold ? 50 : 150));
                    await sendKey(t, 'Enter');
                    console.log('[MH] chat enviado:', text);
                });
            } catch (e) {
                console.error('[MH] chat:', e);
            }

            // 3. Reanudar el hold si nos pidieron mantener
            if (keepHold) {
                await new Promise(r => setTimeout(r, 400));
                // Si el 'stop' canceló el hold (pausesChat: no había 'run'),
                // hay que reactivarlo desde cero, no solo re-pulsar.
                if (!savedRun) {
                    const cfg = await chrome.storage.local.get(['button', 'x', 'y', 'repeat']);
                    const tabId2 = await resolveTabId(m, sender);
                    if (tabId2) {
                        const b2 = BTN[cfg.button || 'right'] || BTN.right;
                        savedRun = {
                            tabId: tabId2, x: cfg.x ?? 0, y: cfg.y ?? 0,
                            repeat: cfg.repeat ?? 300, ...b2
                        };
                    }
                }
                if (savedRun) try {
                    const t = { tabId: savedRun.tabId };
                    await chrome.debugger.attach(t, '1.3')
                        .catch(e => { if (!/already attached/i.test(e.message)) throw e; });
                    await chrome.debugger.sendCommand(t, 'Input.dispatchMouseEvent', {
                        type: 'mouseMoved', x: savedRun.x, y: savedRun.y
                    });
                    await chrome.debugger.sendCommand(t, 'Input.dispatchMouseEvent', {
                        type: 'mousePressed', x: savedRun.x, y: savedRun.y,
                        button: savedRun.button, buttons: savedRun.buttons, clickCount: 1
                    });
                    await chrome.storage.session.set({ run: savedRun });
                } catch (e) {
                    console.warn('[MH] chat: no pude reanudar hold', e);
                }
            }

            return;
        }

        // ---------- STOP ----------
        if (m.type === 'stop') {
            busy++;
            clearInterval(timer);
            timer = null;
            const { run } = await chrome.storage.session.get('run');
            if (!run) {
                busy--;
                // Si el content cree que hay hold (autoparty con pausesChat),
                // no borrar el badge: el chat con keepHold lo repone.
                if (AUTO_WANTS_HOLD) return;
                try { chrome.action.setBadgeText({ text: '' }); } catch (_) { }
                return;
            }
            const t = { tabId: run.tabId };
            try {
                await chrome.debugger.attach(t, '1.3')
                    .catch(e => { if (!/already attached/i.test(e.message)) throw e; });
                await chrome.debugger.sendCommand(t, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: run.x, y: run.y });
                await chrome.debugger.sendCommand(t, 'Input.dispatchMouseEvent', {
                    type: 'mouseReleased', x: run.x, y: run.y,
                    button: run.button, buttons: 0, clickCount: 1
                });
                await new Promise(r => setTimeout(r, 100));
                await chrome.debugger.detach(t).catch(() => { });
            } catch (e) {
                console.error('[MH] stop ERROR:', e);
            } finally {
                await chrome.storage.session.remove('run').catch(() => { });
                try { chrome.action.setBadgeText({ text: '' }); } catch (_) { }
                try { chrome.action.setBadgeBackgroundColor({ color: '#000000' }); } catch (_) { }
                busy--;
            }
            return;
        }

        // ---------- KEYS ----------
        if (m.type === 'keys') {
            const tabId = await resolveTabId(m, sender);
            if (!tabId) return;
            const wait = (ms) => new Promise(r => setTimeout(r, ms));
            try {
                await withDebugger(tabId, async (t) => {
                    for (const k of m.seq) {
                        if (typeof k !== 'string') continue;
                        const p = keyParams(k);
                        const base = {
                            key: p.key, code: p.code,
                            windowsVirtualKeyCode: p.vk, nativeVirtualKeyCode: p.vk,
                            modifiers: p.modifiers || 0
                        };
                        await chrome.debugger.sendCommand(t, 'Input.dispatchKeyEvent', {
                            ...base, type: p.text ? 'keyDown' : 'rawKeyDown',
                            text: p.text, unmodifiedText: p.text
                        });
                        await wait(45);
                        await chrome.debugger.sendCommand(t, 'Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
                        await wait(40);
                    }
                });
            } catch (e) { console.error('[MH] keys:', e); }
            return;
        }
    })().catch((e) => console.error(e));
});