/**
 * predictions.js
 * Manages webcam, audio, and model predictions
 * Supports image, pose, and audio models from Teachable Machine
 */

import { getModel, getModelType } from './model-loader.js';
import { sendToMicrobit, isConnected } from './bluetooth.js';

// State
let webcam = null;
let predictionCanvas = null; // offscreen 200x200 canvas for pose prediction
let isRunning = false;
let currentFacingMode = 'user'; // 'user' = front camera, 'environment' = back camera
let audioContext = null;
let analyser = null;
let microphone = null;
let predictionInFlight = false; // prevents concurrent ML inference calls
let lastPose = null;            // last pose result, drawn every frame for smooth overlay

// Configurable element IDs — can be overridden to embed predictions in other screens
let wrapperElementId = 'webcam-wrapper';
let containerElementId = 'predictions';

/**
 * Override which DOM elements predictions.js writes to.
 * Call before startPredictions(). Resets to defaults on stopPredictions().
 */
function configurePredictions({ wrapperElementId: wId, containerElementId: cId } = {}) {
    if (wId) wrapperElementId = wId;
    if (cId) containerElementId = cId;
}

/**
 * Replace the TM Webcam's internal stream with an environment-facing stream.
 * Called after webcam.setup() which always opens the front camera.
 *
 * Key points:
 *  - No 'exact' facingMode constraint → maximum Android/iOS compatibility
 *  - Short delay after stopping tracks → Android needs ~200 ms to release the
 *    camera hardware before another stream can be opened
 *  - No play() call here → webcam.play() is the sole caller; a double play()
 *    causes AbortError on Chrome Android and triggers the error toast
 *  - Object.values() to find the HTMLVideoElement → works regardless of the
 *    internal property name used by different TM library builds
 */
async function applyEnvironmentCamera(webcamInstance) {
    // Locate the internal <video> element regardless of TM version property name.
    // TM image/pose v0.8.x stores it as 'webcam'; other builds may use 'video'.
    const videoEl = Object.values(webcamInstance).find(v => v instanceof HTMLVideoElement);

    // Stop the active stream — the real stream lives on the video element's srcObject,
    // not on a separate 'stream' property (TM v0.8.x has no such property).
    const activeStream = (videoEl && videoEl.srcObject) || webcamInstance.stream;
    if (activeStream) {
        activeStream.getTracks().forEach(t => t.stop());
    }
    if (webcamInstance.stream) webcamInstance.stream = null;
    if (videoEl) videoEl.srcObject = null;

    // Wait for the camera hardware to fully release (important on Android)
    await new Promise(r => setTimeout(r, 200));

    // Request the back camera — no 'exact' so the browser can fall back gracefully
    const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
            facingMode: 'environment',
            width: { ideal: webcamInstance.width || 400 },
            height: { ideal: webcamInstance.height || 400 }
        }
    });

    if (webcamInstance.stream !== undefined) webcamInstance.stream = stream;
    if (videoEl) {
        videoEl.srcObject = stream;
        // Do NOT call play() here — webcam.play() is called next and must be
        // the only caller; duplicate play() causes AbortError on Chrome Android
    }
}

/**
 * Start predictions based on model type
 */
async function startPredictions() {
    const modelType = getModelType();
    isRunning = true;
    
    console.log(`▶️ Starting predictions for model type: ${modelType}`);
    
    if (modelType === 'image') {
        await setupWebcam();
    } else if (modelType === 'pose') {
        await setupPoseWebcam();
    } else if (modelType === 'audio') {
        await setupAudio();
    }
}

/**
 * Stop all predictions and cleanup resources
 */
function stopPredictions() {
    isRunning = false;
    predictionInFlight = false;
    lastPose = null;

    // Reset element IDs to defaults so the next caller starts clean
    wrapperElementId = 'webcam-wrapper';
    containerElementId = 'predictions';

    // Cleanup webcam — explicitly stop MediaStream tracks since TM's webcam.stop()
    // only pauses the video element and doesn't release the camera hardware
    if (webcam) {
        const videoEl = Object.values(webcam).find(v => v instanceof HTMLVideoElement);
        const activeStream = (videoEl && videoEl.srcObject) || webcam.stream;
        if (activeStream) {
            activeStream.getTracks().forEach(t => t.stop());
        }
        webcam.stop();
        webcam = null;
    }
    predictionCanvas = null;
    
    // Cleanup audio
    if (microphone) {
        microphone.getTracks().forEach(track => track.stop());
        microphone = null;
    }
    
    if (audioContext) {
        audioContext.close();
        audioContext = null;
    }
    
    // Stop audio model
    const model = getModel();
    const modelType = getModelType();
    if (model && modelType === 'audio' && model.stopListening) {
        model.stopListening();
    }
}

/**
 * Setup webcam for image classification models
 */
async function setupWebcam() {
    try {
        const flip = currentFacingMode === 'user';
        webcam = new window.tmImage.Webcam(400, 400, flip);

        await webcam.setup();
        if (currentFacingMode === 'environment') {
            await applyEnvironmentCamera(webcam);
        }
        await webcam.play();

        const wrapper = document.getElementById(wrapperElementId);
        wrapper.innerHTML = '';
        wrapper.appendChild(webcam.canvas);
        window.requestAnimationFrame(loopImage);
    } catch (error) {
        console.error('Webcam error:', error);
        throw error;
    }
}

/**
 * Setup webcam for pose detection models
 * webcam.canvas is kept off-DOM (capture only).
 * A separate pose-display canvas is shown to the user so its context is
 * always clean — no transform side-effects from webcam.update().
 * An offscreen 200x200 predictionCanvas is used for estimatePose so
 * keypoint coordinates stay in the 0-200 range the TM classifier expects.
 */
async function setupPoseWebcam() {
    try {
        console.log('🦴 Setting up pose webcam...');

        // 400x400 webcam — NOT added to the DOM, used only for video capture
        const flip = currentFacingMode === 'user';
        webcam = new window.tmPose.Webcam(400, 400, flip);

        await webcam.setup();
        if (currentFacingMode === 'environment') {
            await applyEnvironmentCamera(webcam);
        }
        await webcam.play();

        // 200x200 offscreen canvas for pose estimation
        predictionCanvas = document.createElement('canvas');
        predictionCanvas.width = 200;
        predictionCanvas.height = 200;

        // 400x400 canvas shown to the user
        const displayCanvas = document.createElement('canvas');
        displayCanvas.id = 'pose-display';
        displayCanvas.width = 400;
        displayCanvas.height = 400;

        const wrapper = document.getElementById(wrapperElementId);
        wrapper.innerHTML = '';
        wrapper.appendChild(displayCanvas);

        console.log('🦴 Pose webcam ready, starting prediction loop...');
        window.requestAnimationFrame(loopPose);
    } catch (error) {
        console.error('Pose webcam error:', error);
        throw error;
    }
}

/**
 * Setup audio for voice/sound classification models
 */
async function setupAudio() {
    try {
        console.log('🎤 Setting up audio...');
        
        // Create visualization canvas
        const canvas = document.createElement('canvas');
        canvas.width = 400;
        canvas.height = 400;
        canvas.id = 'audio-visualizer';
        
        const wrapper = document.getElementById(wrapperElementId);
        wrapper.innerHTML = '';
        wrapper.appendChild(canvas);

        // Setup audio context for visualization
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        microphone = stream;
        
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        analyser = audioContext.createAnalyser();
        analyser.fftSize = 2048;
        
        const source = audioContext.createMediaStreamSource(stream);
        source.connect(analyser);
        
        // Start visualization
        window.requestAnimationFrame(visualizeAudio);
        
        // Start audio model listening
        const model = getModel();
        console.log('🎤 Starting audio recognition...');
        
        await model.listen(result => {
            const wordLabels = model.wordLabels();
            const scoresArray = Array.from(result.scores);
            
            const predictions = scoresArray.map((score, i) => ({
                className: wordLabels[i] || `Class ${i}`,
                probability: score
            }));
            
            displayPredictions(predictions);
        }, {
            includeSpectrogram: false,
            probabilityThreshold: 0.5,
            invokeCallbackOnNoiseAndUnknown: true,
            overlapFactor: 0.5
        });
        
        console.log('✅ Audio configured');
    } catch (error) {
        console.error('Audio setup error:', error);
        throw error;
    }
}

/**
 * Visualize audio as frequency bars
 * Optimized for human voice (80Hz - 8000Hz)
 */
function visualizeAudio() {
    if (!isRunning || !analyser) return;
    
    const canvas = document.getElementById('audio-visualizer');
    if (!canvas) return;
    
    const ctx = canvas.getContext('2d');
    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    
    analyser.getByteFrequencyData(dataArray);
    
    // Clear with white background
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    const barCount = 32;
    const barWidth = (canvas.width / barCount) * 0.9;
    const barGap = (canvas.width / barCount) * 0.1;
    const borderRadius = barWidth / 2;
    
    // Calculate bar area bounds
    const totalBarsWidth = barCount * (barWidth + barGap);
    const startX = barGap / 2;
    const endX = startX + totalBarsWidth - barGap;
    
    // Draw center line
    const centerY = canvas.height / 2;
    ctx.strokeStyle = '#e0e0e0';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(startX, centerY);
    ctx.lineTo(endX, centerY);
    ctx.stroke();
    
    // Logarithmic frequency distribution (80Hz - 4000Hz vocal range)
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

    // Draw bars mirrored: low frequencies in the center, high at the edges
    const threshold = 40;
    const half = barCount / 2;
    for (let i = 0; i < barCount; i++) {
        const freqIndex = i < half ? half - 1 - i : i - half;
        const average = barValues[freqIndex];
        const gated = average > threshold ? average - threshold : 0;

        const fullBarHeight = (gated / (255 - threshold)) * canvas.height * 0.65;
        const halfBarHeight = fullBarHeight / 2;
        const x = i * (barWidth + barGap) + barGap / 2;

        drawRoundedBar(ctx, x, centerY - halfBarHeight, barWidth, halfBarHeight, borderRadius, true);
        drawRoundedBar(ctx, x, centerY, barWidth, halfBarHeight, borderRadius, false);
    }
    
    window.requestAnimationFrame(visualizeAudio);
}

// Brand colors live in :root (css/styles.css). Never duplicate them as literals.
// The strong tone, not --color-primary: the canvas is painted white and the light
// celeste is 1.96:1 against it. (#4169B8, the cold end of the gradient below, is a
// visualizer color and not part of the brand palette.)
// Cached: drawRoundedBar runs once per bar, on every animation frame.
let cachedBarColor = null;

function brandBarColor() {
    if (!cachedBarColor) {
        cachedBarColor = getComputedStyle(document.documentElement).getPropertyValue('--color-primary-strong').trim();
    }
    return cachedBarColor;
}
/**
 * Draw a rounded bar with gradient
 */
function drawRoundedBar(ctx, x, y, width, height, radius, isUp) {
    if (height < 2) return;
    // An empty token would make addColorStop throw and kill the rAF loop.
    const barColor = brandBarColor();
    if (!barColor) return;
    
    const gradient = ctx.createLinearGradient(0, isUp ? y : y, 0, isUp ? y + height : y + height);
    gradient.addColorStop(0, barColor);
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

/**
 * Image prediction loop.
 * webcam.update() runs every frame for smooth video; inference fires
 * only when the previous call has finished (no concurrent calls).
 */
function loopImage() {
    if (!isRunning || !webcam) return;

    webcam.update();

    if (!predictionInFlight) {
        predictionInFlight = true;
        predictImage().finally(() => { predictionInFlight = false; });
    }

    window.requestAnimationFrame(loopImage);
}

/**
 * Pose prediction loop.
 * Draws the current video frame + last known skeleton every RAF for smooth
 * video. Inference fires only when the previous call has finished, so the
 * skeleton updates at the model's natural rate without blocking the display.
 */
function loopPose() {
    if (!isRunning || !webcam) return;

    webcam.update();

    // Always draw the latest video frame so the display is smooth
    const displayCanvas = document.getElementById('pose-display');
    if (displayCanvas) {
        const ctx = displayCanvas.getContext('2d');
        ctx.drawImage(webcam.canvas, 0, 0, 400, 400);
        if (lastPose && lastPose.keypoints) {
            drawPose(lastPose, ctx, 2);
        }
    }

    if (!predictionInFlight) {
        predictionInFlight = true;
        predictPose().finally(() => { predictionInFlight = false; });
    }

    window.requestAnimationFrame(loopPose);
}

/**
 * Predict for image model
 */
async function predictImage() {
    const model = getModel();
    if (!model || !webcam) return;
    
    const prediction = await model.predict(webcam.canvas);
    displayPredictions(prediction);
}

/**
 * Predict for pose model.
 * Display drawing is handled by loopPose every RAF for smooth video.
 * This function only runs inference and stores the result in lastPose so
 * the loop can overlay the skeleton without blocking the display.
 */
async function predictPose() {
    const model = getModel();
    if (!model || !webcam || !predictionCanvas) return;

    try {
        // Scale the 400x400 webcam frame down to 200x200 before estimation.
        // The TM pose classifier expects keypoint coordinates in the 0-200 range
        // (the resolution used during training).
        const predCtx = predictionCanvas.getContext('2d');
        predCtx.drawImage(webcam.canvas, 0, 0, 200, 200);

        const { pose, posenetOutput } = await model.estimatePose(predictionCanvas);
        const prediction = await model.predict(posenetOutput);

        // Cache pose so loopPose can overlay it on every display frame
        lastPose = pose;

        displayPredictions(prediction);
    } catch (error) {
        console.error('Pose prediction error:', error);
    }
}

/**
 * Draw pose skeleton (keypoints and connections)
 */
function drawPose(pose, ctx, scale = 1) {
    if (!pose.keypoints) return;
    
    // Draw keypoints
    pose.keypoints.forEach(keypoint => {
        if (keypoint.score > 0.5) {
            ctx.beginPath();
            ctx.arc(keypoint.position.x * scale, keypoint.position.y * scale, 5, 0, 2 * Math.PI);
            ctx.fillStyle = '#00ff00';
            ctx.fill();
        }
    });
    
    // Draw skeleton connections
    const skeleton = [
        [5, 6], [5, 7], [7, 9], [6, 8], [8, 10],
        [5, 11], [6, 12], [11, 12],
        [11, 13], [13, 15], [12, 14], [14, 16]
    ];
    
    skeleton.forEach(([i, j]) => {
        const kp1 = pose.keypoints[i];
        const kp2 = pose.keypoints[j];
        
        if (kp1.score > 0.5 && kp2.score > 0.5) {
            ctx.beginPath();
            ctx.moveTo(kp1.position.x * scale, kp1.position.y * scale);
            ctx.lineTo(kp2.position.x * scale, kp2.position.y * scale);
            ctx.strokeStyle = '#00ff00';
            ctx.lineWidth = 2;
            ctx.stroke();
        }
    });
}

/**
 * Display predictions in UI and send to micro:bit
 */
function displayPredictions(predictions) {
    const container = document.getElementById(containerElementId);
    if (!container) return;
    
    if (!predictions || !Array.isArray(predictions)) {
        console.error('Invalid predictions:', predictions);
        return;
    }
    
    // Filter valid predictions
    const validPredictions = predictions.filter(pred => {
        return pred.className && 
               typeof pred.probability === 'number' && 
               !isNaN(pred.probability) &&
               isFinite(pred.probability);
    });
    
    if (validPredictions.length === 0) {
        console.warn('No valid predictions');
        return;
    }
    
    // Sort by confidence
    const sorted = validPredictions.slice().sort((a, b) => b.probability - a.probability);
    
    // Display in UI
    container.innerHTML = sorted.map((pred, index) => {
        const percentage = (pred.probability * 100).toFixed(1);
        const isTop = index === 0;
        
        return `
            <div class="prediction-item ${isTop ? 'top' : ''}">
                <div class="prediction-header">
                    <span class="class-name">${pred.className}</span>
                    <span class="confidence">${percentage}%</span>
                </div>
                <div class="confidence-bar">
                    <div class="confidence-fill" style="width: ${percentage}%"></div>
                </div>
            </div>
        `;
    }).join('');
    
    // Send to micro:bit (skip background noise)
    if (isConnected() && sorted.length > 0) {
        const top = sorted[0];
        
        if (top.className.toLowerCase() !== 'ruido de fondo') {
            sendToMicrobit(top.className, top.probability * 100);
        }
    }
}

/**
 * Handle page visibility changes
 * Resume prediction loops when page becomes visible
 */
document.addEventListener('visibilitychange', function() {
    if (document.hidden) {
        console.warn('⏸️ Page hidden - predictions paused');
    } else {
        console.log('▶️ Page visible - predictions resumed');
        if (isRunning) {
            const modelType = getModelType();
            if (modelType === 'image' && webcam) {
                window.requestAnimationFrame(loopImage);
            } else if (modelType === 'pose' && webcam) {
                window.requestAnimationFrame(loopPose);
            } else if (modelType === 'audio' && analyser) {
                window.requestAnimationFrame(visualizeAudio);
            }
        }
    }
});

/**
 * Toggle between front and back camera for image/pose models.
 * Returns false if the back camera is not available.
 * No upfront probe — just tries the switch and reverts on failure.
 */
async function flipCamera() {
    const modelType = getModelType();
    if (modelType !== 'image' && modelType !== 'pose') return false;

    const prevFacingMode = currentFacingMode;
    currentFacingMode = prevFacingMode === 'user' ? 'environment' : 'user';

    // Tear down current webcam
    if (webcam) {
        webcam.stop();
        webcam = null;
    }
    predictionCanvas = null;
    document.getElementById(wrapperElementId).innerHTML = '';

    try {
        if (modelType === 'image') {
            await setupWebcam();
        } else {
            await setupPoseWebcam();
        }
        return true;
    } catch {
        // Back camera unavailable — revert to previous camera
        currentFacingMode = prevFacingMode;
        if (modelType === 'image') {
            await setupWebcam();
        } else {
            await setupPoseWebcam();
        }
        return false;
    }
}

export { startPredictions, stopPredictions, flipCamera, configurePredictions, applyEnvironmentCamera };