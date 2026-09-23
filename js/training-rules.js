// Pure training-readiness rules. No browser APIs; importable from node:test.
// Single source for the training minimums and for the user-facing
// explanation of why a model cannot be trained yet.

export const MIN_CLASSES = 2;
export const MIN_SAMPLES_PER_CLASS = 8;

export const BLOCKER_NOT_ENOUGH_CLASSES = 'not-enough-classes';
export const BLOCKER_MISSING_NAME = 'missing-name';
export const BLOCKER_NOT_ENOUGH_SAMPLES = 'not-enough-samples';

function hasName(name) {
    return typeof name === 'string' && name.trim() !== '';
}

function sampleCount(count) {
    return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

/**
 * Returns every reason that prevents training, in display order:
 * first the class-count blocker, then per class (in class order)
 * missing name before missing samples. Empty array means "can train".
 *
 * @param {Array<{name: string, count: number}>} classes - as returned by trainer.getClasses()
 */
export function getTrainingBlockers(classes) {
    const list = Array.isArray(classes) ? classes : [];
    const blockers = [];

    if (list.length < MIN_CLASSES) {
        blockers.push({ type: BLOCKER_NOT_ENOUGH_CLASSES, have: list.length, need: MIN_CLASSES });
    }

    // Explicit index loop: holes in a sparse array must count as classes
    // with no name and no samples, not be skipped.
    for (let i = 0; i < list.length; i++) {
        const cls = list[i] || {};
        const named = hasName(cls.name);
        if (!named) {
            blockers.push({ type: BLOCKER_MISSING_NAME, classIndex: i });
        }
        const have = sampleCount(cls.count);
        if (have < MIN_SAMPLES_PER_CLASS) {
            blockers.push({
                type: BLOCKER_NOT_ENOUGH_SAMPLES,
                classIndex: i,
                name: named ? cls.name : '',
                have,
                need: MIN_SAMPLES_PER_CLASS,
            });
        }
    }
    return blockers;
}

/**
 * Compact fingerprint of a class list: every name and its sample count.
 *
 * Two states with the same signature would train into the same model, so a
 * difference is exactly "there are changes the trained model has not seen" —
 * a renamed class, a new one, a deleted one, or samples added or removed.
 *
 * Each name is length-prefixed because a class name may legitimately contain
 * the separators (`#`, `"` and `\` are filtered, `|` and `:` are not), and
 * `["a|b", "c"]` must not collide with `["a", "b|c"]`.
 *
 * @param {Array<{name: string, count: number}>} classes - as returned by trainer.getClasses()
 */
export function classesSignature(classes) {
    const list = Array.isArray(classes) ? classes : [];
    const parts = [];
    for (let i = 0; i < list.length; i++) {
        const cls = list[i] || {};
        const name = typeof cls.name === 'string' ? cls.name : '';
        parts.push(`${name.length}:${name}:${sampleCount(cls.count)}`);
    }
    return parts.join('|');
}

/**
 * True when the classes on screen differ from the ones the model was trained
 * on, so going to MakeCode now would show a model that is behind the edits.
 *
 * An absent signature means "unknown" — a project saved before signatures
 * existed — and never warns: crying wolf on every old project would teach the
 * teacher to ignore the message. An empty string is also treated as unknown;
 * a trained model always has at least MIN_CLASSES classes, so no real trained
 * state can produce one.
 *
 * @param {*} trainedSignature - what classesSignature() returned at train time
 * @param {Array<{name: string, count: number}>} classes
 */
export function hasUntrainedChanges(trainedSignature, classes) {
    if (typeof trainedSignature !== 'string' || trainedSignature === '') return false;
    return trainedSignature !== classesSignature(classes);
}

/**
 * True when the class names on screen no longer match, one to one and in
 * order, the ones the model was trained on.
 *
 * This is the divergence that CORRUPTS predictions, and it is categorically
 * worse than a sample count that moved. Every trainer maps output index to
 * label against its live class list, so deleting, adding or renaming a class
 * shifts that mapping: the board would receive the name of a different class,
 * with nothing on screen saying anything is wrong.
 *
 * An empty or absent trained list means "unknown" — a project saved before
 * this was recorded — and never reports divergence, same policy as
 * hasUntrainedChanges().
 *
 * @param {*} trainedNames - the class names the model was trained on
 * @param {Array<{name: string}>} classes - as returned by trainer.getClasses()
 */
export function classNamesDiverged(trainedNames, classes) {
    if (!Array.isArray(trainedNames) || trainedNames.length === 0) return false;
    const list = Array.isArray(classes) ? classes : [];
    if (list.length !== trainedNames.length) return true;
    for (let i = 0; i < list.length; i++) {
        const cls = list[i] || {};
        const name = typeof cls.name === 'string' ? cls.name : '';
        if (name !== trainedNames[i]) return true;
    }
    return false;
}

/** Indices of the classes involved in at least one blocker. */
export function getBlockedClassIndices(blockers) {
    const indices = new Set();
    for (const blocker of blockers) {
        if (Number.isInteger(blocker.classIndex)) indices.add(blocker.classIndex);
    }
    return indices;
}

/**
 * Spanish, user-facing text for one blocker. The result may contain a
 * user-provided class name: insert it with textContent, never innerHTML.
 */
export function formatBlocker(blocker) {
    switch (blocker.type) {
        case BLOCKER_NOT_ENOUGH_CLASSES:
            return `Se necesitan al menos ${blocker.need} clases (hay ${blocker.have}).`;
        case BLOCKER_MISSING_NAME:
            return `La clase ${blocker.classIndex + 1} no tiene nombre.`;
        case BLOCKER_NOT_ENOUGH_SAMPLES: {
            const who = blocker.name
                ? `«${blocker.name}»`
                : `La clase ${blocker.classIndex + 1}`;
            const noun = blocker.have === 1 ? 'muestra' : 'muestras';
            const missing = blocker.need - blocker.have;
            return `${who} tiene ${blocker.have} ${noun}: faltan ${missing}.`;
        }
        default:
            return '';
    }
}
