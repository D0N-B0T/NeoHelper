// bg/input.js  — UNA sola implementación de keyParams (la buena)

export const NAMED = {
    Enter: [13, 'Enter', '\r'], Escape: [27, 'Escape'],
    Tab: [9, 'Tab', '\t'], Space: [32, 'Space', ' '], Backspace: [8, 'Backspace']
};
export const PUNCT = {
    '/': 191, '.': 190, ',': 188, '-': 189, ' ': 32,
    '!': 49, '@': 50, '#': 51, '$': 52, '%': 53,
    '^': 54, '&': 55, '*': 56, '(': 57, ')': 48,
    '_': 189, '+': 187, '=': 187, '[': 219, ']': 221,
    '{': 219, '}': 221, '\\': 220, '|': 220, ';': 186,
    ':': 186, "'": 222, '"': 222, '<': 188, '>': 190,
    '?': 191, '`': 192, '~': 192
};

export function keyParams(k) {
    if (NAMED[k]) { const [vk, code, text] = NAMED[k]; return { key: k === 'Space' ? ' ' : k, code, vk, text }; }
    if (/^F\d{1,2}$/.test(k)) { const vk = 111 + +k.slice(1); return { key: k, code: k, vk }; }
    const u = k.toUpperCase();
    const vk = /^[A-Z0-9]$/.test(u) ? u.charCodeAt(0) : (PUNCT[k] || 0);
    const code = /^[A-Z]$/.test(u) ? 'Key' + u : /^\d$/.test(k) ? 'Digit' + k : '';
    const isShift = k.length === 1 && /[A-Z!@#$%^&*()_+{}|:"<>?~]/.test(k);
    return { key: k, code, vk, text: k, modifiers: isShift ? 8 : 0 };
}

export async function sendKey(t, keyName) {
    const p = keyParams(keyName);
    const base = { key: p.key, code: p.code, windowsVirtualKeyCode: p.vk, nativeVirtualKeyCode: p.vk, modifiers: p.modifiers || 0 };
    await chrome.debugger.sendCommand(t, 'Input.dispatchKeyEvent', {
        ...base, type: p.text ? 'keyDown' : 'rawKeyDown', text: p.text, unmodifiedText: p.text
    });
    await chrome.debugger.sendCommand(t, 'Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
}

