/**
 * app.js
 * Main application logic
 */

import { Webcam } from './webcam.js';
import { connectMicrobit, disconnectMicrobit, sendToMicrobit, isConnected, setDisconnectCallback } from './bluetooth.js';
import { openMakeCode, closeMakeCode } from './makecode-embed.js';
import * as trainer from './image-trainer.js';
import * as audioTrainer from './audio-trainer.js';
import * as poseTrainer from './pose-trainer.js';
import { loadModels, saveModels, addProject, deleteProject, updateProjectMakeCode, updateProjectModel, updateProjectClassNames, getQuarantineStatus, acknowledgeQuarantine, StorageQuotaError } from './project-store.js';
import { getConfig } from './trainer-config.js';
import { escapeHtml } from './sanitize.js';
import {
    MAX_CLASS_NAME_BYTES,
    UNNAMED_CLASS_LABEL,
    byteLength,
    stripUnsafeChars,
    truncateToBytes,
    normalizeClassName,
    isDuplicateClassName,
    displayClassName
} from './class-name.js';
import {
    MIN_CLASSES,
    MIN_SAMPLES_PER_CLASS,
    getTrainingBlockers,
    getBlockedClassIndices,
    formatBlocker,
    classesSignature,
    hasUntrainedChanges,
    classNamesDiverged,
    BLOCKER_MISSING_NAME
} from './training-rules.js';

let currentModel = null;

// Tracks which type of project is being created via the name modal
let pendingProjectType = 'image'; // 'image' | 'audio' | 'pose'

// Webcam unificada: se mueve entre clases (captura) y sección de predicciones
let activeWebcam = null;
let activeWebcamTarget = null;  // 'capture' | 'prediction' | null
let predictionLoopRunning = false;
let trainingFacingMode = 'user'; // 'user' | 'environment'
let predictionExpanded = false;

let batchRecordingActive = false;
let batchRecordingCancelled = false;

// El botón "Nueva clase" vive dentro de #trainingClassesList, que se reescribe
// con innerHTML en cada render y se vacía al salir de la pantalla. La
// referencia se toma una sola vez acá: mover el nodo con appendChild conserva
// su listener, así que nunca hay que volver a cablearlo.
const addClassBtn = document.getElementById('addClassBtn');

// Panel de "por qué todavía no se puede entrenar". Está fuera de la lista de
// clases, así que estos nodos sobreviven a los renders.
const trainBlockersPanel = document.getElementById('trainBlockers');
const trainBlockersList = document.getElementById('trainBlockersList');
let trainBlockersVisible = false;

const goProgramBtn = document.getElementById('goProgramBtn');

/**
 * ¿Hay un modelo entrenado y usable EN MEMORIA para el proyecto abierto?
 *
 * Es lo que decide si aparece "Programar micro:bit" en la pantalla de
 * entrenamiento y si el botón de entrenar dice "Reentrenar".
 *
 * NO se deriva de `isTrained()`: el de audio devuelve `true` en cuanto el
 * recognizer tiene ejemplos, sin haber entrenado nunca. `wordLabels()` sale de
 * `collateTransferWords()`, que speech-commands corre dentro de
 * `loadExamples()` y de `collectExample()`, así que un proyecto de audio con
 * muestras recuperadas y sin modelo lo reportaría como entrenado. Los de
 * imagen y pose sí son fiables (`head !== null`), pero un solo origen de
 * verdad para los tres es lo que hace que el botón no mienta.
 */
let modelReadyForProgramming = false;

/**
 * Huella de las clases con las que se entrenó el modelo del proyecto abierto,
 * o `null` si no se sabe (proyecto guardado antes de que existiera la huella).
 *
 * Se persiste dentro de `localModel` para que la comparación sobreviva a
 * cerrar y reabrir: las muestras se guardan solas, sin pasar por `train()`, así
 * que al reabrir un proyecto lo guardado puede ser más nuevo que el modelo y no
 * hay forma de notarlo sin haberlo anotado al entrenar.
 */
let trainedClassesSignature = null;

/**
 * Los nombres de clase con los que se entrenó, en el orden con que se entrenó.
 *
 * Va en `localModel.trainedClassNames` y NO en `localModel.classNames`, que no
 * sirve para esto: `canonicalizeProject()` resuelve los nombres con
 * `project.classNames || localModel.classNames` y escribe el resultado dentro
 * de `localModel`, así que la lista editada pisa a la entrenada en la primera
 * rehidratación. Un campo que la frontera no conoce se preserva tal cual.
 */
let trainedClassNames = null;

// El botón Entrenar ya no se deshabilita por falta de clases ni de muestras,
// así que el "hay un entrenamiento corriendo" necesita su propio flag: sin él,
// cualquier updateTrainButton() disparado durante el entrenamiento lo
// reactivaría.
let trainingInProgress = false;

// Persistencia de muestras con debounce. La captura sostenida corre a ~5 fps:
// escribir en cada muestra serian cinco escrituras por segundo del dataset
// entero. 1,5 s de inactividad es la ventana que se puede perder si el
// navegador se cierra de golpe; al salir de la pantalla se fuerza el flush.
let sampleSaveTimer = null;
let sampleSaveDirty = false;
// Las escrituras se encadenan para que dos flushes solapados no corran a la
// vez sobre la misma clave de IndexedDB.
let sampleSaveChain = Promise.resolve();

// Preview modal state
let previewWebcam = null;
let previewLoopRunning = false;
let previewAudioVisualizerCanvas = null;

const CLASS_COLORS = [
    { bg: '#E1F5EE', dot: '#1D9E75', btnFill: '#1D9E75', badge: '#9FE1CB', badgeText: '#0F6E56', headerText: '#085041', icon: '#0F6E56' },
    { bg: '#E6F1FB', dot: '#378ADD', btnFill: '#378ADD', badge: '#B5D4F4', badgeText: '#185FA5', headerText: '#0C447C', icon: '#185FA5' },
    { bg: '#FAECE7', dot: '#D85A30', btnFill: '#D85A30', badge: '#F5C4B3', badgeText: '#993C1D', headerText: '#712B13', icon: '#993C1D' },
    { bg: '#EEEDFE', dot: '#7F77DD', btnFill: '#7F77DD', badge: '#CECBF6', badgeText: '#534AB7', headerText: '#3C3489', icon: '#534AB7' },
    { bg: '#FBEAF0', dot: '#D4537E', btnFill: '#D4537E', badge: '#F4C0D1', badgeText: '#993556', headerText: '#72243E', icon: '#993556' },
    { bg: '#FAEEDA', dot: '#BA7517', btnFill: '#BA7517', badge: '#FAC775', badgeText: '#854F0B', headerText: '#633806', icon: '#854F0B' },
];

function getClassColor(index) {
    return CLASS_COLORS[0];
}

function getTrainer() {
    if (currentModel?.projectType === 'audio') return audioTrainer;
    if (currentModel?.projectType === 'pose') return poseTrainer;
    return trainer;
}

function resetConnectionUI() {
    const pConn = document.getElementById('predictionConnectBtn');
    if (pConn && pConn.classList.contains('connected')) {
        pConn.classList.remove('connected');
        pConn.textContent = '🔗 Conectar';
    }
}
setDisconnectCallback(resetConnectionUI);

// ============================================
// PROJECT LIBRARY
// ============================================

async function deleteModelAndCleanup(id) {
    return deleteProject(id, { trainer, audioTrainer, poseTrainer });
}

function renderModels() {
    const models = loadModels();

    const notice = document.getElementById('quarantineNotice');
    const noticeText = document.getElementById('quarantineNoticeText');
    const noticeDismiss = document.getElementById('quarantineNoticeDismiss');
    if (notice && noticeText && noticeDismiss) {
        const { count, needsNotice, persisted } = getQuarantineStatus();
        if (needsNotice) {
            const label = count === 1 ? 'proyecto dañado' : 'proyectos dañados';
            // textContent, nunca innerHTML. Lo único interpolado es un número.
            noticeText.textContent = persisted
                ? `Encontramos ${count} ${label} que no se pudieron abrir. ` +
                  `Los guardamos aparte por si hace falta recuperarlos: avisale al equipo del programa.`
                : `Encontramos ${count} ${label} que no se pudieron abrir y no pudimos ` +
                  `guardarlos todos aparte, probablemente por falta de espacio. No cierres la app ` +
                  `y avisale al equipo del programa.`;
            // El botón se oculta cuando la copia no está completa:
            // acknowledgeQuarantine() se niega siempre en ese estado, así que
            // dejarlo visible es ofrecer una acción que no puede cumplir.
            noticeDismiss.classList.toggle('hidden', !persisted);
            notice.classList.remove('hidden');
        } else {
            notice.classList.add('hidden');
        }
    }

    const modelsList = document.getElementById('modelsList');
    const emptyState = document.getElementById('emptyState');

    // Always hide the old empty state — the New Project card takes its place
    if (emptyState) emptyState.style.display = 'none';

    const newProjectCard = `
        <button class="model-card-new" id="newProjectCard">
            <span class="card-new-icon">+</span>
            <span class="card-new-label">Nuevo Proyecto</span>
        </button>`;

    const projectCards = models.map(model => `
        <div class="model-card">
            <div class="class-menu-wrapper model-card-menu">
                <button class="btn-class-menu" data-id="${escapeHtml(model.id)}" title="Opciones">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="#666" stroke="none">
                        <circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/>
                    </svg>
                </button>
                <div class="class-dropdown">
                    <button class="class-dropdown-item danger" data-action="delete" data-id="${escapeHtml(model.id)}">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14"/>
                        </svg>
                        Eliminar proyecto
                    </button>
                </div>
            </div>
            <div class="model-card-title">${escapeHtml(model.name)}</div>
            ${model.classNames ? `<div class="model-card-classes">${model.classNames.map(c => escapeHtml(displayClassName(c))).join(' · ')}</div>` : ''}
            <div class="model-card-date">${escapeHtml(formatDate(model.createdAt))}</div>
            <div class="model-card-actions">
                <button class="btn-card btn-use" data-action="open" data-id="${escapeHtml(model.id)}">Abrir</button>
            </div>
        </div>
    `).join('');

    modelsList.innerHTML = newProjectCard + projectCards;

    document.getElementById('newProjectCard').addEventListener('click', () => {
        document.getElementById('projectTypeModal').classList.remove('hidden');
    });

    modelsList.querySelectorAll('[data-action="open"]').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const model = loadModels().find(m => m.id === btn.dataset.id);
            if (!model) return;
            currentModel = model;
            await openTrainingScreen(model);
        });
    });

    modelsList.querySelectorAll('[data-action="delete"]').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (confirm('¿Eliminar este proyecto?')) {
                try {
                    const { samplesDeleted } = await deleteModelAndCleanup(btn.dataset.id);
                    if (samplesDeleted) {
                        showToast('Proyecto eliminado', 'success');
                    } else {
                        // El registro salió de la lista, pero las muestras siguen
                        // en IndexedDB. En imagen y pose son fotos de la webcam:
                        // decir "eliminado" a secas sería falso justo en el caso
                        // que este cambio existe para evitar.
                        showToast(
                            'El proyecto se eliminó, pero no pudimos borrar las fotos guardadas. ' +
                            'Cerrá las otras pestañas y probá de nuevo.',
                            'error'
                        );
                    }
                } catch (error) {
                    // Sin esto, un fallo dejaba la tarjeta en la lista sin
                    // ningún mensaje: el docente apretaba "eliminar" y no pasaba
                    // nada, y su único recurso era borrar datos del sitio, o sea
                    // perder también todos los demás proyectos.
                    console.error('Delete project error:', error);
                    showToast('No se pudo eliminar el proyecto. Probá de nuevo.', 'error');
                }
                renderModels();
            }
        });
    });

    modelsList.querySelectorAll('.btn-class-menu').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const dropdown = btn.nextElementSibling;
            document.querySelectorAll('.class-dropdown.open').forEach(d => {
                if (d !== dropdown) d.classList.remove('open');
            });
            dropdown.classList.toggle('open');
        });
    });
}

// ============================================
// NAVIGATION & FLOWS
// ============================================

function showScreen(screenId) {
    document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
    document.getElementById(screenId).classList.remove('hidden');

}

async function openPredictionScreen(model) {
    currentModel = model;
    document.getElementById('predictionModelName').textContent = model.name;

    document.getElementById('predictionRetrainBtn').style.display = '';

    const isAudio = model.projectType === 'audio' || model.localModel?.source === 'local-audio';
    const isPose = model.projectType === 'pose' || model.localModel?.source === 'local-pose';

    // Flip button only makes sense for camera models
    document.getElementById('predictionFlipBtn').style.display = isAudio ? 'none' : '';

    // Solo se pide la cancelación: el dueño del ciclo de la tanda es
    // finishRecordingBatch(), y es el único que apaga batchRecordingActive.
    batchRecordingCancelled = true;
    hideTrainBlockers();
    stopPredictionLoop();
    audioTrainer.stopListening();
    audioTrainer.stopVisualizer();
    closeMakeCode('makecodeInlineFrame');
    closeCaptureWebcamSilent();
    disconnectMicrobit();

    // Android no libera la cámara en el mismo tick: abrir la de predicción
    // pegado al stop de la de captura devuelve un stream muerto. Misma pausa
    // que usan flipCaptureCamera() y sus hermanas. Con #goProgramBtn este dejó
    // de ser un camino excepcional: se viene de una sesión entera de captura
    // con la cámara viva.
    if (!isAudio) {
        await new Promise(r => setTimeout(r, 250));
    }

    const conn = document.getElementById('predictionConnectBtn');
    conn.classList.remove('connected');
    conn.textContent = '🔗 Conectar';

    trainingFacingMode = 'user';
    predictionExpanded = false;
    document.body.classList.remove('prediction-expanded');
    document.getElementById('prediction-predictions').innerHTML = '';

    showScreen('predictionScreen');
    showToast('Cargando modelo...', 'info');

    try {
        if (isAudio) {
            // Local audio model: load weights + start visualizer + start listening
            await audioTrainer.loadSavedModel(model.localModel);

            const wrapper = document.getElementById('prediction-webcam-wrapper');
            const canvas = document.createElement('canvas');
            canvas.width = 400;
            canvas.height = 400;
            canvas.style.background = '#fff';
            wrapper.innerHTML = '';
            wrapper.appendChild(canvas);
            document.querySelector('.prediction-main-content')?.scrollTo(0, 0)
            await audioTrainer.startVisualizer(canvas);
            await audioTrainer.startListening(preds => renderTrainingPredictions(preds));
        } else if (isPose) {
            if (!poseTrainer.isTrained()) {
                await poseTrainer.loadSavedModel(model.localModel);
            }
            await startPosePredictionLoop();
        } else {
            await startPredictionLoop();
        }
        showToast('Modelo cargado', 'success');
    } catch (error) {
        console.error('Error loading model:', error);
        showToast('Error al cargar el modelo', 'error');
        showScreen('homeScreen');
        return;
    }

    // Las clases del MODELO ENTRENADO, no las de la pantalla de entrenamiento.
    // Desde que se puede ir a programar sin reentrenar, las dos listas divergen
    // a propósito: `model.classNames` sigue cada edición (incluida una clase
    // recién creada, todavía sin nombre), y usarla generaría bloques para
    // clases que el modelo no puede predecir — o un `//% block=""` mudo.
    // `trainedClassNames` y no `localModel.classNames`: esta última no
    // sobrevive a una rehidratación. `canonicalizeProject()` resuelve los
    // nombres con `project.classNames || localModel.classNames` y escribe el
    // resultado DENTRO de localModel, así que la lista editada pisa a la
    // entrenada apenas se recarga. `trainedClassNames` es un campo que la
    // frontera no conoce, y por eso lo preserva tal cual.
    const classNamesForMakeCode = model.localModel?.trainedClassNames
        || model.localModel?.classNames
        || model.classNames
        || (isAudio ? audioTrainer.getClassNames()
            : isPose ? poseTrainer.getClassNames()
            : trainer.getClassNames());

    openMakeCode(
        classNamesForMakeCode,
        model.makecodeProject || null,
        (proj) => {
            try {
                updateProjectMakeCode(model.id, proj);
                if (currentModel) currentModel.makecodeProject = proj;
            } catch (e) {
                showToast(e.message, 'error');
            }
        },
        model.name,
        'makecodeInlineFrame',
        true
    );
}

// ============================================
// TRAINING SCREEN
// ============================================

async function openTrainingScreen(project) {
    document.getElementById('trainingModelName').textContent = project.name;
    document.getElementById('trainBtn').disabled = true;
    const badge = document.getElementById('projectTypeBadge');
    if (badge) {
        const typeLabels = { image: 'imagen', audio: 'audio', pose: 'pose' };
        badge.textContent = typeLabels[project.projectType] || project.projectType;
    }
    const captureFlipBtn = document.getElementById('captureFlipBtn');
    if (captureFlipBtn) captureFlipBtn.style.display = project.projectType === 'audio' ? 'none' : '';

    stopPredictionLoop();
    closeCaptureWebcamSilent();
    audioTrainer.stopListening();
    audioTrainer.stopVisualizer();
    trainer.dispose();
    audioTrainer.dispose();
    poseTrainer.dispose();
    // Entrada unificada a la pantalla de entrenamiento: la convención del
    // proyecto pide la limpieza completa en cada transición. Hoy los dos caminos
    // de entrada vienen del home y estos dos son no-ops, pero el lugar donde se
    // espera la limpieza es acá.
    closeMakeCode('makecodeInlineFrame');
    disconnectMicrobit();
    document.getElementById('trainProgressText').textContent = '';
    hideTrainBlockers();
    // Arranca en false y cada rama lo levanta si de verdad cargó un modelo.
    modelReadyForProgramming = false;
    trainedClassesSignature = project.localModel?.trainedSignature ?? null;
    trainedClassNames = project.localModel?.trainedClassNames ?? null;

    trainingFacingMode = 'user';
    predictionExpanded = false;
    document.body.classList.remove('prediction-expanded');

    const isAudio = project.projectType === 'audio';
    const isPose = project.projectType === 'pose';

    // Un proyecto llega acá en tres estados, no dos. La frontera de
    // rehidratación descarta localModel cuando el puntero al modelo está roto
    // (clave de un esquema superado, source desconocido) y conserva el resto del
    // proyecto, así que "no hay localModel" ya no significa "proyecto nuevo".
    //
    // Las muestras siguen en IndexedDB bajo una clave derivada del id, que nunca
    // estuvo rota: lo que decide si hay trabajo previo son las CLASES, no el
    // puntero al modelo. Sin esta distinción el proyecto se abre vacío y el
    // primer entrenamiento pisa las muestras con saveSamples().
    //
    // El tercer estado —"necesita reentrenar"— no se puede decidir acá: también
    // se llega a él cuando el modelo existe pero no carga, y eso solo se sabe
    // después de intentarlo. Cada flujo lo resuelve con su propio modelLoaded.
    const knownClassNames = project.localModel?.classNames ?? project.classNames;
    const hasPriorWork = Array.isArray(knownClassNames) && knownClassNames.length > 0;

    if (isPose) {
        showToast('Cargando detector de pose...', 'info');

        try {
            await poseTrainer.initTrainer();

            // Un modelo que no carga deja al proyecto exactamente en el estado
            // "necesita reentrenar" que ya maneja la rama de abajo: es una
            // TERCERA ENTRADA AL MISMO ESTADO, no un caso aparte. Mantenerla
            // como camino propio fue lo que la desincronizó — recuperaba las
            // clases y no las muestras, y el primer train() las pisaba.
            let modelLoaded = false;
            let samplesLoaded = 0;
            if (project.localModel) {
                try {
                    await poseTrainer.loadSavedModel(project.localModel);
                    modelLoaded = true;
                } catch (e) {
                    console.warn('[app] No se pudo cargar el modelo guardado:', e);
                }
            }

            if (modelLoaded) {
                showToast('Cargando muestras anteriores...', 'info');
                samplesLoaded = await poseTrainer.loadSamples(project.id);
                // Un proyecto entrenado abre en ENTRENAMIENTO, no salta a
                // predicción: desde acá se puede ir a programar sin reentrenar.
                modelReadyForProgramming = poseTrainer.isTrained();
                showScreen('trainingScreen');
                document.getElementById('trainingCaptureSection').classList.remove('hidden');
            } else if (hasPriorWork) {
                // Modelo descartado por la frontera, o presente pero no cargable.
                // Las clases van primero: loadSamples() descarta las muestras
                // cuyo classes[s.ci] todavía no existe.
                showScreen('trainingScreen');
                document.getElementById('trainingCaptureSection').classList.remove('hidden');
                knownClassNames.forEach(name => poseTrainer.addClass(name));
                showToast('Cargando muestras anteriores...', 'info');
                samplesLoaded = await poseTrainer.loadSamples(project.id);
            } else {
                showScreen('trainingScreen');
                document.getElementById('trainingCaptureSection').classList.remove('hidden');
                getConfig('pose').defaultClasses.forEach(name => poseTrainer.addClass(name));
                persistClassNames();
            }

            renderTrainingClasses();
            await openCaptureWebcamWithSkeleton();
            showReadyToast(!modelLoaded && hasPriorWork, samplesLoaded);
        } catch (error) {
            console.error('Pose training init error:', error);
            showToast('Error al inicializar detector de pose', 'error');
            showScreen('homeScreen');
        }

        return;
    }

    if (isAudio) {
        showToast('Iniciando entrenador de audio...', 'info');

        try {
            await audioTrainer.initTrainer();

            // Audio carga las muestras ANTES de intentar el modelo, así que acá la
            // unificación va al revés que en imagen y pose: la rama de trabajo
            // previo absorbe a la del modelo. Un modelo que no carga deja al
            // proyecto en el mismo estado "necesita reentrenar", no en uno aparte.
            let modelLoaded = false;
            let samplesLoaded = 0;

            if (hasPriorWork) {
                // Las clases van primero en los tres casos, y acá más que en
                // ningún otro: en audio el nombre de clase ES la clave con la que
                // el recognizer indexa las muestras.
                knownClassNames.forEach(name => audioTrainer.addClass(name));
                showToast('Cargando muestras anteriores...', 'info');
                samplesLoaded = await audioTrainer.loadSamples(project.id);

                if (project.localModel) {
                    try {
                        await audioTrainer.loadSavedModel(project.localModel);
                        modelLoaded = true;
                    } catch (e) {
                        console.warn('[app] No se pudo cargar el modelo guardado:', e);
                    }
                }

                // Un proyecto entrenado abre en ENTRENAMIENTO, no salta a
                // predicción: desde acá se puede ir a programar sin reentrenar.
                // En audio el testigo es que loadSavedModel() haya andado, no
                // isTrained(), que da true con solo tener muestras.
                modelReadyForProgramming = modelLoaded;
                showScreen('trainingScreen');
                document.getElementById('trainingCaptureSection').classList.remove('hidden');
            } else {
                showScreen('trainingScreen');
                document.getElementById('trainingCaptureSection').classList.remove('hidden');
                getConfig('audio').defaultClasses.forEach(name => audioTrainer.addClass(name));
                persistClassNames();
            }

            renderTrainingClasses();
            await openAudioVisualizer();
            showReadyToast(!modelLoaded && hasPriorWork, samplesLoaded);
        } catch (error) {
            console.error('Audio training init error:', error);
            showToast('Error al iniciar el entrenador de audio', 'error');
            showScreen('homeScreen');
        }

        return;
    }

    // ── Image trainer flow ──
    if (!project.localModel) {
        document.getElementById('trainingCaptureSection').classList.remove('hidden');
    }

    showToast('Cargando red base...', 'info');

    try {
        await trainer.initTrainer();

        // Tercera entrada al mismo estado: ver el comentario del flujo de pose.
        let modelLoaded = false;
        let samplesLoaded = 0;
        if (project.localModel) {
            try {
                await trainer.loadSavedModel(project.localModel);
                modelLoaded = true;
            } catch (e) {
                console.warn('[app] No se pudo cargar el modelo guardado:', e);
            }
        }

        if (modelLoaded) {
            showToast('Cargando muestras anteriores...', 'info');
            samplesLoaded = await trainer.loadSamples(project.id);
            // Un proyecto entrenado abre en ENTRENAMIENTO, no salta a
            // predicción: desde acá se puede ir a programar sin reentrenar.
            modelReadyForProgramming = trainer.isTrained();
            showScreen('trainingScreen');
            document.getElementById('trainingCaptureSection').classList.remove('hidden');
        } else if (hasPriorWork) {
            showScreen('trainingScreen');
            document.getElementById('trainingCaptureSection').classList.remove('hidden');
            knownClassNames.forEach(name => trainer.addClass(name));
            showToast('Cargando muestras anteriores...', 'info');
            samplesLoaded = await trainer.loadSamples(project.id);
        } else {
            showScreen('trainingScreen');
            document.getElementById('trainingCaptureSection').classList.remove('hidden');
            getConfig('image').defaultClasses.forEach(name => trainer.addClass(name));
            persistClassNames();
        }

        renderTrainingClasses();
        openCaptureWebcam();
        showReadyToast(!modelLoaded && hasPriorWork, samplesLoaded);
    } catch (error) {
        console.error('Training init error:', error);
        showToast('Error al inicializar', 'error');
        showScreen('homeScreen');
    }
}

// ============================================
// WEBCAM MANAGEMENT
// ============================================

async function openCaptureWebcam() {
    if (activeWebcamTarget === 'capture') closeCaptureWebcamSilent();
    stopPredictionLoop();

    activeWebcamTarget = 'capture';

    const webcam = new Webcam(trainingFacingMode === 'user');
    await webcam.setup(trainingFacingMode);

    // Abortar si el modo cambió durante el setup
    if (activeWebcamTarget !== 'capture') {
        webcam.stop();
        return;
    }

    await webcam.play();
    activeWebcam = webcam;

    const container = document.getElementById('captureWebcamContainer');
    if (container) {
        container.innerHTML = '';
        container.appendChild(activeWebcam.canvas);
    }

    function updateLoop() {
        if (activeWebcamTarget !== 'capture') return;
        if (activeWebcam) activeWebcam.update();
        requestAnimationFrame(updateLoop);
    }
    requestAnimationFrame(updateLoop);
}

async function openCaptureWebcamWithSkeleton() {
    if (activeWebcamTarget === 'capture') closeCaptureWebcamSilent();
    stopPredictionLoop();

    activeWebcamTarget = 'capture';

    const webcam = new Webcam(trainingFacingMode === 'user');
    await webcam.setup(trainingFacingMode);

    if (activeWebcamTarget !== 'capture') {
        webcam.stop();
        return;
    }

    await webcam.play();
    activeWebcam = webcam;

    const displayCanvas = document.createElement('canvas');
    displayCanvas.width = activeWebcam.width;
    displayCanvas.height = activeWebcam.height;
    const displayCtx = displayCanvas.getContext('2d');

    const container = document.getElementById('captureWebcamContainer');
    if (container) {
        container.innerHTML = '';
        container.appendChild(displayCanvas);
    }

    function updateLoop() {
        if (activeWebcamTarget !== 'capture') return;
        if (!activeWebcam) return;

        activeWebcam.update();
        displayCtx.drawImage(activeWebcam.canvas, 0, 0, activeWebcam.width, activeWebcam.height);

        try {
            poseTrainer.extractKeypoints(activeWebcam.canvas, performance.now());
            const landmarks = poseTrainer.getLastLandmarks();
            if (landmarks) poseTrainer.drawSkeleton(displayCtx, landmarks, activeWebcam.width, activeWebcam.height, false);
        } catch (e) {
            // ignore detection errors during preview
        }

        requestAnimationFrame(updateLoop);
    }
    requestAnimationFrame(updateLoop);
}

async function startPosePredictionLoop() {
    if (activeWebcamTarget === 'capture') return;
    stopPredictionLoop();

    const flip = trainingFacingMode === 'user';
    const wrapper = document.getElementById('prediction-webcam-wrapper');
    activeWebcam = new Webcam(flip);
    await activeWebcam.setup(trainingFacingMode);
    await activeWebcam.play();

    const displayCanvas = document.createElement('canvas');
    displayCanvas.width = activeWebcam.width;
    displayCanvas.height = activeWebcam.height;
    const displayCtx = displayCanvas.getContext('2d');

    wrapper.innerHTML = '';
    wrapper.appendChild(displayCanvas);
    document.querySelector('.prediction-main-content')?.scrollTo(0, 0);

    activeWebcamTarget = 'prediction';
    predictionLoopRunning = true;

    updateTrainButton();

    let inFlight = false;
    function loop() {
        if (!predictionLoopRunning || activeWebcamTarget !== 'prediction') return;
        if (!activeWebcam) return;

        activeWebcam.update();
        displayCtx.drawImage(activeWebcam.canvas, 0, 0, activeWebcam.width, activeWebcam.height);

        const landmarks = poseTrainer.getLastLandmarks();
        if (landmarks) poseTrainer.drawSkeleton(displayCtx, landmarks, activeWebcam.width, activeWebcam.height, false);

        if (!inFlight) {
            inFlight = true;
            poseTrainer.predict(activeWebcam.canvas)
                .then(preds => {
                    inFlight = false;
                    renderTrainingPredictions(preds);
                })
                .catch(() => { inFlight = false; });
        }

        requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);
}

async function openAudioVisualizer() {
    const container = document.getElementById('captureWebcamContainer');
    container.innerHTML = '';
    const canvas = document.createElement('canvas');
    canvas.width = 300;
    canvas.height = 300;
    canvas.style.cssText = 'width:100%;height:100%;display:block;border-radius:12px;';
    container.appendChild(canvas);
    await audioTrainer.startVisualizer(canvas);
}

function closeCaptureWebcamSilent() {
    trainer.stopCapture();
    poseTrainer.stopCapture();
    if (activeWebcam && activeWebcamTarget === 'capture') {
        activeWebcam.stop();
        activeWebcam = null;
    }
    const container = document.getElementById('captureWebcamContainer');
    if (container) container.innerHTML = '';
    activeWebcam = null;
    activeWebcamTarget = null;
}

async function startPredictionLoop() {
    if (activeWebcamTarget === 'capture') return;
    stopPredictionLoop(); // destruir webcam previa si la hay

    const wrapper = document.getElementById('prediction-webcam-wrapper');
    activeWebcam = new Webcam(trainingFacingMode === 'user');
    await activeWebcam.setup(trainingFacingMode);
    await activeWebcam.play();

    wrapper.innerHTML = '';
    wrapper.appendChild(activeWebcam.canvas);
    document.querySelector('.prediction-main-content')?.scrollTo(0, 0);

    activeWebcamTarget = 'prediction';
    predictionLoopRunning = true;

    updateTrainButton();

    let inFlight = false;
    function loop() {
        if (!predictionLoopRunning || activeWebcamTarget !== 'prediction') return;
        if (!activeWebcam) return;
        activeWebcam.update();
        if (!inFlight) {
            inFlight = true;
            trainer.predict(activeWebcam.canvas)
                .then(preds => {
                    inFlight = false;
                    renderTrainingPredictions(preds);
                })
                .catch(() => { inFlight = false; });
        }
        requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);
}

function stopPredictionLoop() {
    predictionLoopRunning = false;
    if (activeWebcam && activeWebcamTarget === 'prediction') {
        activeWebcam.stop();
        activeWebcam = null;
        activeWebcamTarget = null;
        document.getElementById('prediction-webcam-wrapper').innerHTML = '';
    }
    updateTrainButton();
}

async function flipCaptureCamera() {
    trainingFacingMode = trainingFacingMode === 'user' ? 'environment' : 'user';
    if (activeWebcam) {
        activeWebcam.stop();
        activeWebcam = null;
        activeWebcamTarget = null;
    }
    await new Promise(r => setTimeout(r, 250));
    if (currentModel?.projectType === 'pose') {
        await openCaptureWebcamWithSkeleton();
    } else {
        await openCaptureWebcam();
    }
}

async function flipPreviewCamera() {
    trainingFacingMode = trainingFacingMode === 'user' ? 'environment' : 'user';
    previewLoopRunning = false;
    if (previewWebcam) {
        previewWebcam.stop();
        previewWebcam = null;
    }
    await new Promise(r => setTimeout(r, 250));
    const wrapper = document.getElementById('previewVisorWrapper');
    const classNames = getTrainer().getClassNames();
    wrapper.innerHTML = '';
    if (currentModel?.projectType === 'pose') {
        await startPreviewPose(wrapper, classNames);
    } else {
        await startPreviewImage(wrapper, classNames);
    }
}

async function flipTrainingCamera() {
    trainingFacingMode = trainingFacingMode === 'user' ? 'environment' : 'user';

    // Stop loop and camera without clearing the wrapper DOM so the
    // last frame stays visible during the hardware transition.
    predictionLoopRunning = false;
    if (activeWebcam) {
        activeWebcam.stop();
        activeWebcam = null;
        activeWebcamTarget = null;
    }

    await new Promise(r => setTimeout(r, 250));

    if (currentModel?.projectType === 'pose') {
        await startPosePredictionLoop();
    } else {
        await startPredictionLoop();
    }
}

function togglePredictionExpanded() {
    predictionExpanded = !predictionExpanded;
    document.body.classList.toggle('prediction-expanded', predictionExpanded);
    if (predictionExpanded) {
        requestAnimationFrame(() => {
            requestAnimationFrame(sizeExpandedVideo);
        });
    } else {
        clearExpandedVideoSize();
    }
}

function sizeExpandedVideo() {
    if (!predictionExpanded) return;

    const area = document.querySelector('.prediction-video-area');
    const wrapper = document.querySelector('.prediction-webcam-wrapper');
    const column = document.querySelector('.prediction-main-column');
    if (!area || !wrapper) return;
    const r = area.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const padW = parseFloat(getComputedStyle(area).paddingLeft)
               + parseFloat(getComputedStyle(area).paddingRight);
    const padH = parseFloat(getComputedStyle(area).paddingTop)
               + parseFloat(getComputedStyle(area).paddingBottom);
    const size = Math.floor(Math.min(r.width - padW, r.height - padH));
    if (size > 0) {
        wrapper.style.width = size + 'px';
        wrapper.style.height = size + 'px';
        if (column) column.style.setProperty('--expanded-video-size', size + 'px');
    }
}

function clearExpandedVideoSize() {
    const wrapper = document.querySelector('.prediction-webcam-wrapper');
    if (wrapper) { wrapper.style.width = ''; wrapper.style.height = ''; }
    const column = document.querySelector('.prediction-main-column');
    if (column) column.style.removeProperty('--expanded-video-size');
}

window.addEventListener('resize', () => {
    if (predictionExpanded) sizeExpandedVideo();
});

document.addEventListener('click', () => {
    document.querySelectorAll('.class-dropdown.open').forEach(d => d.classList.remove('open'));
});

async function enterCaptureMode() {
    trainingFacingMode = 'user';
    predictionExpanded = false;
    document.body.classList.remove('prediction-expanded');

    stopPredictionLoop();
    closeMakeCode('makecodeInlineFrame');

    const isAudio = currentModel?.projectType === 'audio';
    const isPose = currentModel?.projectType === 'pose';

    if (isAudio) {
        audioTrainer.stopListening();
        audioTrainer.stopVisualizer();

        // Restore samples from IDB if counts are all 0
        const classes = audioTrainer.getClasses();
        const needLoad = classes.length > 0 && classes.every(c => c.count === 0);
        if (needLoad) await audioTrainer.loadSamples(currentModel.id);

        document.getElementById('trainingCaptureSection').classList.remove('hidden');
        renderTrainingClasses();
        showScreen('trainingScreen');
        await openAudioVisualizer();
    } else if (isPose) {
        const classes = poseTrainer.getClasses();
        const needLoad = classes.length > 0 && classes.every(c => c.count === 0);
        if (needLoad) await poseTrainer.loadSamples(currentModel.id);
        renderTrainingClasses();

        document.getElementById('trainingCaptureSection').classList.remove('hidden');
        showScreen('trainingScreen');
        await openCaptureWebcamWithSkeleton();
    } else {
        // Restaurar muestras desde IDB si no hay samples en memoria
        const classes = trainer.getClasses();
        const needLoad = classes.length > 0 && classes.every(c => c.count === 0);
        if (needLoad) await trainer.loadSamples(currentModel.id);
        renderTrainingClasses();

        showScreen('trainingScreen');
        openCaptureWebcam();
    }
}

function renderTrainingPredictions(predictions) {
    const container = document.getElementById('prediction-predictions');
    if (!container || !predictions?.length) return;

    // Find the winner without reordering
    let maxProb = -1;
    let winnerIdx = -1;
    predictions.forEach((pred, i) => {
        const prob = pred.probability ?? 0;
        if (prob > maxProb) { maxProb = prob; winnerIdx = i; }
    });

    container.innerHTML = predictions.map((pred, i) => {
        const pct = (pred.probability * 100).toFixed(1);
        const isWinner = (i === winnerIdx);
        const confColor = isWinner ? 'var(--color-primary-strong)' : '#888';
        return `
            <div class="prediction-item ${isWinner ? 'top' : ''}">
                <div class="prediction-item-header">
                    <span class="class-name">${escapeHtml(pred.className)}</span>
                    <span class="confidence" style="color:${confColor}">${pct}%</span>
                </div>
                <div class="confidence-bar">
                    <div class="confidence-fill" style="width: ${pct}%"></div>
                </div>
            </div>`;
    }).join('');

    if (isConnected() && winnerIdx >= 0) {
        const top = predictions[winnerIdx];
        sendToMicrobit(top.className, top.probability * 100);
    }
}

function updateClassUI(classIndex) {
    const card = document.querySelector(`#trainingClassesList [data-index="${classIndex}"]`);
    if (!card) return;
    const t = getTrainer();
    const c = t.getClasses()[classIndex];
    if (!c) return;

    const badge = card.querySelector('.sample-badge');
    if (badge) badge.textContent = `${c.count} muestras`;

    const nameInput = card.querySelector('.class-name-input');
    if (nameInput) autoSizeInput(nameInput);

    // Progress bar (all trainers)
    const fill = card.querySelector('.sample-progress-fill');
    if (fill) {
        fill.style.width = Math.min(100, (c.count / MIN_SAMPLES_PER_CLASS) * 100) + '%';
        fill.classList.toggle('ready', c.count >= MIN_SAMPLES_PER_CLASS);
    }

    const gallery = card.querySelector('.sample-gallery');
    if (gallery) {
        const samples = t.getSamples(classIndex);
        // Thumbs come from IndexedDB (user input): assign src as a property,
        // never interpolate them into the HTML template.
        gallery.innerHTML = samples.map(s => `
            <div class="sample-thumb">
                <img>
                <button class="btn-delete-sample" data-ci="${classIndex}" data-si="${s.index}">×</button>
            </div>
        `).join('');
        gallery.querySelectorAll('.sample-thumb img').forEach((img, i) => {
            img.src = samples[i].thumb;
        });
        gallery.querySelectorAll('.btn-delete-sample').forEach(btn => {
            btn.addEventListener('click', () => {
                t.deleteSample(+btn.dataset.ci, +btn.dataset.si);
                updateClassUI(classIndex);
                updateTrainButton();
            });
        });
    }

    updateTrainButton();
}

function setActiveCard(cardElement) {
    document.querySelectorAll('#trainingClassesList .training-class-card').forEach(c => {
        c.classList.remove('class-card-active');
    });
    if (cardElement) {
        cardElement.classList.add('class-card-active');
    }
}

// ============================================
// LISTA DE CLASES: HELPERS COMPARTIDOS
// ============================================

function getClassCards() {
    return Array.from(document.querySelectorAll('#trainingClassesList .training-class-card'));
}

function getClassCard(classIndex) {
    if (!Number.isInteger(classIndex)) return null;
    return document.querySelector(
        `#trainingClassesList .training-class-card[data-index="${classIndex}"]`
    );
}

/**
 * Deja el botón "Nueva clase" como último elemento de la lista de clases.
 *
 * Mueve el nodo que ya existe en vez de recrearlo, así conserva el listener
 * registrado una sola vez al cargar el módulo.
 */
function placeAddClassButton() {
    const container = document.getElementById('trainingClassesList');
    if (!container || !addClassBtn) return;
    container.appendChild(addClassBtn);
}

/**
 * Lleva el cursor al nombre de una clase.
 *
 * Tiene que correr de forma sincrónica dentro del handler del click: los
 * navegadores móviles (iOS en particular) solo abren el teclado para un focus()
 * hecho durante el gesto del usuario.
 */
function focusClassNameInput(classIndex) {
    // El guard de tipo vive en getClassCard(), que es quien arma el selector.
    // Si esta función alguna vez arma uno propio, tiene que repetirlo.
    const card = getClassCard(classIndex);
    if (!card) return;
    const input = card.querySelector('.class-name-input:not([disabled])');
    if (!input) {
        // La primera clase de audio tiene el nombre fijo y el input deshabilitado.
        // Si un registro rehidratado trajera '' ahí, el motivo se mostraría sin
        // forma de resolverlo: al menos se dice qué pasa en vez de no hacer nada.
        card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        showToast('Esa clase tiene el nombre fijo y no se puede editar.', 'error');
        return;
    }
    input.focus({ preventScroll: true });
    input.select();
    card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// ============================================
// PANEL "TODAVÍA NO SE PUEDE ENTRENAR"
// ============================================

function paintTrainBlockers(blockers) {
    // formatBlocker() puede traer un nombre escrito por el usuario: entra al
    // DOM por textContent, nunca por innerHTML. Devuelve '' para un tipo de
    // motivo sin texto; ese caso se descarta en vez de dejar un <li> vacío.
    const items = blockers
        .map(blocker => formatBlocker(blocker))
        .filter(text => text !== '')
        .map(text => {
            const li = document.createElement('li');
            li.textContent = text;
            return li;
        });
    trainBlockersList.replaceChildren(...items);
    const blocked = getBlockedClassIndices(blockers);
    getClassCards().forEach(card => {
        card.classList.toggle('class-card--blocked', blocked.has(+card.dataset.index));
    });
}

function hideTrainBlockers() {
    trainBlockersVisible = false;
    trainBlockersPanel.classList.add('hidden');
    trainBlockersList.replaceChildren();
    getClassCards().forEach(card => card.classList.remove('class-card--blocked'));
}

/**
 * Se llama al hacer click en Entrenar. Devuelve true si se puede entrenar.
 * Si no, abre el panel con los motivos, resalta las tarjetas involucradas y
 * lleva a la persona al primer problema.
 */
function checkTrainingReadiness() {
    const blockers = getTrainingBlockers(getTrainer().getClasses());
    if (blockers.length === 0) {
        hideTrainBlockers();
        return true;
    }
    trainBlockersVisible = true;
    trainBlockersPanel.classList.remove('hidden');
    paintTrainBlockers(blockers);

    const first = blockers.find(b => Number.isInteger(b.classIndex));
    if (first && first.type === BLOCKER_MISSING_NAME) {
        focusClassNameInput(first.classIndex);
    } else if (first) {
        const card = getClassCard(first.classIndex);
        if (card) card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    } else {
        trainBlockersPanel.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    return false;
}

/**
 * Actualización en vivo mientras el panel está abierto: se reevalúa después de
 * cada cambio y se cierra solo cuando ya no queda nada pendiente.
 */
function refreshTrainBlockers() {
    if (!trainBlockersVisible) return;
    const blockers = getTrainingBlockers(getTrainer().getClasses());
    if (blockers.length === 0) {
        hideTrainBlockers();
    } else {
        paintTrainBlockers(blockers);
    }
}

function renderTrainingClasses() {
    const projectType = currentModel?.projectType || 'image';
    const config = getConfig(projectType);
    const t = getTrainer();
    const container = document.getElementById('trainingClassesList');
    const cls = t.getClasses();

    container.innerHTML = cls.map((c, i) => {
        const color = getClassColor(i);
        const samples = t.getSamples(i);
        const isFixed = config.fixedFirstClass && i === 0;
        const pct = Math.min(100, (c.count / MIN_SAMPLES_PER_CLASS) * 100);

        const progressBarHTML = config.showProgressBar ? `
                <div class="sample-progress-wrap">
                    <div class="sample-progress-fill${c.count >= MIN_SAMPLES_PER_CLASS ? ' ready' : ''}" style="width:${pct}%"></div>
                </div>` : '';

        const menuHTML = isFixed ? '' : `
                    <div class="class-menu-wrapper">
                        <button class="btn-class-menu" data-index="${i}" title="Opciones">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="${color.icon}" stroke="none">
                                <circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/>
                            </svg>
                        </button>
                        <div class="class-dropdown">
                            <button class="class-dropdown-item btn-clear-samples" data-index="${i}"${c.count === 0 ? ' disabled' : ''}>
                                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                                    <path d="M20 5H9l-7 7 7 7h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2z"/><line x1="18" y1="9" x2="12" y2="15"/><line x1="12" y1="9" x2="18" y2="15"/>
                                </svg>
                                Borrar muestras
                            </button>
                            <button class="class-dropdown-item btn-delete-class-unified danger" data-index="${i}">
                                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                    <path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14"/>
                                </svg>
                                Eliminar clase
                            </button>
                        </div>
                    </div>`;

        return `
        <div class="training-class-card" data-index="${i}">
            <div class="class-card-header" style="background:${color.bg}; border-bottom-color:${color.badge};">
                <div class="class-card-header-left">
                    <div class="class-dot" style="background:${color.dot};"></div>
                    <input class="class-name-input" value="${escapeHtml(c.name)}" data-index="${i}"
                        placeholder="${escapeHtml(UNNAMED_CLASS_LABEL)}" aria-label="Nombre de la clase"
                        maxlength="${MAX_CLASS_NAME_BYTES}"
                        style="color:${color.headerText};" ${isFixed ? 'disabled' : ''}>
                    ${isFixed ? '' : '<span class="class-name-counter" hidden></span>'}
                    ${isFixed ? '' : `<svg class="pencil-edit-icon" width="12" height="12" viewBox="0 0 16 16" fill="none"
                        stroke="${color.headerText}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"
                        style="opacity: 0.45; flex-shrink: 0; cursor: pointer;">
                        <path d="M11.5 1.5l3 3L5 14H2v-3z"/><path d="M9.5 3.5l3 3"/>
                    </svg>`}
                </div>
                <div class="class-card-header-right">
                    <span class="sample-badge" data-index="${i}"
                        style="background:${color.badge}; color:${color.badgeText};">${c.count} muestras</span>
                    ${menuHTML}
                </div>
            </div>
            <div class="class-card-body">
                ${progressBarHTML}
                <div class="class-capture-buttons">
                    <button class="btn-capture-one-unified" data-index="${i}" style="background:${color.bg}; color:${color.headerText}; border-color:${color.badge};">
                        ${config.captureIcon}
                        ${config.captureOneLabel}
                    </button>
                    <button class="btn-capture-hold-unified" data-index="${i}" style="background:${color.btnFill};">
                        <span class="hold-dot"></span>
                        ${config.captureHoldLabel}
                    </button>
                </div>
                <div class="sample-gallery">
                    ${samples.map(s => `
                        <div class="sample-thumb">
                            <img>
                            <button class="btn-delete-sample" data-ci="${i}" data-si="${s.index}">×</button>
                        </div>
                    `).join('')}
                </div>
            </div>
        </div>`;
    }).join('');

    // Thumbs come from IndexedDB (user input): assign src as a property,
    // never interpolate them into the HTML template.
    container.querySelectorAll('.sample-gallery').forEach((gallery, ci) => {
        const samples = t.getSamples(ci);
        gallery.querySelectorAll('.sample-thumb img').forEach((img, si) => {
            img.src = samples[si].thumb;
        });
    });

    wireTrainingClassEvents(container, config, t);

    const firstCard = container.querySelector('.training-class-card');
    if (firstCard) setActiveCard(firstCard);

    placeAddClassButton();
    updateTrainButton();
    // Después de placeAddClassButton(): el resaltado se pinta sobre tarjetas
    // recién creadas, así que tiene que sobrevivir a cada render.
    refreshTrainBlockers();
}

function wireTrainingClassEvents(container, config, t) {
    // Activate card on click
    container.querySelectorAll('.training-class-card').forEach(card => {
        card.addEventListener('click', () => setActiveCard(card));
    });

    // Rename
    container.querySelectorAll('.class-name-input:not([disabled])').forEach(input => {
        const idx = () => +input.dataset.index;
        // Programmatic writes don't fire 'input', so the width and the counter
        // have to be refreshed by hand: field-sizing loses to the inline width
        // autoSizeInput() left behind for the text the user had typed.
        const setValue = (value) => {
            input.value = value;
            autoSizeInput(input);
            updateNameCounter(input);
        };
        const revert = () => setValue(t.getClasses()[idx()].name);

        // Live filter: drop unsafe characters and cap the byte length as the
        // user types, preserving the caret position.
        input.addEventListener('input', () => {
            const filtered = stripUnsafeChars(input.value).replace(/\s+/g, ' ');
            const capped = truncateToBytes(filtered, MAX_CLASS_NAME_BYTES);
            if (capped !== input.value) {
                const caret = input.selectionStart;
                const removed = input.value.length - capped.length;
                input.value = capped;
                const pos = Math.max(0, Math.min(capped.length, caret - removed));
                input.setSelectionRange(pos, pos);
            }
            updateNameCounter(input);
        });

        input.addEventListener('change', () => {
            const newName = normalizeClassName(input.value);
            if (!newName) {
                revert();
                return;
            }
            const names = t.getClassNames();
            if (newName === names[idx()]) {
                setValue(newName);
                return;
            }
            if (isDuplicateClassName(newName, names, idx())) {
                showToast('Ya existe una clase con ese nombre', 'error');
                revert();
                return;
            }
            if (config.renameRequiresTryCatch) {
                try {
                    t.renameClass(idx(), newName);
                } catch (e) {
                    showToast(e.message, 'error');
                    revert();
                    return;
                }
            } else {
                t.renameClass(idx(), newName);
            }
            persistClassNames();
            setValue(newName);
            // Ponerle nombre a una clase puede ser justo lo que faltaba.
            refreshTrainBlockers();
        });

        updateNameCounter(input);
    });

    // Auto-size name inputs to their content
    container.querySelectorAll('.class-name-input').forEach(input => {
        autoSizeInput(input);
        input.addEventListener('input', () => autoSizeInput(input));
    });

    // Dropdown open/close
    container.querySelectorAll('.btn-class-menu').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const dropdown = btn.closest('.class-menu-wrapper').querySelector('.class-dropdown');
            document.querySelectorAll('.class-dropdown.open').forEach(d => {
                if (d !== dropdown) d.classList.remove('open');
            });
            dropdown.classList.toggle('open');
        });
    });

    // Clear samples
    container.querySelectorAll('.btn-clear-samples').forEach(btn => {
        btn.addEventListener('click', () => {
            t.clearSamples(+btn.dataset.index);
            renderTrainingClasses();
            updateTrainButton();
            scheduleSampleSave();
            if (config.captureMode === 'audio') showToast('Muestras borradas', 'success');
        });
    });

    // Delete class
    container.querySelectorAll('.btn-delete-class-unified').forEach(btn => {
        btn.addEventListener('click', () => {
            if (t.getTotalClasses() <= MIN_CLASSES) {
                showToast(`Mínimo ${MIN_CLASSES} clases`, 'error');
                return;
            }
            if (config.captureMode === 'audio') {
                // Solo se pide la cancelación; el cierre lo hace el loop.
                batchRecordingCancelled = true;
            }
            t.removeClass(+btn.dataset.index);
            persistClassNames();
            renderTrainingClasses();
        });
    });

    // Delete individual sample
    container.querySelectorAll('.btn-delete-sample').forEach(btn => {
        btn.addEventListener('click', () => {
            const ci = +btn.dataset.ci;
            t.deleteSample(ci, +btn.dataset.si);
            updateClassUI(ci);
            updateTrainButton();
            scheduleSampleSave();
        });
    });

    // Pencil icon click — focus the name input
    container.querySelectorAll('.pencil-edit-icon').forEach(icon => {
        icon.addEventListener('click', () => {
            const card = icon.closest('.training-class-card');
            const input = card?.querySelector('.class-name-input');
            if (input) {
                input.focus();
                input.select();
            }
        });
    });

    // Capture one
    if (config.captureMode === 'audio') {
        container.querySelectorAll('.btn-capture-one-unified').forEach(btn => {
            btn.addEventListener('click', async () => {
                if (audioTrainer.getIsRecording() || batchRecordingActive) return;
                const ci = +btn.dataset.index;
                // El botón queda siempre activo, igual que Entrenar: el click
                // explica qué falta en vez de no hacer nada.
                if (!requireAudioClassName(ci)) return;

                const gen = openRecordModal(ci);
                try {
                    await recordWithCountdown(ci, gen);
                } finally {
                    // En el finally: una excepción del productor no puede dejar
                    // el modal abierto tapando la pantalla entera.
                    finishRecordingBatch();
                }
            });
        });
    } else {
        container.querySelectorAll('.btn-capture-one-unified').forEach(btn => {
            btn.addEventListener('click', () => {
                if (!activeWebcam || activeWebcamTarget !== 'capture') return;
                const ci = +btn.dataset.index;
                if (config.captureMode === 'webcam-skeleton') {
                    const ok = t.captureOne(ci, activeWebcam.canvas, activeWebcam.canvas, false);
                    if (!ok && config.captureOneFailMessage) {
                        showToast(config.captureOneFailMessage, 'info');
                    }
                } else {
                    t.captureOne(ci, activeWebcam.canvas);
                }
                updateClassUI(ci);
                scheduleSampleSave();
            });
        });
    }

    // Capture hold / batch
    if (config.captureMode === 'audio') {
        container.querySelectorAll('.btn-capture-hold-unified').forEach(btn => {
            const ci = +btn.dataset.index;
            btn.addEventListener('click', async () => {
                if (batchRecordingActive || audioTrainer.getIsRecording()) return;
                // El botón queda siempre activo, igual que Entrenar: el click
                // explica qué falta en vez de no hacer nada.
                if (!requireAudioClassName(ci)) return;

                btn.classList.add('capturing');
                const gen = openRecordModal(ci);
                try {
                    // La primera clase de audio es siempre el ruido de fondo
                    // (requisito de speech-commands). Es la única donde grabar
                    // de corrido tiene sentido: en las demás la regresiva es lo
                    // que le da tiempo a la docente a pronunciar la palabra.
                    if (ci === 0) {
                        await recordBatchContinuous(ci, gen, 10);
                    } else {
                        for (let n = 1; n <= 10; n++) {
                            if (recordingAborted(gen)) break;
                            await recordWithCountdown(ci, gen, n, 10);
                        }
                    }
                } finally {
                    // En el finally: una excepción del productor no puede dejar
                    // el modal abierto tapando la pantalla entera.
                    btn.classList.remove('capturing');
                    btn.innerHTML = '<span class="hold-dot"></span> ' + config.captureHoldLabel;
                    finishRecordingBatch();
                }
            });
        });
    } else {
        container.querySelectorAll('.btn-capture-hold-unified').forEach(btn => {
            const ci = +btn.dataset.index;
            btn.addEventListener('click', () => {
                if (!activeWebcam || activeWebcamTarget !== 'capture') return;
                if (btn.classList.contains('capturing')) {
                    btn.classList.remove('capturing');
                    t.stopCapture();
                    clearInterval(btn._updateInterval);
                    btn.innerHTML = '<span class="hold-dot"></span> ' + config.captureHoldLabel;
                    updateClassUI(ci);
                    scheduleSampleSave();
                } else {
                    container.querySelectorAll('.btn-capture-hold-unified.capturing').forEach(other => {
                        other.classList.remove('capturing');
                        clearInterval(other._updateInterval);
                        other.innerHTML = '<span class="hold-dot"></span> ' + config.captureHoldLabel;
                    });
                    btn.classList.add('capturing');
                    btn.innerHTML = '<span class="hold-dot"></span> Detener';
                    if (config.captureMode === 'webcam-skeleton') {
                        t.startCapture(ci, activeWebcam.canvas, activeWebcam.canvas, false);
                    } else {
                        t.startCapture(ci, activeWebcam.canvas);
                    }
                    btn._updateInterval = setInterval(() => updateClassUI(ci), 200);
                }
            });
        });
    }
}

// ============================================
// MODAL DE GRABACIÓN DE AUDIO
// ============================================

const audioRecordModal = document.getElementById('audioRecordModal');
const audioRecordStopBtn = document.getElementById('audioRecordStopBtn');
const RECORD_STOP_LABEL = 'Detener toma de muestras';

// La clase y la generación de la tanda en curso. La generación existe porque
// el cierre de emergencia (abajo) puede dejar un recordSample() colgado: si esa
// promesa despierta después, su generación ya no es la vigente y el loop sale
// sin grabar nada más, aunque para entonces ya haya empezado otra tanda.
let recordingClassIndex = null;
let recordingGeneration = 0;

/** true si la tanda de esta generación ya no debe seguir grabando. */
function recordingAborted(generation) {
    return generation !== recordingGeneration || batchRecordingCancelled;
}

/**
 * Pide detener la tanda. No interrumpe nada: solo levanta el flag que los
 * loops de grabación miran antes de cada paso. Una grabación ya empezada
 * termina y su muestra queda.
 *
 * Reutiliza batchRecordingCancelled, el flag que ya tenía el botón de cerrar
 * del overlay viejo, en vez de agregar uno nuevo.
 *
 * La SEGUNDA pulsación —y el segundo Escape— es la salida de emergencia. El
 * modal tapa el viewport entero, así que si el productor no vuelve (una
 * promesa de collectExample() que nunca resuelve porque la pestaña perdió el
 * micrófono) sin esto la única salida sería recargar la app, perdiendo lo que
 * estuviera dentro de la ventana del debounce. Lo grabado hasta acá ya está en
 * el trainer y se guarda igual.
 */
function requestRecordingStop() {
    if (!batchRecordingActive) return;
    if (batchRecordingCancelled) {
        finishRecordingBatch();
        return;
    }
    batchRecordingCancelled = true;
    audioRecordStopBtn.disabled = true;
    audioRecordStopBtn.textContent = 'Deteniendo…';
}

/** Abre el modal para una tanda nueva. Devuelve su generación. */
function openRecordModal(classIndex) {
    recordingClassIndex = classIndex;
    recordingGeneration++;
    batchRecordingActive = true;
    batchRecordingCancelled = false;
    audioRecordStopBtn.disabled = false;
    audioRecordStopBtn.textContent = RECORD_STOP_LABEL;
    audioRecordModal.classList.remove('hidden');
    audioRecordStopBtn.focus();
    return recordingGeneration;
}

audioRecordStopBtn.addEventListener('click', requestRecordingStop);

document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !audioRecordModal.classList.contains('hidden')) {
        requestRecordingStop();
    }
});

/**
 * Cierre de una tanda de grabación: por completarse, por detenerse o por la
 * salida de emergencia. Es el MISMO camino en los tres casos, y el guardado lo
 * dispara el productor —el loop—, no el botón de detener, que solo levanta el
 * flag. Los handlers lo llaman desde un `finally`, así que una excepción del
 * productor tampoco deja el modal abierto.
 *
 * Idempotente: batchRecordingActive es el testigo. Un loop que vuelve después
 * de un cierre de emergencia lo encuentra apagado y no rehace nada.
 *
 * NO baja batchRecordingCancelled: si quedó una grabación colgada, el flag en
 * true es lo que la hace salir cuando despierte. Lo reinicia openRecordModal()
 * al empezar la tanda siguiente.
 */
function finishRecordingBatch() {
    if (!batchRecordingActive) return;
    batchRecordingActive = false;
    audioRecordModal.classList.add('hidden');
    audioRecordStopBtn.disabled = false;
    audioRecordStopBtn.textContent = RECORD_STOP_LABEL;
    const classIndex = recordingClassIndex;
    recordingClassIndex = null;
    updateClassUI(classIndex);
    updateTrainButton();
    scheduleSampleSave();
}

/**
 * Una clase de audio sin nombre no se puede grabar: renameClass() del trainer
 * de audio tira si la clase ya tiene muestras, así que grabar primero dejaría
 * la clase trabada sin forma de nombrarla. Además el nombre ES la clave con la
 * que speech-commands indexa las muestras.
 */
function requireAudioClassName(classIndex) {
    const className = audioTrainer.getClassNames()[classIndex];
    if (typeof className === 'string' && className.trim() !== '') return true;
    showToast('La clase necesita un nombre antes de grabar.', 'info');
    focusClassNameInput(classIndex);
    return false;
}

/**
 * Graba varias muestras seguidas con UNA sola regresiva al principio.
 *
 * Para la clase de ruido de fondo la regresiva entre muestra y muestra no
 * aporta nada —no hay nada que pronunciar— y convierte diez muestras en unos
 * cuarenta segundos de espera. La regresiva inicial sí importa: le da a quien
 * graba unos segundos para dejar de hablar, así la primera muestra captura la
 * sala como suena y no el click del botón.
 */
async function recordBatchContinuous(classIndex, generation, total) {
    const numberEl = document.getElementById('countdownNumber');
    const labelEl = document.getElementById('countdownLabel');

    for (let i = 3; i >= 1; i--) {
        if (recordingAborted(generation)) return;
        numberEl.className = 'countdown-number';
        numberEl.textContent = i;
        labelEl.textContent = 'Silencio, por favor...';
        void numberEl.offsetWidth;
        numberEl.classList.add('pulse');
        await new Promise(r => setTimeout(r, 800));
    }

    if (recordingAborted(generation)) return;
    numberEl.className = 'countdown-number recording';
    numberEl.textContent = '🔴';

    for (let n = 1; n <= total; n++) {
        // Antes de cada muestra, nunca en el medio: una grabación empezada
        // termina y su muestra queda.
        if (recordingAborted(generation)) return;
        labelEl.textContent = `Ruido de fondo ${n}/${total}`;
        try {
            await audioTrainer.recordSample(classIndex);
        } catch (e) {
            console.error('Recording error:', e);
            break;
        }
    }

    numberEl.className = 'countdown-number done';
    numberEl.textContent = '✓';
    labelEl.textContent = 'Listo';
    await new Promise(r => setTimeout(r, 400));
}

async function recordWithCountdown(classIndex, generation, current = null, total = null) {
    const numberEl = document.getElementById('countdownNumber');
    const labelEl = document.getElementById('countdownLabel');

    for (let i = 3; i >= 1; i--) {
        if (recordingAborted(generation)) return;
        numberEl.className = 'countdown-number';
        numberEl.textContent = i;
        labelEl.textContent = (current !== null && total !== null)
            ? `Muestra ${current}/${total}`
            : 'Prepárate...';
        // Re-trigger animation by forcing reflow
        void numberEl.offsetWidth;
        numberEl.classList.add('pulse');
        await new Promise(r => setTimeout(r, 800));
    }

    if (recordingAborted(generation)) return;
    numberEl.className = 'countdown-number recording';
    numberEl.textContent = '🔴';
    labelEl.textContent = '¡GRABANDO!';

    try {
        await audioTrainer.recordSample(classIndex);
    } catch (e) {
        console.error('Recording error:', e);
    }

    numberEl.className = 'countdown-number done';
    numberEl.textContent = '✓';
    labelEl.textContent = 'Listo';

    await new Promise(r => setTimeout(r, 400));
}

/**
 * Guarda los nombres de clase del proyecto abierto.
 *
 * Se llama en cada cambio estructural —crear las clases por defecto, agregar,
 * renombrar, borrar— y no despues de capturar: las muestras tienen su propio
 * camino con debounce. Sin esto, un proyecto sin entrenar vuelve como nuevo y
 * sus muestras guardadas quedan huerfanas.
 */
function persistClassNames() {
    if (!currentModel) return;
    try {
        const updated = updateProjectClassNames(currentModel.id, getTrainer().getClassNames());
        if (updated) currentModel = updated;
    } catch (e) {
        console.error('[app] No se pudieron guardar los nombres de clase:', e);
        // StorageQuotaError ya trae un mensaje en español pensado para el usuario.
        // Cualquier otro error trae texto en inglés y de biblioteca: no se muestra.
        showToast(
            e instanceof StorageQuotaError ? e.message : 'No se pudieron guardar los cambios.',
            'error'
        );
    }
}

/**
 * Todo lo que hay que hacer al abandonar la pantalla de captura, sea para
 * volver al home o para ir a programar la placa.
 *
 * Un hold de webcam/pose captura por su cuenta con un setInterval propio del
 * trainer (~5 fps) que nunca pasa por scheduleSampleSave(): eso solo corre en
 * la rama que responde al click de "Detener". Si se sale de la pantalla con un
 * hold todavía activo, sampleSaveDirty sigue en false y flushSampleSave() no
 * escribiría nada. Por eso el guardado se fuerza, y se apaga cualquier ticker
 * de UI de un hold activo (btn._updateInterval) antes de tocar el DOM, para
 * que no siga actualizando tarjetas ajenas si el próximo proyecto reutiliza
 * los mismos data-index.
 */
async function leaveCaptureScreen() {
    // Solo se pide la cancelación; el cierre lo hace el loop.
    batchRecordingCancelled = true;
    document.querySelectorAll('.btn-capture-hold-unified.capturing').forEach(btn => {
        clearInterval(btn._updateInterval);
    });
    scheduleSampleSave();
    await flushSampleSave();
}

function scheduleSampleSave() {
    if (!currentModel) return;
    sampleSaveDirty = true;
    if (sampleSaveTimer) clearTimeout(sampleSaveTimer);
    sampleSaveTimer = setTimeout(() => { flushSampleSave(); }, 1500);
}

/**
 * Cancela el guardado pendiente sin escribir.
 *
 * Lo usa el entrenamiento: train() vacia las muestras en memoria del trainer de
 * imagen, asi que un timer que sobreviva al inicio del entrenamiento escribiria
 * un dataset vacio encima del bueno.
 */
function cancelPendingSampleSave() {
    if (sampleSaveTimer) clearTimeout(sampleSaveTimer);
    sampleSaveTimer = null;
    sampleSaveDirty = false;
}

/**
 * Escribe ahora si hay algo pendiente. Devuelve una promesa que resuelve cuando
 * la escritura termino, para poder esperarla antes de dispose().
 */
async function flushSampleSave() {
    const wasDirty = sampleSaveDirty;
    cancelPendingSampleSave();
    if (!wasDirty || !currentModel) return sampleSaveChain;

    const id = currentModel.id;
    const t = getTrainer();
    sampleSaveChain = sampleSaveChain.then(async () => {
        try {
            await t.saveSamples(id);
        } catch (e) {
            console.error('[app] No se pudieron guardar las muestras:', e);
            showToast('No se pudieron guardar las muestras. Puede que no quede espacio en el navegador.', 'error');
        }
    });
    return sampleSaveChain;
}

/**
 * El botón Entrenar está SIEMPRE activo: faltar clases, nombres o muestras ya
 * no lo deshabilita, porque un botón gris no dice qué falta. El click valida
 * con getTrainingBlockers() y abre el panel de motivos (checkTrainingReadiness).
 *
 * Lo único que lo bloquea es no poder entrenar en ese instante: un
 * entrenamiento ya en curso, o el loop de predicción de un modelo de cámara,
 * que le tiene tomada la webcam.
 */
function updateTrainButton() {
    const isCameraModel = currentModel?.projectType !== 'audio';

    const trainBtn = document.getElementById('trainBtn');
    const label = trainBtn.querySelector('.train-label');

    trainBtn.disabled = trainingInProgress || (isCameraModel && predictionLoopRunning);
    trainBtn.title = '';
    // Con un modelo ya entrenado, entrenar es reentrenar — y al lado aparece la
    // vía para ir a programar la placa SIN volver a entrenar.
    label.textContent = modelReadyForProgramming ? 'Reentrenar' : 'Entrenar';
    goProgramBtn.classList.toggle('hidden', !modelReadyForProgramming);

    refreshTrainBlockers();
}

// ============================================
// MODAL: PROBAR MODELO
// ============================================

async function openPreviewModal() {
    const modal = document.getElementById('previewModal');
    const subtitle = document.getElementById('previewModalSubtitle');
    const wrapper = document.getElementById('previewVisorWrapper');
    const cardsContainer = document.getElementById('previewClassCards');
    const t = getTrainer();
    const projectType = currentModel.projectType;
    const classNames = t.getClassNames();

    if (subtitle) subtitle.textContent = `${currentModel.name} — ${classNames.length} clases entrenadas`;

    cardsContainer.innerHTML = classNames.map((name, i) => {
        const color = getClassColor(i).dot;
        return `
            <div class="preview-class-card" id="previewCard-${i}" data-color="${color}">
                <div class="preview-class-card-header">
                    <div class="preview-class-dot" style="background: ${color};"></div>
                    <span class="preview-class-name">${escapeHtml(displayClassName(name))}</span>
                    <span class="preview-class-pct" id="previewPct-${i}" style="color: #888;">0%</span>
                </div>
                <div class="preview-conf-track">
                    <div class="preview-conf-fill" id="previewFill-${i}" style="width: 0%; background: ${color};"></div>
                </div>
            </div>`;
    }).join('');

    modal.classList.remove('hidden');
    wrapper.innerHTML = '';

    const previewFlip = document.getElementById('previewFlipBtn');
    if (previewFlip) previewFlip.style.display = projectType === 'audio' ? 'none' : '';

    if (projectType === 'audio') {
        await startPreviewAudio(wrapper, classNames);
    } else if (projectType === 'pose') {
        await startPreviewPose(wrapper, classNames);
    } else {
        await startPreviewImage(wrapper, classNames);
    }
}

async function startPreviewImage(wrapper, classNames) {
    previewWebcam = new Webcam(trainingFacingMode === 'user');
    await previewWebcam.setup(trainingFacingMode);
    await previewWebcam.play();
    wrapper.appendChild(previewWebcam.canvas);

    previewLoopRunning = true;
    let inFlight = false;
    const t = getTrainer();

    function loop() {
        if (!previewLoopRunning) return;
        if (!previewWebcam) return;
        previewWebcam.update();
        if (!inFlight) {
            inFlight = true;
            t.predict(previewWebcam.canvas)
                .then(preds => { inFlight = false; renderPreviewPredictions(preds, classNames); })
                .catch(() => { inFlight = false; });
        }
        requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);
}

async function startPreviewPose(wrapper, classNames) {
    previewWebcam = new Webcam(trainingFacingMode === 'user');
    await previewWebcam.setup(trainingFacingMode);
    await previewWebcam.play();

    const displayCanvas = document.createElement('canvas');
    displayCanvas.width = previewWebcam.width;
    displayCanvas.height = previewWebcam.height;
    const displayCtx = displayCanvas.getContext('2d');
    wrapper.appendChild(displayCanvas);

    previewLoopRunning = true;
    let inFlight = false;
    const t = getTrainer();

    function loop() {
        if (!previewLoopRunning) return;
        if (!previewWebcam) return;
        previewWebcam.update();
        displayCtx.drawImage(previewWebcam.canvas, 0, 0, previewWebcam.width, previewWebcam.height);
        const landmarks = poseTrainer.getLastLandmarks();
        if (landmarks) poseTrainer.drawSkeleton(displayCtx, landmarks, previewWebcam.width, previewWebcam.height, false);
        if (!inFlight) {
            inFlight = true;
            t.predict(previewWebcam.canvas)
                .then(preds => { inFlight = false; renderPreviewPredictions(preds, classNames); })
                .catch(() => { inFlight = false; });
        }
        requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);
}

async function startPreviewAudio(wrapper, classNames) {
    previewAudioVisualizerCanvas = document.createElement('canvas');
    previewAudioVisualizerCanvas.width = 400;
    previewAudioVisualizerCanvas.height = 300;
    previewAudioVisualizerCanvas.style.width = '100%';
    previewAudioVisualizerCanvas.style.height = '100%';
    previewAudioVisualizerCanvas.style.objectFit = 'contain';
    wrapper.appendChild(previewAudioVisualizerCanvas);

    await audioTrainer.startVisualizer(previewAudioVisualizerCanvas);
    await audioTrainer.startListening(preds => renderPreviewPredictions(preds, classNames));
    previewLoopRunning = true;
}

function renderPreviewPredictions(predictions, classNames) {
    if (!predictions || !predictions.length) return;

    // Build name → probability map. Audio predictions arrive in alphabetical
    // order (from transfer.wordLabels()), while preview cards were rendered
    // in creation order. Matching by name avoids the label-swap bug.
    const probByName = new Map();
    let maxProb = -1;
    let winnerName = null;
    predictions.forEach(pred => {
        const prob = pred.probability ?? pred.score ?? 0;
        probByName.set(pred.className, prob);
        if (prob > maxProb) { maxProb = prob; winnerName = pred.className; }
    });

    classNames.forEach((name, i) => {
        const prob = probByName.get(name) ?? 0;
        const pct = Math.round(prob * 100);
        const card = document.getElementById(`previewCard-${i}`);
        const pctEl = document.getElementById(`previewPct-${i}`);
        const fillEl = document.getElementById(`previewFill-${i}`);
        if (!card || !pctEl || !fillEl) return;

        pctEl.textContent = `${pct}%`;
        fillEl.style.width = `${pct}%`;

        if (name === winnerName) {
            card.classList.add('winner');
            card.style.borderLeftColor = card.dataset.color;
            pctEl.style.color = card.dataset.color;
        } else {
            card.classList.remove('winner');
            card.style.borderLeftColor = 'transparent';
            pctEl.style.color = '#888';
        }
    });
}

function closePreviewModal() {
    const modal = document.getElementById('previewModal');
    const wrapper = document.getElementById('previewVisorWrapper');
    const projectType = currentModel?.projectType;

    previewLoopRunning = false;

    if (projectType === 'audio') {
        audioTrainer.stopListening();
        audioTrainer.stopVisualizer();
        previewAudioVisualizerCanvas = null;
    } else {
        if (previewWebcam) {
            previewWebcam.stop();
            previewWebcam = null;
        }
    }

    wrapper.innerHTML = '';
    modal.classList.add('hidden');

    // Volver del preview a entrenamiento es el primer momento en que se ve el
    // botón de programar. En audio no se re-renderizan las clases al terminar
    // de entrenar, así que este es el único punto que lo cubre en los tres.
    updateTrainButton();
}

// ============================================
// UTILITIES
// ============================================

/**
 * Fija el ancho del input al de su contenido, midiendo el texto en un span
 * invisible.
 *
 * Las propiedades tipográficas se copian del propio input con
 * getComputedStyle(): estaban hardcodeadas y no coincidían con el CSS
 * (0.875rem/600 contra 0.95rem/700), así que el ancho calculado quedaba corto
 * en proporción al largo del texto y a partir de cierto largo recortaba la
 * última letra. Copiarlas mantiene la medición correcta aunque el CSS cambie.
 *
 * Se copian una por una y no con el atajo `font`: getComputedStyle().font
 * devuelve cadena vacía en algunos navegadores cuando la familia es una lista.
 */
function autoSizeInput(input) {
    const cs = getComputedStyle(input);

    const measure = document.createElement('span');
    measure.style.cssText = 'visibility:hidden;position:absolute;white-space:pre;padding:0;border:0;';
    measure.style.fontFamily = cs.fontFamily;
    measure.style.fontSize = cs.fontSize;
    measure.style.fontWeight = cs.fontWeight;
    measure.style.fontStyle = cs.fontStyle;
    measure.style.letterSpacing = cs.letterSpacing;

    document.body.appendChild(measure);
    measure.textContent = input.value || input.placeholder || ' ';
    // El +4 deja lugar para el redondeo de offsetWidth y el caret. Ahora es un
    // margen de holgura y no una compensación: la medición ya es correcta.
    input.style.width = (measure.offsetWidth + 4) + 'px';
    document.body.removeChild(measure);
}

/**
 * Updates the byte counter next to a class-name input. Hidden until the name
 * approaches the limit, so the normal case shows no clutter.
 */
function updateNameCounter(input) {
    const card = input.closest('.training-class-card');
    const counter = card ? card.querySelector('.class-name-counter') : null;
    if (!counter) return;
    const used = byteLength(input.value);
    counter.textContent = `${used}/${MAX_CLASS_NAME_BYTES}`;
    counter.hidden = used < MAX_CLASS_NAME_BYTES - 3;
    counter.classList.toggle('at-limit', used >= MAX_CLASS_NAME_BYTES);
}

/**
 * Un proyecto cuyo puntero al modelo se descartó vuelve como no entrenado
 * aunque el docente lo haya entrenado. Sin decirlo, la pantalla parece haber
 * perdido el trabajo; el mensaje es la única señal de que las muestras están y
 * de qué falta hacer.
 *
 * El mensaje se decide con las muestras que efectivamente se cargaron, no con
 * las clases: loadSamples() sale en silencio cuando la clave no está, cuando el
 * valor no valida y cuando la carga tira, y prometer muestras que no volvieron
 * es peor que no decir nada — la docente cree que el error es de ella.
 */
function showReadyToast(needsRetrain, samplesLoaded) {
    if (!needsRetrain) {
        showToast('Listo', 'success');
        return;
    }
    if (samplesLoaded > 0) {
        showToast('Recuperamos tus clases y tus muestras. Entrená de nuevo para volver a usar el modelo.', 'info');
    } else {
        showToast('Recuperamos tus clases, pero no encontramos las muestras guardadas. Vas a tener que capturarlas de nuevo.', 'error');
    }
}

function formatDate(isoString) {
    // La frontera preserva createdAt con el tipo que tenga, así que acá puede
    // llegar null, 0 o false — que NO dan Invalid Date, dan la época, y la card
    // mostraría "1 ene 1970". Solo un string tiene sentido como fecha guardada.
    if (typeof isoString !== 'string') return '';

    const date = new Date(isoString);
    if (Number.isNaN(date.getTime())) return '';

    const now = new Date();
    const days = Math.floor((now - date) / (1000 * 60 * 60 * 24));

    if (days === 0) return 'Hoy';
    if (days === 1) return 'Ayer';
    if (days < 7) return `Hace ${days} días`;

    return date.toLocaleDateString('es-ES', {
        year: 'numeric',
        month: 'short',
        day: 'numeric'
    });
}

function showToast(message, type = 'info') {
    const toast = document.getElementById('statusToast');
    toast.textContent = message;
    toast.className = `toast ${type} show`;
    setTimeout(() => toast.classList.remove('show'), 3000);
}

// ============================================
// EVENT LISTENERS
// ============================================

// Listener de nivel superior, no dentro de renderModels(): esa función corre
// muchas veces por sesión y registraría un handler nuevo en cada render.
document.getElementById('quarantineNoticeDismiss').addEventListener('click', () => {
    if (!acknowledgeQuarantine()) {
        // Devuelve false cuando la cuarentena no está persistida o el acuse no
        // se pudo escribir. En los dos casos apagar el aviso sería mentir.
        showToast('No pudimos marcar el aviso como visto. Avisale al equipo del programa.', 'error');
        return;
    }
    renderModels();
});

// Home: open type selection modal
document.getElementById('newModelBtn').addEventListener('click', () => {
    document.getElementById('projectTypeModal').classList.remove('hidden');
});

// Project type modal
document.getElementById('closeTypeModalBtn').addEventListener('click', () => {
    document.getElementById('projectTypeModal').classList.add('hidden');
});

document.getElementById('typeTrainBtn').addEventListener('click', () => {
    pendingProjectType = 'image';
    document.getElementById('projectTypeModal').classList.add('hidden');
    document.getElementById('trainNameModal').classList.remove('hidden');
    document.getElementById('trainProjectName').value = '';
    document.getElementById('trainProjectName').focus();
});

document.getElementById('typeAudioTrainBtn').addEventListener('click', () => {
    pendingProjectType = 'audio';
    document.getElementById('projectTypeModal').classList.add('hidden');
    document.getElementById('trainNameModal').classList.remove('hidden');
    document.getElementById('trainProjectName').value = '';
    document.getElementById('trainProjectName').focus();
});

document.getElementById('typePoseTrainBtn').addEventListener('click', () => {
    pendingProjectType = 'pose';
    document.getElementById('projectTypeModal').classList.add('hidden');
    document.getElementById('trainNameModal').classList.remove('hidden');
    document.getElementById('trainProjectName').value = '';
    document.getElementById('trainProjectName').focus();
});

// Train name modal
document.getElementById('closeTrainNameBtn').addEventListener('click', () => {
    document.getElementById('trainNameModal').classList.add('hidden');
});

document.getElementById('cancelTrainNameBtn').addEventListener('click', () => {
    document.getElementById('trainNameModal').classList.add('hidden');
});

document.getElementById('startTrainingBtn').addEventListener('click', async () => {
    const name = document.getElementById('trainProjectName').value.trim();
    if (!name) {
        showToast('Ingresa un nombre', 'error');
        return;
    }

    document.getElementById('trainNameModal').classList.add('hidden');

    currentModel = addProject(name, pendingProjectType);
    renderModels();
    await openTrainingScreen(currentModel);
});

document.getElementById('trainProjectName').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') document.getElementById('startTrainingBtn').click();
});

// Training screen
document.getElementById('trainingBackBtn').addEventListener('click', async () => {
    // Antes de dispose(): dispose() llama a stopCapture() y vacia classes.
    await leaveCaptureScreen();
    closeCaptureWebcamSilent();
    audioTrainer.stopListening();
    audioTrainer.stopVisualizer();
    disconnectMicrobit();
    trainer.dispose();
    audioTrainer.dispose();
    poseTrainer.dispose();
    hideTrainBlockers();
    // Los dispose() de arriba dejaron los trainers vacíos: el próximo proyecto
    // decide de nuevo si tiene modelo.
    modelReadyForProgramming = false;
    trainedClassesSignature = null;
    trainedClassNames = null;
    // Vacía la lista con el botón "Nueva clase" adentro. El nodo sigue vivo en
    // addClassBtn y el próximo render lo vuelve a insertar.
    document.getElementById('trainingClassesList').innerHTML = '';
    trainingFacingMode = 'user';
    renderModels();
    showScreen('homeScreen');
});

// Prediction screen
document.getElementById('predictionBackBtn').addEventListener('click', () => {
    stopPredictionLoop();
    audioTrainer.stopListening();
    audioTrainer.stopVisualizer();
    poseTrainer.dispose();
    closeMakeCode('makecodeInlineFrame');
    disconnectMicrobit();
    predictionExpanded = false;
    document.body.classList.remove('prediction-expanded');
    renderModels();
    showScreen('homeScreen');
});

document.getElementById('predictionRetrainBtn').addEventListener('click', async () => {
    await enterCaptureMode();
});

// Preview modal buttons
document.getElementById('previewProgramBtn').addEventListener('click', () => {
    closePreviewModal();
    openPredictionScreen(currentModel);
});

document.getElementById('previewBackBtn').addEventListener('click', async () => {
    closePreviewModal();
    // Restart the training-screen webcam/visualizer that was stopped before training
    const projectType = currentModel?.projectType;
    if (projectType === 'audio') {
        await openAudioVisualizer();
    } else if (projectType === 'pose') {
        await openCaptureWebcamWithSkeleton();
    } else {
        await openCaptureWebcam();
    }
});

document.getElementById('predictionFlipBtn').addEventListener('click', () => flipTrainingCamera());
document.getElementById('predictionExpandBtn').addEventListener('click', togglePredictionExpanded);
document.getElementById('captureFlipBtn').addEventListener('click', () => { if (currentModel?.projectType !== 'audio') flipCaptureCamera(); });
document.getElementById('previewFlipBtn').addEventListener('click', () => { if (currentModel?.projectType !== 'audio') flipPreviewCamera(); });

addClassBtn.addEventListener('click', () => {
    const t = getTrainer();
    // La clase nace SIN nombre. No se autogenera "Clase N" ni se guarda
    // "Clase sin nombre": esa etiqueta es solo de presentación (el placeholder
    // del input) y dos clases nuevas con el mismo nombre se rechazarían como
    // duplicadas — en audio, además, el nombre es la clave con la que el
    // recognizer indexa las muestras.
    const index = t.addClass('');
    persistClassNames();
    renderTrainingClasses();
    const card = getClassCard(index);
    if (card) setActiveCard(card);
    // Sincrónico dentro del click: iOS solo abre el teclado para un focus()
    // hecho durante el gesto del usuario.
    focusClassNameInput(index);
});

goProgramBtn.addEventListener('click', async () => {
    if (!currentModel || !modelReadyForProgramming || goProgramBtn.disabled) return;

    const classes = getTrainer().getClasses();

    // Para programar, el modelo tiene que estar al día. CUALQUIER diferencia
    // entre lo que se ve y lo que el modelo aprendió corta el paso, por dos
    // motivos de peso distinto:
    //
    //   - Agregar, borrar o renombrar una clase CORRE el mapeo salida→nombre.
    //     Los tres trainers etiquetan por índice contra su lista viva, así que
    //     la placa recibiría el nombre de otra clase sin que nada lo delate.
    //   - Muestras de más o de menos no corren nada, pero dejan la pantalla
    //     mostrando un modelo que no es el que está en la placa. Programar
    //     desde ahí es programar a ciegas.
    //
    // Reentrenar es lo que confirma los cambios. La regla es una sola y se
    // explica en una línea, que es lo que la hace enseñable.
    const namesChanged = classNamesDiverged(trainedClassNames, classes);
    if (namesChanged || hasUntrainedChanges(trainedClassesSignature, classes)) {
        showToast(
            namesChanged
                ? 'Cambiaste las clases: reentrená para poder programar la placa.'
                : 'Cambiaste las muestras: reentrená para poder programar la placa.',
            'error'
        );
        return;
    }

    // Sin guard, dos toques seguidos abren dos pantallas de predicción y la
    // segunda webcam queda huérfana con la luz prendida.
    goProgramBtn.disabled = true;
    try {
        await leaveCaptureScreen();
        await openPredictionScreen(currentModel);
    } finally {
        goProgramBtn.disabled = false;
    }
});

document.getElementById('trainBtn').addEventListener('click', async () => {
    const btn = document.getElementById('trainBtn');
    const isAudio = currentModel?.projectType === 'audio';
    const t = getTrainer();

    if (trainingInProgress) return;
    // El botón está siempre activo: acá es donde se explica qué falta, antes de
    // tocar la webcam, el audio o el guardado de muestras.
    if (!checkTrainingReadiness()) return;

    trainingInProgress = true;

    if (isAudio) {
        audioTrainer.stopListening();
    } else {
        closeCaptureWebcamSilent();
    }

    btn.disabled = true;

    // Show training overlay
    const overlay = document.getElementById('trainingOverlay');
    const overlayPct = document.getElementById('trainingOverlayPct');
    const overlayLabel = overlay.querySelector('.training-overlay-label');
    overlayPct.className = 'training-overlay-pct';
    overlayPct.textContent = '0%';
    overlayLabel.textContent = 'Entrenando modelo...';
    overlay.classList.remove('hidden');

    // El guardado explicito manda; lo que haya pendiente se descarta en vez
    // de escribirse, porque train() vacia las muestras en memoria del
    // trainer de imagen y un timer tardio escribiria un dataset vacio.
    cancelPendingSampleSave();
    // La huella se toma ANTES de train(): el de imagen vacía las muestras en
    // memoria, así que después el conteo sería cero hasta el loadSamples() de
    // más abajo. Este es el estado que el modelo va a haber visto.
    const signatureBeingTrained = classesSignature(t.getClasses());
    const namesBeingTrained = t.getClassNames();
    try {
        await t.saveSamples(currentModel.id);
    } catch (e) {
        console.error('[app] No se pudieron guardar las muestras antes de entrenar:', e);
        overlay.classList.add('hidden');
        overlayLabel.textContent = 'Entrenando modelo...';
        showToast('No se pudieron guardar las muestras. Puede que no quede espacio en el navegador.', 'error');
        trainingInProgress = false;
        btn.disabled = false;
        return;
    }

    try {
        await t.train((epoch, total) => {
            const pct = Math.round((epoch + 1) / total * 100);
            overlayPct.textContent = `${pct}%`;
        });

        // Show completion briefly
        overlayPct.classList.add('done');
        overlayPct.textContent = '✓';
        overlayLabel.textContent = 'Modelo entrenado';
        await new Promise(r => setTimeout(r, 600));

        const localModelInfo = await t.saveModel(currentModel.id);
        // `trainedSignature` es aditivo sobre localModel: la frontera de
        // rehidratación preserva los campos que no conoce, así que no cambia
        // PROJECT_SCHEMA_VERSION y un build viejo lo ignora sin romperse.
        const updated = updateProjectModel(currentModel.id, {
            ...localModelInfo,
            trainedSignature: signatureBeingTrained,
            trainedClassNames: namesBeingTrained
        });
        if (updated) currentModel = updated;
        // A partir de acá el proyecto tiene modelo: "Entrenar" pasa a
        // "Reentrenar" y aparece "Programar micro:bit" al volver del preview.
        modelReadyForProgramming = true;
        trainedClassesSignature = signatureBeingTrained;
        trainedClassNames = namesBeingTrained;
        renderModels();

        overlay.classList.add('hidden');
        overlayLabel.textContent = 'Entrenando modelo...';

        // Reload samples so the training screen is ready when the user closes the modal
        if (currentModel.projectType !== 'audio') {
            await t.loadSamples(currentModel.id);
            renderTrainingClasses();
        }

        await openPreviewModal();

    } catch (error) {
        console.error('Training error:', error);
        overlay.classList.add('hidden');
        overlayLabel.textContent = 'Entrenando modelo...';
        showToast(error.message, 'error');

        if (isAudio && audioTrainer.isTrained()) {
            await audioTrainer.startListening(preds => renderTrainingPredictions(preds));
        }
    }

    trainingInProgress = false;
    btn.disabled = false;
});


// Prediction screen — bluetooth toggle
document.getElementById('predictionConnectBtn').addEventListener('click', async () => {
    const btn = document.getElementById('predictionConnectBtn');
    if (isConnected()) {
        disconnectMicrobit();
    } else {
        try {
            await connectMicrobit();
            btn.classList.add('connected');
            btn.textContent = '❌ Desconectar';
        } catch (error) {
            showToast('Error al conectar', 'error');
        }
    }
});

// ============================================
// INIT
// ============================================

document.addEventListener('DOMContentLoaded', () => {
    renderModels();
});

// ============================================
// SERVICE WORKER (PWA / offline)
// ============================================

if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js')
            .then(reg => console.log('[SW] Registrado, scope:', reg.scope))
            .catch(err => console.warn('[SW] Registro falló:', err));
    });
}

export { showToast };
