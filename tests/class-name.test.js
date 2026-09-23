import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    MAX_CLASS_NAME_BYTES,
    stripUnsafeChars,
    byteLength,
    truncateToBytes,
    normalizeClassName,
    isDuplicateClassName,
    UNNAMED_CLASS_LABEL,
    displayClassName,
    toEnumIdentifier,
    deriveEnumIdentifiers
} from '../js/class-name.js';

describe('MAX_CLASS_NAME_BYTES', () => {

    it('leaves room for the worst-case UART suffix', () => {
        // "#100\n" is 5 bytes; UART_MAX_BYTES is 20.
        assert.equal(MAX_CLASS_NAME_BYTES, 15);
    });
});

describe('stripUnsafeChars', () => {

    it('removes the UART separator', () => {
        assert.equal(stripUnsafeChars('Clase #1'), 'Clase 1');
    });

    it('removes quotes and backslashes', () => {
        assert.equal(stripUnsafeChars('Gato "grande"'), 'Gato grande');
        assert.equal(stripUnsafeChars('a\\b'), 'ab');
    });

    it('turns control characters into spaces', () => {
        assert.equal(stripUnsafeChars('a\nb'), 'a b');
        assert.equal(stripUnsafeChars('a\tb'), 'a b');
    });

    it('turns Unicode line separators into spaces', () => {
        // JSON.stringify() does not escape U+2028/U+2029, so leaving them in
        // would put a real line break inside the generated TS string literal.
        assert.equal(stripUnsafeChars('a\u2028b'), 'a b');
        assert.equal(stripUnsafeChars('a\u2029b'), 'a b');
    });

    it('handles null and undefined', () => {
        assert.equal(stripUnsafeChars(null), '');
        assert.equal(stripUnsafeChars(undefined), '');
    });

    it('preserves accents, spaces and punctuation', () => {
        assert.equal(stripUnsafeChars('Señal de pare!'), 'Señal de pare!');
    });
});

describe('byteLength', () => {

    it('counts UTF-8 bytes, not characters', () => {
        assert.equal(byteLength('Gato'), 4);
        assert.equal(byteLength('Señal'), 6);
        assert.equal(byteLength('🐱'), 4);
        assert.equal(byteLength(''), 0);
    });
});

describe('truncateToBytes', () => {

    it('is a no-op below the limit', () => {
        assert.equal(truncateToBytes('Gato', 15), 'Gato');
    });

    it('never splits a multi-byte character', () => {
        // 'ñ' is 2 bytes: cutting at 5 must drop it entirely.
        assert.equal(truncateToBytes('aaaañ', 5), 'aaaa');
        assert.equal(truncateToBytes('aaaañ', 6), 'aaaañ');
    });

    it('never splits an emoji', () => {
        assert.equal(truncateToBytes('ab🐱', 4), 'ab');
        assert.equal(truncateToBytes('ab🐱', 6), 'ab🐱');
    });
});

describe('normalizeClassName', () => {

    it('collapses whitespace and trims', () => {
        assert.equal(normalizeClassName('  Gato   negro  '), 'Gato negro');
    });

    it('strips and caps in one pass', () => {
        assert.equal(normalizeClassName('Clase #1'), 'Clase 1');
        assert.equal(byteLength(normalizeClassName('Botella de plástico')), 15);
    });

    it('returns empty string for input that vanishes', () => {
        assert.equal(normalizeClassName('###'), '');
        assert.equal(normalizeClassName('   '), '');
        assert.equal(normalizeClassName(null), '');
    });

    it('output always fits the UART budget', () => {
        const samples = ['Botella de plástico reciclada', 'ñññññññññññññññ', '🐱🐱🐱🐱🐱'];
        for (const s of samples) {
            assert.ok(byteLength(normalizeClassName(s)) <= MAX_CLASS_NAME_BYTES);
        }
    });
});

describe('isDuplicateClassName', () => {

    it('is case-insensitive', () => {
        assert.equal(isDuplicateClassName('gato', ['Gato', 'Perro']), true);
    });

    it('ignores the class being renamed', () => {
        assert.equal(isDuplicateClassName('Gato', ['Gato', 'Perro'], 0), false);
        assert.equal(isDuplicateClassName('Gato', ['Gato', 'Perro'], 1), true);
    });
});

describe('toEnumIdentifier', () => {

    it('sanitizes the first character', () => {
        // Regression: the previous implementation only sanitized slice(1).
        assert.equal(toEnumIdentifier('#Gato', 'Clase_0'), '_Gato');
    });

    it('prefixes identifiers starting with a digit', () => {
        assert.ok(/^[A-Za-z_]/.test(toEnumIdentifier('1 - Gato', 'Clase_0')));
    });

    it('transliterates accents', () => {
        assert.equal(toEnumIdentifier('Señal', 'Clase_0'), 'Senal');
    });

    it('falls back when nothing usable remains', () => {
        assert.equal(toEnumIdentifier('---', 'Clase_3'), 'Clase_3');
        assert.equal(toEnumIdentifier('', 'Clase_3'), 'Clase_3');
    });

    it('always produces a valid TS identifier', () => {
        const samples = ['#Gato', '1 - Gato', 'Señal', 'a b c', '???', 'Gato 🐱'];
        for (const s of samples) {
            assert.ok(/^[A-Za-z_][A-Za-z0-9_]*$/.test(toEnumIdentifier(s, 'Clase_0')),
                `invalid identifier for ${JSON.stringify(s)}`);
        }
    });
});

describe('deriveEnumIdentifiers', () => {

    it('resolves collisions', () => {
        const ids = deriveEnumIdentifiers(['Gato!', 'Gato?']);
        assert.equal(ids.length, 2);
        assert.notEqual(ids[0], ids[1]);
    });

    it('returns one identifier per class, in order', () => {
        const ids = deriveEnumIdentifiers(['Perro', 'Gato', 'Pájaro']);
        assert.deepEqual(ids, ['Perro', 'Gato', 'Pajaro']);
    });

    it('avoids collisions between a fallback and a real name', () => {
        // '---' falls back to 'Clase_0', which is also what 'Clase_0' derives to.
        const ids = deriveEnumIdentifiers(['---', 'Clase_0']);
        assert.equal(new Set(ids).size, 2);
    });

    it('produces no duplicates for pathological input', () => {
        const ids = deriveEnumIdentifiers(['!', '?', '@', '1', '2']);
        assert.equal(new Set(ids).size, 5);
    });
});

describe('displayClassName', () => {

    it('falls back to the unnamed label', () => {
        for (const name of ['', '   ', undefined, null, 5]) {
            assert.equal(displayClassName(name), UNNAMED_CLASS_LABEL, String(name));
        }
    });

    it('returns a real name untouched', () => {
        assert.equal(displayClassName('Gato'), 'Gato');
    });

    it('UNNAMED_CLASS_LABEL is display-only: it does not fit the stored-name budget', () => {
        // If this ever fits, still never store it: two new classes would collide.
        assert.ok(byteLength(UNNAMED_CLASS_LABEL) > MAX_CLASS_NAME_BYTES);
        assert.notEqual(normalizeClassName(UNNAMED_CLASS_LABEL), UNNAMED_CLASS_LABEL);
    });
});
