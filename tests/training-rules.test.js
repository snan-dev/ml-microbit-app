import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    MIN_CLASSES,
    MIN_SAMPLES_PER_CLASS,
    BLOCKER_NOT_ENOUGH_CLASSES,
    BLOCKER_MISSING_NAME,
    BLOCKER_NOT_ENOUGH_SAMPLES,
    getTrainingBlockers,
    hasEnoughSamples,
    normalizeSampleCount,
    getBlockedClassIndices,
    formatBlocker,
    classesSignature,
    hasUntrainedChanges,
    classNamesDiverged,
} from '../js/training-rules.js';

const ready = (name) => ({ name, count: MIN_SAMPLES_PER_CLASS });

test('minimums match the documented rule', () => {
    assert.equal(MIN_CLASSES, 2);
    assert.equal(MIN_SAMPLES_PER_CLASS, 8);
});

test('two named classes with enough samples: no blockers', () => {
    assert.deepEqual(getTrainingBlockers([ready('Gato'), ready('Perro')]), []);
});

test('no classes: only the class-count blocker', () => {
    assert.deepEqual(getTrainingBlockers([]), [
        { type: BLOCKER_NOT_ENOUGH_CLASSES, have: 0, need: 2 },
    ]);
});

test('one ready class: class-count blocker only', () => {
    const blockers = getTrainingBlockers([ready('Gato')]);
    assert.equal(blockers.length, 1);
    assert.equal(blockers[0].type, BLOCKER_NOT_ENOUGH_CLASSES);
    assert.equal(blockers[0].have, 1);
});

test('empty and blank names are missing', () => {
    for (const name of ['', '   ', undefined, null, 42]) {
        const blockers = getTrainingBlockers([ready('Gato'), { name, count: 8 }]);
        assert.deepEqual(blockers, [{ type: BLOCKER_MISSING_NAME, classIndex: 1 }], String(name));
    }
});

test('insufficient samples reports have and need, with the name', () => {
    const blockers = getTrainingBlockers([ready('Gato'), { name: 'Perro', count: 3 }]);
    assert.deepEqual(blockers, [{
        type: BLOCKER_NOT_ENOUGH_SAMPLES, classIndex: 1, name: 'Perro', have: 3, need: 8,
    }]);
});

test('unnamed class with few samples: both blockers, name first', () => {
    const blockers = getTrainingBlockers([ready('Gato'), { name: '', count: 2 }]);
    assert.deepEqual(blockers.map(b => b.type), [BLOCKER_MISSING_NAME, BLOCKER_NOT_ENOUGH_SAMPLES]);
    assert.equal(blockers[1].name, '');
});

test('an extra incomplete class blocks training (unified rule, audio included)', () => {
    const blockers = getTrainingBlockers([ready('A'), ready('B'), { name: 'C', count: 7 }]);
    assert.equal(blockers.length, 1);
    assert.equal(blockers[0].classIndex, 2);
});

test('order: class-count first, then per class in class order', () => {
    const blockers = getTrainingBlockers([{ name: '', count: 0 }]);
    assert.deepEqual(blockers.map(b => b.type), [
        BLOCKER_NOT_ENOUGH_CLASSES, BLOCKER_MISSING_NAME, BLOCKER_NOT_ENOUGH_SAMPLES,
    ]);
});

test('invalid counts count as zero', () => {
    for (const count of [undefined, null, NaN, Infinity, -3, '8']) {
        const [b] = getTrainingBlockers([ready('A'), { name: 'B', count }]);
        assert.equal(b.type, BLOCKER_NOT_ENOUGH_SAMPLES, String(count));
        assert.equal(b.have, 0, String(count));
    }
});

test('sparse arrays: holes are classes with nothing', () => {
    const classes = [ready('A'), , ready('C')]; // eslint-disable-line no-sparse-arrays
    const blockers = getTrainingBlockers(classes);
    assert.deepEqual(blockers.map(b => [b.type, b.classIndex]), [
        [BLOCKER_MISSING_NAME, 1], [BLOCKER_NOT_ENOUGH_SAMPLES, 1],
    ]);
});

test('non-array input is treated as no classes', () => {
    for (const value of [undefined, null, {}, 'abc']) {
        assert.equal(getTrainingBlockers(value)[0].type, BLOCKER_NOT_ENOUGH_CLASSES);
    }
});

test('getBlockedClassIndices collects class indices only', () => {
    const blockers = getTrainingBlockers([{ name: '', count: 0 }]);
    assert.deepEqual([...getBlockedClassIndices(blockers)], [0]);
});

test('formatBlocker texts', () => {
    assert.equal(
        formatBlocker({ type: BLOCKER_NOT_ENOUGH_CLASSES, have: 1, need: 2 }),
        'Se necesitan al menos 2 clases (hay 1).',
    );
    assert.equal(
        formatBlocker({ type: BLOCKER_MISSING_NAME, classIndex: 2 }),
        'La clase 3 no tiene nombre.',
    );
    assert.equal(
        formatBlocker({ type: BLOCKER_NOT_ENOUGH_SAMPLES, classIndex: 0, name: 'Gato', have: 3, need: 8 }),
        '«Gato» tiene 3 muestras: faltan al menos 5.',
    );
    assert.equal(
        formatBlocker({ type: BLOCKER_NOT_ENOUGH_SAMPLES, classIndex: 1, name: '', have: 1, need: 8 }),
        'La clase 2 tiene 1 muestra: faltan al menos 7.',
    );
    assert.equal(formatBlocker({ type: 'unknown' }), '');
});

test('classesSignature: same state, same signature', () => {
    const a = [{ name: 'Gato', count: 8 }, { name: 'Perro', count: 9 }];
    const b = [{ name: 'Gato', count: 8 }, { name: 'Perro', count: 9 }];
    assert.equal(classesSignature(a), classesSignature(b));
});

test('classesSignature changes with a rename, a count, a new class or an order swap', () => {
    const base = classesSignature([{ name: 'Gato', count: 8 }, { name: 'Perro', count: 9 }]);
    const variants = [
        [{ name: 'Gata', count: 8 }, { name: 'Perro', count: 9 }],
        [{ name: 'Gato', count: 9 }, { name: 'Perro', count: 9 }],
        [{ name: 'Gato', count: 8 }, { name: 'Perro', count: 9 }, { name: '', count: 0 }],
        [{ name: 'Gato', count: 8 }],
        [{ name: 'Perro', count: 9 }, { name: 'Gato', count: 8 }],
    ];
    for (const classes of variants) {
        assert.notEqual(classesSignature(classes), base, JSON.stringify(classes));
    }
});

test('classesSignature: separators inside a name cannot forge a collision', () => {
    assert.notEqual(
        classesSignature([{ name: 'a|b', count: 1 }, { name: 'c', count: 1 }]),
        classesSignature([{ name: 'a', count: 1 }, { name: 'b|c', count: 1 }]),
    );
    assert.notEqual(
        classesSignature([{ name: 'a:1:b', count: 1 }]),
        classesSignature([{ name: 'a', count: 1 }, { name: 'b', count: 1 }]),
    );
});

test('classesSignature tolerates junk the same way the blockers do', () => {
    assert.equal(classesSignature(undefined), '');
    assert.equal(classesSignature('abc'), '');
    assert.equal(
        classesSignature([{ name: null, count: NaN }]),
        classesSignature([{ name: '', count: 0 }]),
    );
});

test('hasUntrainedChanges: no signature means unknown, never warn', () => {
    const classes = [{ name: 'Gato', count: 8 }];
    for (const signature of [null, undefined, '', 42, {}]) {
        assert.equal(hasUntrainedChanges(signature, classes), false, String(signature));
    }
});

test('hasUntrainedChanges: true only when the state moved', () => {
    const classes = [{ name: 'Gato', count: 8 }, { name: 'Perro', count: 8 }];
    const trained = classesSignature(classes);
    assert.equal(hasUntrainedChanges(trained, classes), false);
    assert.equal(
        hasUntrainedChanges(trained, [{ name: 'Gato', count: 8 }, { name: 'Perro', count: 12 }]),
        true,
    );
    assert.equal(
        hasUntrainedChanges(trained, [...classes, { name: '', count: 0 }]),
        true,
    );
});

test('classNamesDiverged: unknown trained list never diverges', () => {
    const classes = [{ name: 'Gato' }, { name: 'Perro' }];
    for (const trained of [null, undefined, [], 'Gato', {}]) {
        assert.equal(classNamesDiverged(trained, classes), false, String(trained));
    }
});

test('classNamesDiverged: same names in the same order do not diverge', () => {
    assert.equal(
        classNamesDiverged(['Gato', 'Perro'], [{ name: 'Gato', count: 3 }, { name: 'Perro', count: 99 }]),
        false,
    );
});

test('classNamesDiverged: adding, deleting, renaming or reordering diverges', () => {
    const trained = ['Gato', 'Perro'];
    const variants = [
        [{ name: 'Gato' }, { name: 'Perro' }, { name: '' }],
        [{ name: 'Gato' }],
        [{ name: 'Gata' }, { name: 'Perro' }],
        [{ name: 'Perro' }, { name: 'Gato' }],
        [],
    ];
    for (const classes of variants) {
        assert.equal(classNamesDiverged(trained, classes), true, JSON.stringify(classes));
    }
});

test('classNamesDiverged: a non-string name diverges from a real one', () => {
    assert.equal(classNamesDiverged(['Gato'], [{ name: null }]), true);
    assert.equal(classNamesDiverged([''], [{ name: '' }]), false);
});

test('classNamesDiverged is blind to sample counts, hasUntrainedChanges is not', () => {
    const trained = ['Gato', 'Perro'];
    const classes = [{ name: 'Gato', count: 40 }, { name: 'Perro', count: 8 }];
    assert.equal(classNamesDiverged(trained, classes), false);
    const signature = classesSignature([{ name: 'Gato', count: 8 }, { name: 'Perro', count: 8 }]);
    assert.equal(hasUntrainedChanges(signature, classes), true);
});

test('hasEnoughSamples: completa exactamente en el mínimo', () => {
    assert.equal(hasEnoughSamples(MIN_SAMPLES_PER_CLASS - 1), false);
    assert.equal(hasEnoughSamples(MIN_SAMPLES_PER_CLASS), true);
    assert.equal(hasEnoughSamples(MIN_SAMPLES_PER_CLASS + 5), true);
});

test('hasEnoughSamples: los conteos inválidos no están completos', () => {
    for (const count of [0, undefined, null, NaN, -8, '8', Infinity]) {
        assert.equal(hasEnoughSamples(count), false, String(count));
    }
});

// El indicador verde y el panel de motivos no pueden contradecirse: si el badge
// está verde, el panel no puede decir que a esa clase le faltan muestras.
test('hasEnoughSamples coincide con getTrainingBlockers', () => {
    for (let count = 0; count <= MIN_SAMPLES_PER_CLASS + 1; count++) {
        const blockers = getTrainingBlockers([
            { name: 'A', count: MIN_SAMPLES_PER_CLASS },
            { name: 'B', count },
        ]);
        const blocksOnSamples = blockers.some(
            b => b.type === BLOCKER_NOT_ENOUGH_SAMPLES && b.classIndex === 1,
        );
        assert.equal(hasEnoughSamples(count), !blocksOnSamples, String(count));
    }
});

test('normalizeSampleCount: entero, nunca negativo, cero ante basura', () => {
    assert.equal(normalizeSampleCount(8), 8);
    assert.equal(normalizeSampleCount(8.7), 8);
    for (const count of [0, undefined, null, NaN, -8, '8', Infinity]) {
        assert.equal(normalizeSampleCount(count), 0, String(count));
    }
});

// El indicador pinta el número que devuelve el normalizador, no el crudo: si
// discreparan, podría verse "8 muestras" en gris.
test('normalizeSampleCount y hasEnoughSamples no pueden discrepar', () => {
    for (const count of [7, 8, 8.9, '8', NaN, -1, undefined]) {
        assert.equal(
            hasEnoughSamples(count),
            normalizeSampleCount(count) >= MIN_SAMPLES_PER_CLASS,
            String(count),
        );
    }
});
