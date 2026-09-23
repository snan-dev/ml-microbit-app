/**
 * image-trainer.js
 * Transfer learning module: MobileNet feature extractor + trainable head.
 * Handles capture, training, prediction, and IndexedDB persistence.
 */

import { isValidImageSample } from './sanitize.js';
import { SAMPLES_DB_NAME, SAMPLES_DB_VERSION, SAMPLES_STORE, imageSamplesKey, imageModelKey } from './storage-keys.js';

// Feature extractor (truncated MobileNet, immutable)
let featureExtractor = null;
let featureSize = 0; // 12544 for MobileNet v1 alpha=0.25

// Trainable classification head
let head = null;

// Classes and samples
let classes = []; // [{name, samples: [{tensor: Tensor1D, thumb: string}], count}]

/**
 * Los nombres de clase con los que se entrenó el `head` vigente, en el orden
 * en que se entrenó. Es el mapeo salida→etiqueta, y no se toca al editar las
 * clases: solo lo reescriben train() y loadSavedModel().
 *
 * Existe porque el modelo no conoce nombres, solo casilleros de salida
 * numerados, y esa correspondencia queda congelada en los pesos. Etiquetar con
 * `classes` —la lista viva— hace que borrar una clase sin reentrenar corra
 * todos los nombres un lugar, y la placa reciba el de otra clase.
 */
let trainedClassNames = null;

// Capture
let captureIntervalId = null;
let captureCanvas = null; // 224x224 canvas for normalizing input

const MOBILENET_URL = "vendor/mobilenet/v1-0.25-224/model.json";

const TRUNCATION_LAYER = "conv_pw_13_relu";

// ============================================
// INIT
// ============================================

async function initTrainer() {
    if (featureExtractor) return; // already initialized

    const mobilenet = await tf.loadLayersModel(MOBILENET_URL);

    const layer = mobilenet.getLayer(TRUNCATION_LAYER);
    featureExtractor = tf.model({
        inputs: mobilenet.inputs,
        outputs: layer.output
    });

    // [null, 7, 7, 256] -> 7*7*256 = 12544
    const outputShape = featureExtractor.outputShape;
    featureSize = outputShape[1] * outputShape[2] * outputShape[3];

    captureCanvas = document.createElement("canvas");
    captureCanvas.width = 224;
    captureCanvas.height = 224;

    console.log("Trainer ready. Feature size:", featureSize);
}

// ============================================
// CLASS MANAGEMENT
// ============================================

function addClass(name) {
    classes.push({ name, samples: [], count: 0 });
    return classes.length - 1;
}

function removeClass(index) {
    classes[index].samples.forEach(s => s.tensor.dispose());
    classes.splice(index, 1);
}

function renameClass(index, newName) {
    classes[index].name = newName;
}

function clearSamples(index) {
    classes[index].samples.forEach(s => s.tensor.dispose());
    classes[index].samples = [];
    classes[index].count = 0;
}

function getClasses() {
    return classes.map(c => ({ name: c.name, count: c.count }));
}

function getClassNames() {
    return classes.map(c => c.name);
}

function getTotalClasses() {
    return classes.length;
}

// ============================================
// CAPTURE
// ============================================

/**
 * Capture one frame from the webcam canvas.
 * Returns {tensor: Tensor1D (features), thumb: string (data URL)}.
 */
function captureFrame(webcamCanvas) {
    const ctx = captureCanvas.getContext("2d");
    ctx.drawImage(webcamCanvas, 0, 0, 224, 224);

    // 80x80 JPEG thumbnail for the gallery
    const thumbCanvas = document.createElement("canvas");
    thumbCanvas.width = 80;
    thumbCanvas.height = 80;
    thumbCanvas.getContext("2d").drawImage(captureCanvas, 0, 0, 80, 80);
    const thumb = thumbCanvas.toDataURL("image/jpeg", 0.6);

    // 224x224 JPEG for persistent storage (needed to re-extract features on retrain)
    const img224 = captureCanvas.toDataURL("image/jpeg", 0.7);

    // MobileNet feature extraction
    const tensor = tf.tidy(() => {
        const img = tf.browser.fromPixels(captureCanvas)
            .toFloat()
            .div(127.5)
            .sub(1.0)
            .expandDims(0); // [1, 224, 224, 3]

        const features = featureExtractor.predict(img);
        return features.flatten(); // [12544]
    });

    return { tensor, thumb, img224 };
}

/**
 * Capture exactly one sample (used by the single-shot button).
 */
function captureOne(classIndex, webcamCanvas) {
    const s = captureFrame(webcamCanvas);
    classes[classIndex].samples.push(s);
    classes[classIndex].count++;
}

/**
 * Start capturing samples continuously for a class (used by hold button).
 * Captures one sample immediately, then continues at ~5fps while held.
 */
function startCapture(classIndex, webcamCanvas) {
    stopCapture();

    // Immediate capture — a quick click gets exactly 1 sample
    const first = captureFrame(webcamCanvas);
    classes[classIndex].samples.push(first);
    classes[classIndex].count++;

    // Continue capturing while the button is held
    captureIntervalId = setInterval(() => {
        const s = captureFrame(webcamCanvas);
        classes[classIndex].samples.push(s);
        classes[classIndex].count++;
    }, 200); // ~5 fps
}

function stopCapture() {
    if (captureIntervalId) {
        clearInterval(captureIntervalId);
        captureIntervalId = null;
    }
}

// ============================================
// SAMPLE ACCESS
// ============================================

/**
 * Returns [{index, thumb}] for all samples of a class.
 * Used by the gallery renderer in app.js.
 */
function getSamples(classIndex) {
    return classes[classIndex].samples.map((s, i) => ({ index: i, thumb: s.thumb }));
}

/**
 * Delete a single sample by index, dispose its tensor.
 */
function deleteSample(classIndex, sampleIndex) {
    classes[classIndex].samples[sampleIndex].tensor.dispose();
    classes[classIndex].samples.splice(sampleIndex, 1);
    classes[classIndex].count--;
}

// ============================================
// TRAINING
// ============================================

async function train(onProgress) {
    if (classes.length < 2) {
        throw new Error("Se necesitan al menos 2 clases");
    }
    for (const cls of classes) {
        if (cls.count < 8) {
            throw new Error(`La clase "${cls.name}" necesita al menos 8 muestras`);
        }
    }

    const allFeatures = [];
    const allLabels = [];

    classes.forEach((cls, classIndex) => {
        cls.samples.forEach(s => {
            allFeatures.push(s.tensor);
            allLabels.push(classIndex);
        });
    });

    const xs = tf.stack(allFeatures);
    const ys = tf.oneHot(
        tf.tensor1d(allLabels, "int32"),
        classes.length
    );

    // Train a fresh head BEFORE disposing the old one.
    // Any in-flight predict() from the previous session is awaiting predictions.data()
    // which references the old head's WebGL buffers. Disposing head while that readback
    // is pending corrupts TF.js's internal GPU queue and hangs all future data() calls.
    // By training first (50 epochs takes seconds), any in-flight predict is long done.
    const newHead = tf.sequential();
    newHead.add(tf.layers.dense({
        inputShape: [featureSize],
        units: 100,
        activation: "relu",
        kernelRegularizer: tf.regularizers.l2({ l2: 0.001 })
    }));
    newHead.add(tf.layers.dense({
        units: classes.length,
        activation: "softmax"
    }));

    newHead.compile({
        optimizer: tf.train.adam(0.0001),
        loss: "categoricalCrossentropy",
        metrics: ["accuracy"]
    });

    const totalEpochs = 50;
    const history = await newHead.fit(xs, ys, {
        epochs: totalEpochs,
        batchSize: 16,
        shuffle: true,
        validationSplit: 0.15,
        callbacks: {
            onEpochEnd: (epoch, logs) => {
                if (onProgress) onProgress(epoch, totalEpochs, logs);
            }
        }
    });

    xs.dispose();
    ys.dispose();

    // Safe to dispose old head now — any in-flight predict() has completed
    if (head) head.dispose();
    head = newHead;
    // Congela el mapeo salida→etiqueta junto con el head que lo produjo.
    trainedClassNames = classes.map(cls => cls.name);

    // Release samples — user must re-capture to retrain
    classes.forEach(cls => {
        cls.samples.forEach(s => s.tensor.dispose());
        cls.samples = [];
        cls.count = 0;
    });

    const lastEpoch = history.history;
    const finalAcc = lastEpoch.val_acc
        ? lastEpoch.val_acc[lastEpoch.val_acc.length - 1]
        : lastEpoch.acc[lastEpoch.acc.length - 1];
    const finalLoss = lastEpoch.loss[lastEpoch.loss.length - 1];

    return {
        accuracy: finalAcc,
        loss: finalLoss,
        epochs: totalEpochs
    };
}

// ============================================
// PREDICTION
// ============================================

async function predict(canvas) {
    if (!featureExtractor || !head) return [];

    // Se lee junto con el head y ANTES del await: el par (head, etiquetas)
    // tiene que ser atómico, o un train() que termine durante la lectura de
    // datos etiquetaría las probabilidades del head viejo con los nombres
    // nuevos.
    const labels = trainedClassNames || classes.map(cls => cls.name);

    const ctx = captureCanvas.getContext("2d");
    ctx.drawImage(canvas, 0, 0, 224, 224);

    const predictions = tf.tidy(() => {
        const img = tf.browser.fromPixels(captureCanvas)
            .toFloat().div(127.5).sub(1.0)
            .expandDims(0);

        const features = featureExtractor.predict(img);
        const flat = features.reshape([1, -1]);
        return head.predict(flat);
    });

    const probs = await predictions.data();
    predictions.dispose();

    // El largo lo manda `probs`, que es lo que el head devolvió: una etiqueta
    // sin score produciría `probability: undefined`, que viaja en silencio
    // hasta la UI como `NaN%` y hasta el UART como una clase fantasma.
    const count = Math.min(labels.length, probs.length);
    const result = [];
    for (let i = 0; i < count; i++) {
        result.push({ className: labels[i], probability: probs[i] });
    }
    return result;
}

// ============================================
// PERSISTENCE
// ============================================

async function saveModel(projectId) {
    if (!head) throw new Error("No hay modelo entrenado");
    if (!trainedClassNames) throw new Error("No hay modelo entrenado");

    const storageKey = imageModelKey(projectId);
    await head.save("indexeddb://" + storageKey);

    return {
        source: "local",
        // La lista del head, no la viva: lo que se guarda tiene que describir
        // al modelo que se está guardando, sin depender de que el llamador
        // invoque saveModel() inmediatamente después de train().
        classNames: [...trainedClassNames],
        storageKey,
        featureExtractor: "mobilenet_v1_0.25_224",
        trainedAt: new Date().toISOString()
    };
}

async function loadSavedModel(localModelInfo) {
    await initTrainer();

    head = await tf.loadLayersModel(
        "indexeddb://" + localModelInfo.storageKey
    );

    // `classNames` describe la lista EDITADA, no la entrenada: la frontera de
    // rehidratación la resuelve con `project.classNames || localModel.classNames`
    // y escribe el resultado adentro de localModel, así que desde la primera
    // recarga trae las ediciones posteriores al entrenamiento.
    // `trainedClassNames` es el campo que la frontera no conoce y preserva.
    const trained = Array.isArray(localModelInfo.trainedClassNames)
        && localModelInfo.trainedClassNames.length > 0
        ? localModelInfo.trainedClassNames
        : localModelInfo.classNames;

    // El head es la autoridad sobre cuántas etiquetas hay. Un registro legado
    // —entrenado antes de que se guardara trainedClassNames— y editado después
    // cae acá: mejor rechazar el modelo que etiquetar con una lista corrida.
    // openTrainingScreen() ya trata "el modelo no carga" como "necesita
    // reentrenar", que es exactamente el estado correcto.
    const outputs = head.outputShape[head.outputShape.length - 1];
    if (trained.length !== outputs) {
        head.dispose();
        head = null;
        throw new Error("El modelo guardado no coincide con sus clases");
    }

    classes = localModelInfo.classNames.map(name => ({
        name, samples: [], count: 0
    }));
    trainedClassNames = [...trained];
}

async function deleteModel(storageKey) {
    try {
        await tf.io.removeModel("indexeddb://" + storageKey);
    } catch (e) {
        console.warn("Could not remove model:", e);
    }
}

// ============================================
// INDEXEDDB HELPERS
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

async function saveSamples(projectId) {
    const data = [];
    classes.forEach((cls, ci) => {
        cls.samples.forEach(s => data.push({ ci, img224: s.img224, thumb: s.thumb }));
    });
    await idbPut(imageSamplesKey(projectId), data);
}

async function loadSamples(projectId) {
    const stored = await idbGet(imageSamplesKey(projectId));
    if (!stored?.length) return 0;

    // Reset in-memory samples before loading to avoid duplication on repeated calls.
    // Dispose tensors first to prevent WebGL memory leaks. In the current flow this
    // loop is a no-op (train() already clears samples), but it protects the contract
    // for future callers.
    classes.forEach(cls => {
        cls.samples.forEach(s => s.tensor.dispose());
        cls.samples = [];
        cls.count = 0;
    });

    const loadCanvas = document.createElement("canvas");
    loadCanvas.width = 224;
    loadCanvas.height = 224;

    let loaded = 0;
    for (const s of stored) {
        // IndexedDB is user-modifiable: skip records whose shape or data
        // URLs don't match what saveSamples() writes.
        if (!isValidImageSample(s) || !classes[s.ci]) continue;
        // A prefix-valid data URL can still fail to decode; without onerror
        // the promise would never resolve and loadSamples() would hang.
        const decoded = await new Promise(res => {
            const img = new Image();
            img.onload = () => {
                loadCanvas.getContext("2d").drawImage(img, 0, 0, 224, 224);
                res(true);
            };
            img.onerror = () => res(false);
            img.src = s.img224;
        });
        if (!decoded) continue;
        const tensor = tf.tidy(() =>
            featureExtractor.predict(
                tf.browser.fromPixels(loadCanvas).toFloat().div(127.5).sub(1.0).expandDims(0)
            ).flatten()
        );
        classes[s.ci].samples.push({ tensor, thumb: s.thumb, img224: s.img224 });
        classes[s.ci].count++;
        loaded++;
    }
    return loaded;
}

async function deleteSamplesDB(projectId) {
    await idbDelete(imageSamplesKey(projectId));
}

// ============================================
// CLEANUP
// ============================================

function isTrained() {
    return head !== null;
}

function dispose() {
    stopCapture();

    classes.forEach(cls => {
        cls.samples.forEach(s => s.tensor.dispose());
    });
    classes = [];

    if (head) { head.dispose(); head = null; }
    trainedClassNames = null;
    if (featureExtractor) {
        featureExtractor.dispose();
        featureExtractor = null;
    }

    captureCanvas = null;
}

export {
    initTrainer,
    addClass, removeClass, renameClass,
    clearSamples, getClasses, getClassNames, getTotalClasses,
    getSamples, deleteSample,
    captureOne, startCapture, stopCapture,
    train,
    predict,
    saveModel, loadSavedModel, deleteModel,
    saveSamples, loadSamples, deleteSamplesDB,
    isTrained, dispose
};
