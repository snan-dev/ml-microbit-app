// sw.js
// Service Worker for PWA - Hybrid caching strategy:
// - /vendor/* (TF.js, MediaPipe, MobileNet, speech-commands, fonts): cache-first.
//   These files are versioned in their filename/path and never change in place,
//   so there's no reason to re-fetch ~33MB of them over the network on every load.
// - Everything else (app shell: HTML/CSS/JS): network-first, so app updates
//   are picked up as soon as they're deployed.

const CACHE_NAME = 'ml-microbit-v8.6';
const urlsToCache = [
  './',
  './index.html',
  './css/styles.css',
  './manifest.json',
  // App icons (referenced by index.html header and manifest)
  './assets/icon-192.png',
  './assets/icon-512.png',
  // App scripts
  './js/app.js',
  './js/mediapipe-loader.js',
  './js/project-schema.js',
  './js/project-store.js',
  './js/trainer-config.js',
  './js/webcam.js',
  './js/image-trainer.js',
  './js/audio-trainer.js',
  './js/pose-trainer.js',
  './js/bluetooth.js',
  './js/protocol.js',
  './js/class-name.js',
  './js/sanitize.js',
  './js/storage-keys.js',
  './js/training-rules.js',
  './js/makecode-embed.js',
  './js/makecode-template.js',
  // Vendor: TF.js
  './vendor/tfjs/tfjs-4.22.0.min.js',
  // Vendor: Speech Commands
  './vendor/speech-commands/speech-commands-0.5.4.min.js',
  // Vendor: MediaPipe ESM + WASM
  './vendor/mediapipe/tasks-vision-0.10.14.mjs',
  './vendor/mediapipe/wasm-0.10.14/vision_wasm_internal.js',
  './vendor/mediapipe/wasm-0.10.14/vision_wasm_internal.wasm',
  './vendor/mediapipe/wasm-0.10.14/vision_wasm_nosimd_internal.js',
  './vendor/mediapipe/wasm-0.10.14/vision_wasm_nosimd_internal.wasm',
  // Vendor: ML models
  './vendor/mediapipe/models/pose_landmarker_lite-v1.task',
  './vendor/mobilenet/v1-0.25-224/model.json',
  './vendor/mobilenet/v1-0.25-224/group1-shard1of1',
  './vendor/mobilenet/v1-0.25-224/group2-shard1of1',
  './vendor/mobilenet/v1-0.25-224/group3-shard1of1',
  './vendor/mobilenet/v1-0.25-224/group4-shard1of1',
  './vendor/mobilenet/v1-0.25-224/group5-shard1of1',
  './vendor/mobilenet/v1-0.25-224/group6-shard1of1',
  './vendor/mobilenet/v1-0.25-224/group7-shard1of1',
  './vendor/mobilenet/v1-0.25-224/group8-shard1of1',
  './vendor/mobilenet/v1-0.25-224/group9-shard1of1',
  './vendor/mobilenet/v1-0.25-224/group10-shard1of1',
  './vendor/mobilenet/v1-0.25-224/group11-shard1of1',
  './vendor/mobilenet/v1-0.25-224/group12-shard1of1',
  './vendor/mobilenet/v1-0.25-224/group13-shard1of1',
  './vendor/mobilenet/v1-0.25-224/group14-shard1of1',
  './vendor/mobilenet/v1-0.25-224/group15-shard1of1',
  './vendor/mobilenet/v1-0.25-224/group16-shard1of1',
  './vendor/mobilenet/v1-0.25-224/group17-shard1of1',
  './vendor/mobilenet/v1-0.25-224/group18-shard1of1',
  './vendor/mobilenet/v1-0.25-224/group19-shard1of1',
  './vendor/mobilenet/v1-0.25-224/group20-shard1of1',
  './vendor/mobilenet/v1-0.25-224/group21-shard1of1',
  './vendor/mobilenet/v1-0.25-224/group22-shard1of1',
  './vendor/mobilenet/v1-0.25-224/group23-shard1of1',
  './vendor/mobilenet/v1-0.25-224/group24-shard1of1',
  './vendor/mobilenet/v1-0.25-224/group25-shard1of1',
  './vendor/mobilenet/v1-0.25-224/group26-shard1of1',
  './vendor/mobilenet/v1-0.25-224/group27-shard1of1',
  './vendor/mobilenet/v1-0.25-224/group28-shard1of1',
  './vendor/mobilenet/v1-0.25-224/group29-shard1of1',
  './vendor/mobilenet/v1-0.25-224/group30-shard1of1',
  './vendor/mobilenet/v1-0.25-224/group31-shard1of1',
  './vendor/mobilenet/v1-0.25-224/group32-shard1of1',
  './vendor/mobilenet/v1-0.25-224/group33-shard1of1',
  './vendor/mobilenet/v1-0.25-224/group34-shard1of1',
  './vendor/mobilenet/v1-0.25-224/group35-shard1of1',
  './vendor/mobilenet/v1-0.25-224/group36-shard1of1',
  './vendor/mobilenet/v1-0.25-224/group37-shard1of1',
  './vendor/mobilenet/v1-0.25-224/group38-shard1of1',
  './vendor/mobilenet/v1-0.25-224/group39-shard1of1',
  './vendor/mobilenet/v1-0.25-224/group40-shard1of1',
  './vendor/mobilenet/v1-0.25-224/group41-shard1of1',
  './vendor/mobilenet/v1-0.25-224/group42-shard1of1',
  './vendor/mobilenet/v1-0.25-224/group43-shard1of1',
  './vendor/mobilenet/v1-0.25-224/group44-shard1of1',
  './vendor/mobilenet/v1-0.25-224/group45-shard1of1',
  './vendor/mobilenet/v1-0.25-224/group46-shard1of1',
  './vendor/mobilenet/v1-0.25-224/group47-shard1of1',
  './vendor/mobilenet/v1-0.25-224/group48-shard1of1',
  './vendor/mobilenet/v1-0.25-224/group49-shard1of1',
  './vendor/mobilenet/v1-0.25-224/group50-shard1of1',
  './vendor/mobilenet/v1-0.25-224/group51-shard1of1',
  './vendor/mobilenet/v1-0.25-224/group52-shard1of1',
  './vendor/mobilenet/v1-0.25-224/group53-shard1of1',
  './vendor/mobilenet/v1-0.25-224/group54-shard1of1',
  './vendor/mobilenet/v1-0.25-224/group55-shard1of1',
  // Vendor: modelo base de audio (BROWSER_FFT 18w)
  './vendor/speech-commands/browser_fft/18w/metadata.json',
  './vendor/speech-commands/browser_fft/18w/model.json',
  './vendor/speech-commands/browser_fft/18w/group1-shard1of2',
  './vendor/speech-commands/browser_fft/18w/group1-shard2of2',
  // Vendor: fonts
  './vendor/fonts/nunito-cyrillic-ext.woff2',
  './vendor/fonts/nunito-cyrillic.woff2',
  './vendor/fonts/nunito-vietnamese.woff2',
  './vendor/fonts/nunito-latin-ext.woff2',
  './vendor/fonts/nunito-latin.woff2',
  './js/regenerator-guard.js'
];

/**
 * Determina si una respuesta debe persistirse en el cache.
 * Evita cachear errores (404, 500) y respuestas opacas de forma permanente,
 * lo que en la rama cache-first de /vendor/ dejaría el recurso roto para siempre.
 */
function isCacheable(response) {
  return response
    && response.ok
    && response.status === 200
    && response.type !== 'opaque';
}

// Install event - skip waiting to activate immediately
self.addEventListener('install', (event) => {
  console.log('[SW] Installing new version:', CACHE_NAME);
  self.skipWaiting(); // Force activate immediately

  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('[SW] Caching app shell');
        return cache.addAll(urlsToCache);
      })
  );
});

// Activate event - clean up old caches and take control
self.addEventListener('activate', (event) => {
  console.log('[SW] Activating new version:', CACHE_NAME);

  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            console.log('[SW] Deleting old cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => {
      return self.clients.claim();
    })
  );
});

// Fetch event - hybrid strategy
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // El chequeo de origen evita que una URL cross-origin cuyo path contenga
  // '/vendor/' entre en la rama cache-first.
  if (url.origin === self.location.origin && url.pathname.includes('/vendor/')) {
    // Cache-first: immutable, versioned vendor assets (models, wasm, libs, fonts).
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) return cached;
        return fetch(event.request).then((response) => {
          // Solo persistir respuestas válidas. Cachear un 404 acá lo dejaría
          // servido desde cache indefinidamente (estrategia cache-first).
          if (isCacheable(response)) {
            const responseClone = response.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, responseClone);
            });
          }
          return response;
        });
      })
    );
    return;
  }

  // Network-first: app shell (HTML/CSS/JS), so updates are picked up immediately.
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (isCacheable(response)) {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseClone);
          });
        }
        return response;
      })
      .catch(async () => {
        // Sin red: intentar cache.
        const cached = await caches.match(event.request);
        if (cached) return cached;

        // Navegación sin cache exacto → devolver el shell de la app.
        if (event.request.mode === 'navigate') {
          const shell = await caches.match('./index.html');
          if (shell) return shell;
        }

        // Último recurso: respuesta explícita en vez de respondWith(undefined),
        // que produce un error de red opaco e imposible de diagnosticar.
        return new Response('Recurso no disponible sin conexión', {
          status: 503,
          statusText: 'Service Unavailable',
          headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        });
      })
  );
});
