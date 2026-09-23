/**
 * audio-trainer.js
 * Transfer learning module for audio/speech commands.
 * Wrapper around the speech-commands library's transfer learning API.
 *
 * speechCommands is a global loaded via <script> in index.html.
 */

import { isValidSpectrogram } from './sanitize.js';
import { SAMPLES_DB_NAME, SAMPLES_DB_VERSION, SAMPLES_STORE, audioSamplesKey, audioModelKey } from './storage-keys.js';

// Base recognizer (pre-trained speech commands model)
let baseRecognizer = null;

// Transfer recognizer (custom classes)
let transfer = null;

// Name given to the current transfer recognizer. Tracked here because
// createTransfer() registers it in baseRecognizer.transferRecognizers and the
// library exposes no way to look the name back up or to unregister it.
let transferName = null;
let transferSeq = 0;

// Class names tracked separately
let classNames = [];

// Spectrogram thumbnails by class name
let classThumbs = {};

// Recording state
let isRecording = false;

// Prediction
let predictionCallback = null;

// Base model, self-hosted in vendor/. See docs/ARQUITECTURA.md.
// Both URLs are absolute and anchored to this module's own location: the
// library's metadata loader only accepts http://, https:// or file:// and
// throws on a relative path, and anchoring to import.meta.url (rather than to
// the document) keeps them correct no matter which path the document was
// served from — offline, the Service Worker answers any same-origin
// navigation with the app shell, in the .catch() branch of network-first.
// Hardcoding an absolute URL is not an option: the app may be served from the
// root of an origin or from a subpath, and the path has to resolve correctly
// either way.
const SPEECH_MODEL_URL = new URL(
    '../vendor/speech-commands/browser_fft/18w/model.json',
    import.meta.url
).href;
const SPEECH_METADATA_URL = new URL(
    '../vendor/speech-commands/browser_fft/18w/metadata.json',
    import.meta.url
).href;

// Audio visualizer state
let audioContext = null;
let analyser = null;
let micStream = null;
let visualizerRunning = false;
let vizCanvas = null;

// ============================================
// SPECTROGRAM THUMBNAIL
// ============================================

function generateSpectrogramThumb(spectrogramData, frameSize) {
    const numFrames = spectrogramData.length / frameSize;

    const c = document.createElement('canvas');
    c.width = numFrames;
    c.height = frameSize;
    const ctx = c.getContext('2d');
    const imgData = ctx.createImageData(numFrames, frameSize);

    let min = Infinity, max = -Infinity;
    for (let i = 0; i < spectrogramData.length; i++) {
        if (spectrogramData[i] < min) min = spectrogramData[i];
        if (spectrogramData[i] > max) max = spectrogramData[i];
    }
    const range = max - min || 1;

    for (let frame = 0; frame < numFrames; frame++) {
        for (let bin = 0; bin < frameSize; bin++) {
            const val = spectrogramData[frame * frameSize + bin];
            const norm = (val - min) / range;
            const brightness = Math.floor(norm * 255);

            const y = frameSize - 1 - bin;
            const idx = (y * numFrames + frame) * 4;

            imgData.data[idx]     = 0;
            imgData.data[idx + 1] = Math.floor(brightness * 0.62);
            imgData.data[idx + 2] = Math.floor(brightness * 0.58);
            imgData.data[idx + 3] = 255;
        }
    }

    ctx.putImageData(imgData, 0, 0);

    const thumb = document.createElement('canvas');
    thumb.width = 80;
    thumb.height = 60;
    thumb.getContext('2d').drawImage(c, 0, 0, 80, 60);

    return thumb.toDataURL('image/png');
}

/**
 * Rebuild classThumbs from the examples the transfer recognizer currently
 * holds. Spectrograms are validated because they may have been rehydrated
 * from IndexedDB, which this project treats as user input: a corrupt
 * frameSize would size the canvas invalidly and throw mid-render, leaving the
 * training screen half-drawn.
 */
function rebuildThumbs() {
    classThumbs = {};
    for (const name of classNames) {
        // getExamples() tira cuando la palabra no tiene ejemplos, que es un
        // estado legítimo: una clase todavía sin grabar, o —desde que una clase
        // nace sin nombre— la clase vacía que la docente acaba de crear. Sin
        // este try/catch, una sola clase vacía abortaba el rebuild entero y el
        // proyecto se abría sin ninguna miniatura. Mismo motivo que el
        // try/catch de clearSamples().
        let examples;
        try {
            examples = transfer.getExamples(name);
        } catch (e) {
            continue;
        }
        if (!examples || examples.length === 0) continue;
        classThumbs[name] = examples
            .filter(ex => ex && ex.example && isValidSpectrogram(ex.example.spectrogram))
            .map(ex => generateSpectrogramThumb(
                ex.example.spectrogram.data,
                ex.example.spectrogram.frameSize
            ));
    }
}

// ============================================
// INIT
// ============================================

/**
 * Create a transfer recognizer on the cached base and remember its name.
 */
function newTransfer() {
    // This name is in-memory only: it keys the recognizer inside the library's
    // own baseRecognizer.transferRecognizers registry. It is NOT a persisted
    // key, which is why it does not come from storage-keys.js. It would become
    // one if save()/load() were ever called without an explicit URL — the
    // library then derives its own storage location from the name — so don't.
    //
    // Counter, not just Date.now(): createTransfer() throws if the name is
    // already registered, and now that the registry outlives the screen two
    // creates in the same millisecond would collide.
    transferName = 'ml-audio-transfer-' + Date.now() + '-' + (++transferSeq);
    return baseRecognizer.createTransfer(transferName);
}

/**
 * Drop the current transfer recognizer, unregistering it from the base.
 * createTransfer() stores every recognizer it creates in
 * baseRecognizer.transferRecognizers and offers no removal API. Since
 * baseRecognizer now outlives the screen, skipping this would pile up a full
 * transfer recognizer — with its collected spectrograms — on every open.
 */
function releaseTransfer() {
    if (transferName && baseRecognizer && baseRecognizer.transferRecognizers) {
        delete baseRecognizer.transferRecognizers[transferName];
    }
    transferName = null;
    transfer = null;
}

async function initTrainer() {
    if (baseRecognizer) {
        // Base model kept from a previous screen: only the head is missing.
        if (!transfer) transfer = newTransfer();
        return;
    }

    const recognizer = speechCommands.create(
        'BROWSER_FFT',
        undefined,
        SPEECH_MODEL_URL,
        SPEECH_METADATA_URL
    );
    await recognizer.ensureModelLoaded();

    // Publish only once the weights are in: assigning before the await would
    // leave baseRecognizer non-null with no model behind it, and the guard
    // above would then treat every later call as a no-op success.
    baseRecognizer = recognizer;
    transfer = newTransfer();

    console.log('Audio trainer ready');
}

// ============================================
// CLASS MANAGEMENT
// ============================================

function addClass(name) {
    classNames.push(name);
    return classNames.length - 1;
}

function removeClass(index) {
    const name = classNames[index];
    delete classThumbs[name];
    classNames.splice(index, 1);
}

function renameClass(index, newName) {
    const oldName = classNames[index];
    let counts = {};
    try { counts = transfer.countExamples(); } catch (e) {}
    if (counts[oldName] && counts[oldName] > 0) {
        throw new Error('No se puede renombrar una clase con muestras. Borrá las muestras primero.');
    }
    classNames[index] = newName;
}

/**
 * Clears the samples of ONE class.
 *
 * speech-commands' clearExamples() takes no arguments and wipes the whole
 * transfer dataset: the library keeps a single word -> examples map and its
 * public clearing API operates on all of it. Calling it here is what used to
 * delete every class's samples — a per-class button wired to a global method.
 *
 * removeExample(uid) does support per-example removal, and deleteSample() in
 * this file already uses it, so clearing one class is that in a loop.
 *
 * The uids are collected BEFORE removing any: getExamples() reflects the live
 * dataset, and removing while iterating shifts the indices underneath.
 */
function clearSamples(index) {
    const name = classNames[index];
    if (!name) return;

    let uids = [];
    try {
        // getExamples() throws when the word has no examples collected at all,
        // which is a legitimate state (a class the user never recorded into).
        uids = (transfer.getExamples(name) || []).map(e => e.uid);
    } catch (e) {
        classThumbs[name] = [];
        return;
    }

    for (const uid of uids) {
        try {
            transfer.removeExample(uid);
        } catch (e) {
            // Un fallo suelto no puede abortar el resto: dejaría la clase a
            // medio limpiar y los thumbs desalineados con el dataset real.
            console.warn('removeExample error:', e);
        }
    }

    classThumbs[name] = [];
}

function getSamples(classIndex) {
    const name = classNames[classIndex];
    const thumbs = classThumbs[name] || [];
    return thumbs.map((thumb, i) => ({ index: i, thumb }));
}

function deleteSample(classIndex, sampleIndex) {
    const name = classNames[classIndex];
    const examples = transfer.getExamples(name);
    if (examples && examples[sampleIndex]) {
        try {
            transfer.removeExample(examples[sampleIndex].uid);
        } catch (e) {
            console.warn('removeExample error:', e);
        }
    }
    if (classThumbs[name]) {
        classThumbs[name].splice(sampleIndex, 1);
    }
}

function getClasses() {
    let counts = {};
    try { counts = transfer.countExamples(); } catch (e) {}
    return classNames.map(name => ({
        name,
        count: counts[name] || 0
    }));
}

function getClassNames() {
    return [...classNames];
}

function getTotalClasses() {
    return classNames.length;
}

// ============================================
// CAPTURE
// ============================================

/**
 * Record one audio sample for a class (~1 second).
 * Returns a Promise that resolves when done.
 */
async function recordSample(classIndex) {
    if (isRecording) return;
    const name = classNames[classIndex];
    isRecording = true;

    const wasListening = isListening();
    if (wasListening) stopListening();

    try {
        await transfer.collectExample(name);
        const examples = transfer.getExamples(name);
        const last = examples[examples.length - 1];
        const thumb = generateSpectrogramThumb(
            last.example.spectrogram.data,
            last.example.spectrogram.frameSize
        );
        if (!classThumbs[name]) classThumbs[name] = [];
        classThumbs[name].push(thumb);
    } finally {
        isRecording = false;
        if (wasListening && predictionCallback) {
            try {
                await startListening(predictionCallback);
            } catch (e) {
                console.warn('Could not resume listening:', e);
            }
        }
    }
}

function getIsRecording() {
    return isRecording;
}

// ============================================
// TRAINING
// ============================================

async function train(onProgress) {
    let counts = {};
    try { counts = transfer.countExamples(); } catch (e) {}

    const classesWithSamples = classNames.filter(n => (counts[n] || 0) >= 8);
    if (classesWithSamples.length < 2) {
        throw new Error('Se necesitan al menos 2 clases con 8+ muestras cada una');
    }

    // Serialize current samples, recreate transfer recognizer fresh,
    // and reload samples. This avoids the "trainable" error that occurs
    // when trying to retrain after transfer.load() corrupted internal state.
    const serialized = transfer.serializeExamples();
    releaseTransfer();
    transfer = newTransfer();
    transfer.loadExamples(serialized, false);

    // Regenerate thumbnails since transfer was recreated
    rebuildThumbs();

    const totalEpochs = 50;
    await transfer.train({
        epochs: totalEpochs,
        callback: {
            onEpochEnd: (epoch, logs) => {
                if (onProgress) onProgress(epoch, totalEpochs, logs);
            }
        }
    });

    return { epochs: totalEpochs };
}

// ============================================
// PREDICTION
// ============================================

/**
 * Start listening for predictions.
 * callback receives [{className, probability}] on each result.
 */
async function startListening(callback) {
    if (!transfer) return;
    predictionCallback = callback;

    await transfer.listen(result => {
        // Use transfer.wordLabels() for label mapping — scores are in
        // alphabetical order matching wordLabels, not classNames order.
        const labels = transfer.wordLabels();  // orden correcto (alfabético)
        const scores = Array.from(result.scores);
        const predictions = scores.map((score, i) => ({
            className: labels[i],     
            probability: score
        }));

        if (predictionCallback) predictionCallback(predictions);
    }, {
        probabilityThreshold: 0.3,
        invokeCallbackOnNoiseAndUnknown: true,
        overlapFactor: 0.5
    });
}

function stopListening() {
    predictionCallback = null;
    try {
        if (transfer && transfer.isListening()) {
            transfer.stopListening();
        }
    } catch (e) {
        console.warn('stopListening error:', e);
    }
}

function isListening() {
    try {
        return transfer ? transfer.isListening() : false;
    } catch (e) {
        return false;
    }
}

// ============================================
// AUDIO VISUALIZER
// ============================================

async function startVisualizer(canvasElement) {
    stopVisualizer();
    vizCanvas = canvasElement;

    try {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        analyser = audioContext.createAnalyser();
        analyser.fftSize = 2048;
        const source = audioContext.createMediaStreamSource(micStream);
        source.connect(analyser);
        visualizerRunning = true;
        drawVisualizer();
    } catch (e) {
        console.warn('Could not start audio visualizer:', e);
    }
}

function drawVisualizer() {
    if (!visualizerRunning || !analyser || !vizCanvas) return;

    const ctx = vizCanvas.getContext('2d');
    const w = vizCanvas.width;
    const h = vizCanvas.height;
    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    analyser.getByteFrequencyData(dataArray);

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);

    const barCount = 32;
    const barWidth = (w / barCount) * 0.9;
    const barGap = (w / barCount) * 0.1;
    const borderRadius = Math.max(1, barWidth / 2);
    const centerY = h / 2;

    ctx.strokeStyle = '#e0e0e0';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(barGap / 2, centerY);
    ctx.lineTo(w - barGap / 2, centerY);
    ctx.stroke();

    const binFrequency = 22050 / bufferLength;
    const logMin = Math.log10(80);
    const logMax = Math.log10(4000);

    const barValues = [];
    for (let i = 0; i < barCount; i++) {
        const freqStart = Math.pow(10, logMin + (i / barCount) * (logMax - logMin));
        const freqEnd = Math.pow(10, logMin + ((i + 1) / barCount) * (logMax - logMin));
        const start = Math.max(0, Math.floor(freqStart / binFrequency));
        const end = Math.min(bufferLength - 1, Math.floor(freqEnd / binFrequency));
        let sum = 0, count = 0;
        for (let j = start; j <= end; j++) { sum += dataArray[j]; count++; }
        barValues.push(count > 0 ? sum / count : 0);
    }

    const threshold = 40;
    const half = barCount / 2;
    for (let i = 0; i < barCount; i++) {
        const freqIndex = i < half ? half - 1 - i : i - half;
        const average = barValues[freqIndex];
        const gated = average > threshold ? average - threshold : 0;
        const fullBarHeight = (gated / (255 - threshold)) * h * 0.65;
        const halfBarHeight = fullBarHeight / 2;
        const x = i * (barWidth + barGap) + barGap / 2;

        drawRoundedBar(ctx, x, centerY - halfBarHeight, barWidth, halfBarHeight, borderRadius, true);
        drawRoundedBar(ctx, x, centerY, barWidth, halfBarHeight, borderRadius, false);
    }

    requestAnimationFrame(drawVisualizer);
}

function drawRoundedBar(ctx, x, y, width, height, radius, isUp) {
    if (height < 2) return;
    const gradient = ctx.createLinearGradient(0, y, 0, y + height);
    gradient.addColorStop(0, '#009f95');
    gradient.addColorStop(1, '#4169B8');
    ctx.fillStyle = gradient;
    ctx.beginPath();
    if (isUp) {
        ctx.moveTo(x, y + height);
        ctx.lineTo(x, y + radius);
        ctx.arcTo(x, y, x + width, y, radius);
        ctx.lineTo(x + width, y + radius);
        ctx.arcTo(x + width, y, x + width, y + height, radius);
        ctx.lineTo(x + width, y + height);
    } else {
        ctx.moveTo(x, y);
        ctx.lineTo(x, y + height - radius);
        ctx.arcTo(x, y + height, x + width, y + height, radius);
        ctx.lineTo(x + width, y + height - radius);
        ctx.arcTo(x + width, y + height, x + width, y, radius);
        ctx.lineTo(x + width, y);
    }
    ctx.closePath();
    ctx.fill();
}

function stopVisualizer() {
    visualizerRunning = false;
    vizCanvas = null;
    if (audioContext) {
        audioContext.close().catch(() => {});
        audioContext = null;
    }
    analyser = null;
    if (micStream) {
        micStream.getTracks().forEach(t => t.stop());
        micStream = null;
    }
}

// ============================================
// PERSISTENCE
// ============================================

function idbOpen() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(SAMPLES_DB_NAME, SAMPLES_DB_VERSION);
        req.onupgradeneeded = e => {
            const db = e.target.result;
            // Idempotent on purpose: on a future version bump this handler runs
            // again against a database that already has the store, where
            // createObjectStore() would throw ConstraintError.
            if (!db.objectStoreNames.contains(SAMPLES_STORE)) {
                db.createObjectStore(SAMPLES_STORE);
            }
        };
        // On a version bump, another tab holding an open connection makes the
        // request fire 'blocked' instead of 'success' or 'error'. Without this
        // the promise never settles and the screen hangs with no message —
        // the same class of failure centralizing SAMPLES_DB_VERSION exists to
        // prevent, from the other side.
        req.onblocked = () => reject(new Error('IndexedDB upgrade blocked by another open tab'));
        req.onsuccess = e => resolve(e.target.result);
        req.onerror = () => reject(req.error);
    });
}

async function idbPut(key, value) {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(SAMPLES_STORE, 'readwrite');
        tx.objectStore(SAMPLES_STORE).put(value, key);
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => { db.close(); reject(tx.error); };
    });
}

async function idbGet(key) {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(SAMPLES_STORE, 'readonly');
        const req = tx.objectStore(SAMPLES_STORE).get(key);
        req.onsuccess = () => { db.close(); resolve(req.result); };
        req.onerror = () => { db.close(); reject(req.error); };
    });
}

async function idbDelete(key) {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(SAMPLES_STORE, 'readwrite');
        tx.objectStore(SAMPLES_STORE).delete(key);
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => { db.close(); reject(tx.error); };
    });
}

async function saveModel(projectId) {
    const storageKey = audioModelKey(projectId);
    let saved = false;

    // Try transfer.save() directly (may exist on some builds)
    if (typeof transfer.save === 'function') {
        try {
            await transfer.save('indexeddb://' + storageKey);
            saved = true;
        } catch (e) {
            console.warn('transfer.save failed:', e);
        }
    }

    // Fall back to accessing the internal model property
    if (!saved) {
        const internalModel = transfer.model || transfer.transferModel;
        if (internalModel && typeof internalModel.save === 'function') {
            try {
                await internalModel.save('indexeddb://' + storageKey);
                saved = true;
            } catch (e) {
                console.warn('model.save failed:', e);
            }
        }
    }

    if (!saved) {
        console.warn('Audio model weights could not be saved. Samples are saved separately.');
    }

    return {
        source: 'local-audio',
        storageKey,
        classNames: [...classNames],
        trainedAt: new Date().toISOString()
    };
}

async function loadSavedModel(localModelInfo) {
    await initTrainer();
    classNames = [...localModelInfo.classNames];

    // Try transfer.load() directly
    if (typeof transfer.load === 'function') {
        await transfer.load('indexeddb://' + localModelInfo.storageKey);
        // load() restaura las etiquetas SOLO cuando se lo llama sin URL: con una
        // URL explícita se salta el bloque que lee los metadatos y deja
        // `words` como esté. Sin esto, listen() etiqueta los scores con el
        // vocabulario VIVO del dataset, que ya no tiene por qué coincidir con
        // el orden de salidas del modelo — y la placa recibe el nombre de otra
        // clase. Mismo restore que hace la rama de fallback de abajo.
        restoreWordLabels();
        return;
    }

    // Fall back: load TF.js model and inject into transfer recognizer
    const loadedModel = await tf.loadLayersModel('indexeddb://' + localModelInfo.storageKey);

    let injected = false;
    for (const prop of ['model', 'transferModel']) {
        if (prop in transfer) {
            transfer[prop] = loadedModel;
            injected = true;
            break;
        }
    }

    restoreWordLabels();

    if (!injected) {
        throw new Error('No se pudo restaurar el modelo de audio');
    }
}

/**
 * Restaura las etiquetas con las que listen() mapea los scores del modelo.
 *
 * Ordenadas: speech-commands indexa las salidas por el vocabulario ordenado
 * (`getVocabulary()` hace `sort()`), así que este es el orden con el que se
 * entrenó, no el de inserción de `classNames`.
 */
function restoreWordLabels() {
    for (const prop of ['words', 'words_', 'wordList_']) {
        if (prop in transfer) {
            transfer[prop] = [...classNames].sort();
            return;
        }
    }
}

async function saveSamples(projectId) {
    // countExamples() es la fuente de verdad del recognizer y tira cuando el
    // dataset esta vacio, que es justamente el caso que hay que distinguir.
    let total = 0;
    try {
        const counts = transfer.countExamples();
        total = Object.values(counts).reduce((sum, n) => sum + n, 0);
    } catch (e) {
        total = 0;
    }

    // Sin ejemplos se borra la clave, no se deja la version anterior: con
    // guardado automatico lo guardado tiene que reflejar lo que hay en memoria.
    if (total === 0) {
        await idbDelete(audioSamplesKey(projectId));
        return;
    }

    let serialized;
    try {
        serialized = transfer.serializeExamples();
    } catch (e) {
        // Hay ejemplos contados pero la serializacion fallo: no se toca lo
        // guardado, que es mejor que reemplazarlo por nada.
        console.warn('No se pudieron serializar las muestras de audio:', e);
        return;
    }
    await idbPut(audioSamplesKey(projectId), serialized);
}

async function loadSamples(projectId) {
    const serialized = await idbGet(audioSamplesKey(projectId));
    if (!serialized) return 0;
    try {
        transfer.loadExamples(serialized, false);
    } catch (e) {
        console.warn('Could not load audio samples:', e);
        return 0;
    }

    try {
        rebuildThumbs();
    } catch (e) {
        console.warn('Could not rebuild audio thumbnails:', e);
    }

    try {
        const counts = transfer.countExamples();
        return Object.values(counts).reduce((sum, n) => sum + n, 0);
    } catch (e) {
        return 0;
    }
}

async function deleteModel(storageKey) {
    try {
        await tf.io.removeModel('indexeddb://' + storageKey);
    } catch (e) {
        console.warn('Could not remove audio model:', e);
    }
}

async function deleteSamplesDB(projectId) {
    await idbDelete(audioSamplesKey(projectId));
}

// ============================================
// CLEANUP
// ============================================

function isTrained() {
    try {
        // After training, wordLabels() returns custom class names.
        // After model injection, we check if classNames are populated.
        const labels = transfer ? transfer.wordLabels() : null;
        if (Array.isArray(labels) && labels.length > 0) return true;
        // Also check if we have classNames and a model was injected
        return classNames.length > 0 &&
               !!(transfer && (transfer.model || transfer.transferModel));
    } catch {
        return false;
    }
}

function dispose() {
    stopListening();
    stopVisualizer();

    releaseTransfer();
    classNames = [];
    classThumbs = {};
    isRecording = false;
    predictionCallback = null;

    // baseRecognizer se mantiene vivo a propósito: son 5,9 MB de pesos y
    // dispose() corre en TODA transición de pantalla (también al abrir
    // proyectos de imagen o pose). Mismo criterio que poseLandmarker en
    // pose-trainer.js. Sus tensores no se liberan porque el modelo de transfer
    // comparte capas con el base: disponer uno dejaría al otro con tensores
    // muertos.
}

export {
    initTrainer,
    addClass, removeClass, renameClass,
    clearSamples, getClasses, getClassNames, getTotalClasses,
    getSamples, deleteSample,
    recordSample,
    getIsRecording,
    train,
    startListening, stopListening, isListening,
    startVisualizer, stopVisualizer,
    saveModel, loadSavedModel, deleteModel,
    saveSamples, loadSamples, deleteSamplesDB,
    isTrained, dispose
};
