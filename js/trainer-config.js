/**
 * trainer-config.js
 * Configuration table encoding the UI/behavior differences per trainer type.
 * No logic, no imports — pure data.
 *
 * `defaultClasses` son las clases con las que nace un proyecto. Nacen SIN
 * nombre (`''`), igual que las que crea el botón "Nueva clase": el input
 * muestra UNNAMED_CLASS_LABEL como texto guía y la docente escribe el suyo sin
 * tener que borrar nada. La excepción es la primera clase de audio, que lleva
 * el nombre fijo de `fixedFirstClass` porque speech-commands exige una clase de
 * ruido de fondo y su input va deshabilitado.
 */

const ICON_CAMERA = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><circle cx="12" cy="10" r="3"/></svg>';

const ICON_MIC = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>';

/**
 * El nombre de la clase de ruido de fondo, en un solo lugar.
 *
 * Aparece en `fixedFirstClass` (lo que muestra el input deshabilitado) y en
 * `defaultClasses[0]` (con lo que se crea la clase). En audio el nombre ES la
 * clave con la que speech-commands indexa las muestras, así que si los dos
 * literales se separaran —una tilde, una reescritura— la tarjeta mostraría un
 * nombre y el recognizer indexaría con otro, sin ningún error. Un test en
 * `tests/trainer-config.test.js` ata la relación.
 */
const NOISE_CLASS = 'Ruido de fondo';

export const TRAINER_CONFIGS = {
    image: {
        captureMode: 'webcam',
        captureOneLabel: 'Capturar',
        captureHoldLabel: 'Grabar',
        captureIcon: ICON_CAMERA,
        fixedFirstClass: null,
        showProgressBar: true,
        renameRequiresTryCatch: false,
        captureOneFailMessage: null,
        defaultClasses: ['', ''],
    },
    pose: {
        captureMode: 'webcam-skeleton',
        captureOneLabel: 'Capturar',
        captureHoldLabel: 'Grabar',
        captureIcon: ICON_CAMERA,
        fixedFirstClass: null,
        showProgressBar: true,
        renameRequiresTryCatch: false,
        captureOneFailMessage: 'No se detectó pose. Asegurate de estar visible en la cámara.',
        defaultClasses: ['', ''],
    },
    audio: {
        captureMode: 'audio',
        captureOneLabel: 'Grabar',
        captureHoldLabel: 'Grabar 10 muestras',
        captureIcon: ICON_MIC,
        fixedFirstClass: NOISE_CLASS,
        showProgressBar: true,
        renameRequiresTryCatch: true,
        captureOneFailMessage: null,
        defaultClasses: [NOISE_CLASS, '', ''],
    },
};

/**
 * La config de un tipo de proyecto, con `image` como fallback.
 *
 * El guard de propiedad propia no es decorativo: `projectType` sale del
 * registro del proyecto, o sea de localStorage. Sin él, un `projectType` de
 * `'constructor'` o `'toString'` devuelve algo heredado de `Object.prototype`
 * —truthy, y por lo tanto ganador del `||`— y el resto del código trabaja con
 * un objeto que no es una config. Mismo criterio que los mapas de despacho de
 * `project-schema.js`.
 */
export function getConfig(projectType) {
    return Object.prototype.hasOwnProperty.call(TRAINER_CONFIGS, projectType)
        ? TRAINER_CONFIGS[projectType]
        : TRAINER_CONFIGS.image;
}
