/**
 * pose-trainer.js
 * Transfer learning module: MediaPipe PoseLandmarker + TF.js trainable head.
 * Extracts 33 body keypoints as features, trains a lightweight classifier.
 */

import { isValidPoseSample } from './sanitize.js';
import { SAMPLES_DB_NAME, SAMPLES_DB_VERSION, SAMPLES_STORE, poseSamplesKey, poseModelKey } from './storage-keys.js';

// MediaPipe pose detector
let poseLandmarker = null;

// TF.js classification head
let head = null;
const featureSize = 99; // 33 keypoints × 3 (x, y, z)

// Classes and samples
let classes = []; // [{name, samples: [{features: Float32Array, thumb: string}], count}]

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

// Last detected pose (for skeleton overlay)
let lastLandmarks = null;

// ============================================
// INIT
// ============================================

async function initTrainer() {
    if (poseLandmarker) return;

    // Wait for MediaPipe globals to be available (loaded as ES module async)
    let attempts = 0;
    while (!window.PoseLandmarker || !window.FilesetResolver) {
        if (attempts > 100) throw new Error('MediaPipe libraries did not load');
        await new Promise(r => setTimeout(r, 100));
        attempts++;
    }

    const vision = await window.FilesetResolver.forVisionTasks(
        "vendor/mediapipe/wasm-0.10.14"
    );

    poseLandmarker = await window.PoseLandmarker.createFromOptions(vision, {
        baseOptions: {
            modelAssetPath: "vendor/mediapipe/models/pose_landmarker_lite-v1.task",
            delegate: "GPU"
        },
        runningMode: "VIDEO",
        numPoses: 1
    });

    console.log("Pose trainer ready");
}

// ============================================
// CLASS MANAGEMENT
// ============================================

function addClass(name) {
    classes.push({ name, samples: [], count: 0 });
    return classes.length - 1;
}

function removeClass(index) {
    classes.splice(index, 1);
}

function renameClass(index, newName) {
    classes[index].name = newName;
}

function clearSamples(index) {
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
// KEYPOINT EXTRACTION
// ============================================

/**
 * Extract 33 keypoints from an image source (canvas or video element).
 * Returns Float32Array(99) with [x,y,z] per keypoint, or null if no pose detected.
 */
function extractKeypoints(imageSource, timestamp) {
    if (!poseLandmarker) return null;

    let result;
    try {
        result = poseLandmarker.detectForVideo(imageSource, timestamp);
    } catch (e) {
        return null;
    }

    if (!result.landmarks || result.landmarks.length === 0) {
        lastLandmarks = null;
        return null;
    }

    const landmarks = result.landmarks[0]; // first (and only) person
    lastLandmarks = landmarks;

    // Flatten to [x0, y0, z0, x1, y1, z1, ...]
    const features = new Float32Array(featureSize);
    for (let i = 0; i < 33; i++) {
        features[i * 3]     = landmarks[i].x;
        features[i * 3 + 1] = landmarks[i].y;
        features[i * 3 + 2] = landmarks[i].z;
    }

    return features;
}

function getLastLandmarks() {
    return lastLandmarks;
}

// ============================================
// SKELETON DRAWING
// ============================================

// MediaPipe pose connections (33 keypoints)
const POSE_CONNECTIONS = [
    [0,1],[1,2],[2,3],[3,7],
    [0,4],[4,5],[5,6],[6,8],
    [9,10],
    [11,12],
    [11,13],[13,15],
    [12,14],[14,16],
    [15,17],[15,19],[15,21],
    [16,18],[16,20],[16,22],
    [11,23],[12,24],
    [23,24],
    [23,25],[25,27],
    [24,26],[26,28],
    [27,29],[29,31],[27,31],
    [28,30],[30,32],[28,32],
];

/**
 * Draw pose skeleton on a canvas context.
 * Landmarks are in normalized coords (0-1).
 * @param {boolean} flip - Mirror X coords to match a horizontally-flipped display.
 */
function drawSkeleton(ctx, landmarks, canvasWidth, canvasHeight, flip = false) {
    if (!landmarks || landmarks.length === 0) return;

    const lx = (lm) => (flip ? 1 - lm.x : lm.x) * canvasWidth;
    const ly = (lm) => lm.y * canvasHeight;

    ctx.strokeStyle = '#00ff00';
    ctx.lineWidth = 2;
    for (const [i, j] of POSE_CONNECTIONS) {
        const a = landmarks[i];
        const b = landmarks[j];
        if (a && b && a.visibility > 0.5 && b.visibility > 0.5) {
            ctx.beginPath();
            ctx.moveTo(lx(a), ly(a));
            ctx.lineTo(lx(b), ly(b));
            ctx.stroke();
        }
    }

    ctx.fillStyle = '#00ff00';
    for (const lm of landmarks) {
        if (lm.visibility > 0.5) {
            ctx.beginPath();
            ctx.arc(lx(lm), ly(lm), 4, 0, 2 * Math.PI);
            ctx.fill();
        }
    }
}

// ============================================
// CAPTURE
// ============================================

/**
 * Capture one pose sample from webcam.
 * @param {boolean} flip - True when the display is horizontally mirrored (front camera).
 * Returns false if no pose detected.
 */
function captureOne(classIndex, webcamCanvas, imageSource, flip = true) {
    const features = extractKeypoints(imageSource, performance.now());
    if (!features) return false;

    // Generate thumbnail: webcam frame + skeleton overlay
    const thumbCanvas = document.createElement('canvas');
    thumbCanvas.width = 80;
    thumbCanvas.height = 80;
    const thumbCtx = thumbCanvas.getContext('2d');
    thumbCtx.drawImage(webcamCanvas, 0, 0, 80, 80);
    if (lastLandmarks) drawSkeleton(thumbCtx, lastLandmarks, 80, 80, flip);
    const thumb = thumbCanvas.toDataURL('image/jpeg', 0.6);

    classes[classIndex].samples.push({ features, thumb });
    classes[classIndex].count++;
    return true;
}

/**
 * Start capturing continuously (~5fps).
 * @param {boolean} flip - True when the display is horizontally mirrored (front camera).
 */
function startCapture(classIndex, webcamCanvas, imageSource, flip = true) {
    stopCapture();

    // Immediate capture
    captureOne(classIndex, webcamCanvas, imageSource, flip);

    captureIntervalId = setInterval(() => {
        captureOne(classIndex, webcamCanvas, imageSource, flip);
    }, 200);
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

function getSamples(classIndex) {
    return classes[classIndex].samples.map((s, i) => ({
        index: i,
        thumb: s.thumb
    }));
}

function deleteSample(classIndex, sampleIndex) {
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
            allFeatures.push(Array.from(s.features));
            allLabels.push(classIndex);
        });
    });

    const xs = tf.tensor2d(allFeatures); // [totalSamples, 99]
    const ys = tf.oneHot(
        tf.tensor1d(allLabels, 'int32'),
        classes.length
    );

    const newHead = tf.sequential();
    newHead.add(tf.layers.dense({
        inputShape: [featureSize],
        units: 64,
        activation: 'relu'
    }));
    newHead.add(tf.layers.dense({
        units: classes.length,
        activation: 'softmax'
    }));

    newHead.compile({
        optimizer: tf.train.adam(0.001),
        loss: 'categoricalCrossentropy',
        metrics: ['accuracy']
    });

    const totalEpochs = 50;
    await newHead.fit(xs, ys, {
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

    if (head) head.dispose();
    head = newHead;
    // Congela el mapeo salida→etiqueta junto con el head que lo produjo.
    trainedClassNames = classes.map(cls => cls.name);

    return { epochs: totalEpochs };
}

// ============================================
// PREDICTION
// ============================================

/**
 * Predict pose class from an image source (canvas or video element).
 * Returns [{className, probability}] or empty array if no pose detected.
 */
async function predict(imageSource) {
    if (!poseLandmarker || !head) return [];

    const features = extractKeypoints(imageSource, performance.now());
    if (!features) return [];

    // Se lee junto con el head y ANTES del await: el par (head, etiquetas)
    // tiene que ser atómico, o un train() que termine durante la lectura de
    // datos etiquetaría las probabilidades del head viejo con los nombres
    // nuevos.
    const labels = trainedClassNames || classes.map(cls => cls.name);

    const prediction = tf.tidy(() => {
        const input = tf.tensor2d([Array.from(features)]);
        return head.predict(input);
    });

    const probs = await prediction.data();
    prediction.dispose();

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

    const storageKey = poseModelKey(projectId);
    await head.save('indexeddb://' + storageKey);

    return {
        source: 'local-pose',
        // La lista del head, no la viva: lo que se guarda tiene que describir
        // al modelo que se está guardando, sin depender de que el llamador
        // invoque saveModel() inmediatamente después de train().
        classNames: [...trainedClassNames],
        storageKey,
        trainedAt: new Date().toISOString()
    };
}

async function loadSavedModel(localModelInfo) {
    await initTrainer();

    head = await tf.loadLayersModel(
        'indexeddb://' + localModelInfo.storageKey
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
        await tf.io.removeModel('indexeddb://' + storageKey);
    } catch (e) {
        console.warn('Could not remove pose model:', e);
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
        cls.samples.forEach(s => {
            data.push({
                ci,
                features: Array.from(s.features),
                thumb: s.thumb
            });
        });
    });
    await idbPut(poseSamplesKey(projectId), data);
}

async function loadSamples(projectId) {
    const stored = await idbGet(poseSamplesKey(projectId));
    if (!stored?.length) return 0;

    // Reset in-memory samples before loading to avoid duplication on repeated calls
    // (e.g. after train() completes and the main flow calls loadSamples again).
    classes.forEach(cls => {
        cls.samples = [];
        cls.count = 0;
    });

    let loaded = 0;
    for (const s of stored) {
        // IndexedDB is user-modifiable: skip records whose shape or data
        // URLs don't match what saveSamples() writes.
        if (!isValidPoseSample(s, featureSize) || !classes[s.ci]) continue;
        classes[s.ci].samples.push({
            features: new Float32Array(s.features),
            thumb: s.thumb
        });
        classes[s.ci].count++;
        loaded++;
    }
    return loaded;
}

async function deleteSamplesDB(projectId) {
    await idbDelete(poseSamplesKey(projectId));
}

// ============================================
// CLEANUP
// ============================================

function isTrained() {
    return head !== null;
}

function dispose() {
    stopCapture();

    classes = [];
    lastLandmarks = null;

    if (head) { head.dispose(); head = null; }
    trainedClassNames = null;

    // poseLandmarker is kept alive — expensive to recreate (~2-3s)
}

export {
    initTrainer,
    addClass, removeClass, renameClass,
    clearSamples, getClasses, getClassNames, getTotalClasses,
    getSamples, deleteSample,
    captureOne, startCapture, stopCapture,
    train,
    predict,
    extractKeypoints, getLastLandmarks, drawSkeleton,
    saveModel, loadSavedModel, deleteModel,
    saveSamples, loadSamples, deleteSamplesDB,
    isTrained, dispose
};
