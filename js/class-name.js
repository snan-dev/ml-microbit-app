/**
 * class-name.js
 * Pure class-name logic: normalization for storage and the UART wire, and
 * identifier derivation for the generated MakeCode enum.
 *
 * No browser APIs — importable from node:test.
 */

/**
 * UART messages are "name#confidence\n" and must fit in UART_MAX_BYTES (20).
 * Worst-case suffix is "#100\n" = 5 bytes, so the name may use 15.
 * Kept as a literal (not derived from protocol.js) to avoid a circular import;
 * protocol.js imports from this module, not the other way around.
 */
export const MAX_CLASS_NAME_BYTES = 15;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Characters that break a downstream consumer:
 *   #  — the UART field separator, would corrupt parsing on the micro:bit
 *   "  — would break the generated //% block="..." annotation
 *   \  — would start an escape sequence in the generated TypeScript
 * Control characters (including newline) are replaced by a space rather than
 * removed, so that "a\nb" becomes "a b" instead of "ab". U+2028 and U+2029 are
 * in that set because JSON.stringify() does NOT escape them: they would become
 * a real line break inside the generated TypeScript string literal.
 *
 * @param {*} value
 * @returns {string}
 */
export function stripUnsafeChars(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/[#"\\]/g, '')
        .replace(/[\u0000-\u001F\u007F\u2028\u2029]/g, ' ');
}

/**
 * UTF-8 byte length of a value.
 * @param {*} value
 * @returns {number}
 */
export function byteLength(value) {
    if (value === null || value === undefined) return 0;
    return encoder.encode(String(value)).length;
}

/**
 * Truncates to at most maxBytes UTF-8 bytes without splitting a multi-byte
 * character (backs off over 10xxxxxx continuation bytes).
 *
 * @param {*} value
 * @param {number} maxBytes
 * @returns {string}
 */
export function truncateToBytes(value, maxBytes) {
    const str = value === null || value === undefined ? '' : String(value);
    const bytes = encoder.encode(str);
    if (bytes.length <= maxBytes) return str;
    let end = maxBytes;
    while (end > 0 && (bytes[end] & 0xC0) === 0x80) end--;
    return decoder.decode(bytes.subarray(0, end));
}

/**
 * Canonical form of a class name: this is what gets stored, sent over UART and
 * written into _tmClaseNombres. Returns '' for input that normalizes to nothing;
 * the caller decides what to do with that (the UI reverts to the previous name).
 *
 * @param {*} value
 * @returns {string}
 */
export function normalizeClassName(value) {
    const cleaned = stripUnsafeChars(value).replace(/\s+/g, ' ').trim();
    return truncateToBytes(cleaned, MAX_CLASS_NAME_BYTES);
}

/**
 * Case-insensitive duplicate check. Two classes with names differing only in
 * case would be indistinguishable to a teacher reading the cards and would
 * derive colliding enum identifiers, so they are treated as duplicates.
 *
 * @param {string} name
 * @param {string[]} existingNames
 * @param {number} [ignoreIndex] - Lets a rename keep its own current name
 * @returns {boolean}
 */
export function isDuplicateClassName(name, existingNames, ignoreIndex = -1) {
    const target = String(name ?? '').toLowerCase();
    for (let i = 0; i < existingNames.length; i++) {
        if (i === ignoreIndex) continue;
        if (String(existingNames[i] ?? '').toLowerCase() === target) return true;
    }
    return false;
}

const ACCENT_MAP = {
    'á': 'a', 'à': 'a', 'ä': 'a', 'â': 'a', 'ã': 'a',
    'é': 'e', 'è': 'e', 'ë': 'e', 'ê': 'e',
    'í': 'i', 'ì': 'i', 'ï': 'i', 'î': 'i',
    'ó': 'o', 'ò': 'o', 'ö': 'o', 'ô': 'o', 'õ': 'o',
    'ú': 'u', 'ù': 'u', 'ü': 'u', 'û': 'u',
    'ñ': 'n', 'ç': 'c',
    'Á': 'A', 'À': 'A', 'Ä': 'A', 'Â': 'A', 'Ã': 'A',
    'É': 'E', 'È': 'E', 'Ë': 'E', 'Ê': 'E',
    'Í': 'I', 'Ì': 'I', 'Ï': 'I', 'Î': 'I',
    'Ó': 'O', 'Ò': 'O', 'Ö': 'O', 'Ô': 'O', 'Õ': 'O',
    'Ú': 'U', 'Ù': 'U', 'Ü': 'U', 'Û': 'U',
    'Ñ': 'N', 'Ç': 'C'
};

/**
 * Derives an ASCII identifier valid as a TypeScript enum member. The identifier
 * is internal — the user-visible label is the //% block="..." annotation — so
 * readability matters only for debugging the generated file.
 *
 * @param {*} name
 * @param {string} fallback - Used when nothing usable remains
 * @returns {string}
 */
export function toEnumIdentifier(name, fallback) {
    const source = name === null || name === undefined ? '' : String(name);
    const ascii = source.replace(/[^\x00-\x7F]/g, (ch) => ACCENT_MAP[ch] || '_');
    let id = ascii.replace(/[^a-zA-Z0-9]/g, '_');
    if (!id.replace(/_/g, '')) return fallback;
    if (/^[0-9]/.test(id)) id = '_' + id;
    return id.charAt(0).toUpperCase() + id.slice(1);
}

/**
 * Derives one identifier per class name, guaranteeing uniqueness. Collisions
 * get a numeric suffix (Gato!, Gato? -> Gato_, Gato__2).
 *
 * @param {string[]} classNames
 * @returns {string[]}
 */
export function deriveEnumIdentifiers(classNames) {
    const used = new Set();
    return classNames.map((name, i) => {
        const base = toEnumIdentifier(name, `Clase_${i}`);
        let candidate = base;
        let n = 2;
        while (used.has(candidate)) {
            candidate = `${base}_${n}`;
            n++;
        }
        used.add(candidate);
        return candidate;
    });
}

/**
 * Display-only label for a class whose stored name is empty. Never stored,
 * never sent over UART, never used for the MakeCode enum: it is 16 bytes and
 * MAX_CLASS_NAME_BYTES is 15, so normalizeClassName() would store it as
 * "Clase sin nombr" — and two new classes would then collide.
 */
export const UNNAMED_CLASS_LABEL = 'Clase sin nombre';

/**
 * The text to SHOW for a class name. Only for rendering: anything that gets
 * stored, sent over UART or handed to openMakeCode() uses the raw name.
 *
 * @param {*} name
 * @returns {string}
 */
export function displayClassName(name) {
    return typeof name === 'string' && name.trim() !== '' ? name : UNNAMED_CLASS_LABEL;
}
