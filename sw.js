/* MicroPort Cardioflow — service worker : l'appli complète est copiée sur l'appareil
   à la première ouverture, puis fonctionne sans réseau. Changer VERSION à chaque mise à jour. */
const VERSION = 'v2.0.0';
const APP = 'mp-app-' + VERSION, CDN = 'mp-cdn-v1', TILES = 'mp-tiles-v1';
const MAX_TILES = 2500;

// Indispensable au fonctionnement
const CORE = [
  './', 'index.html', 'bl.html', 'depot.html', 'carte.html', 'admin.html', 'manifest.webmanifest',
  'assets/local-db.js', 'assets/logo-microport.png', 'assets/icon-180.png', 'assets/icon-192.png', 'assets/icon-512.png',
  'assets/vendor/html2canvas.min.js', 'assets/vendor/cropper.min.js', 'assets/vendor/cropper.min.css',
  'assets/vendor/xlsx.full.min.js', 'assets/vendor/pdf.min.js', 'assets/vendor/pdf.worker.min.js', 'assets/vendor/pdf-lib.min.js',
  'assets/vendor/leaflet/leaflet.min.js', 'assets/vendor/leaflet/leaflet.min.css',
  'assets/vendor/leaflet/images/marker-icon.png', 'assets/vendor/leaflet/images/marker-icon-2x.png', 'assets/vendor/leaflet/images/marker-shadow.png',
  'assets/vendor/leaflet/images/layers.png', 'assets/vendor/leaflet/images/layers-2x.png',
  'assets/vendor/tesseract/tesseract.min.js', 'assets/vendor/tesseract/worker.min.js'
];
// Volumineux (lecture OCR de secours) : copiés à part, pour ne jamais bloquer l'installation
const HEAVY = [
  'assets/vendor/tesseract/tesseract-core.wasm.js', 'assets/vendor/tesseract/tesseract-core-simd.wasm.js',
  'assets/vendor/tesseract/eng.traineddata.gz'
];
// Lecteur de codes-barres (seule dépendance externe, conservée ensuite sur l'appareil)
const ZXING = 'https://cdn.jsdelivr.net/npm/zxing-wasm@2/dist/iife/reader/index.js';

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(APP);
    await cache.addAll(CORE.map(u => new Request(u, { cache: 'reload' })));
    await Promise.all(HEAVY.map(u => cache.add(new Request(u, { cache: 'reload' })).catch(() => {})));
    try { const r = await fetch(ZXING, { mode: 'cors', credentials: 'omit' }); if (r.ok) await (await caches.open(CDN)).put(ZXING, r); } catch (e) {}
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keep = [APP, CDN, TILES];
    await Promise.all((await caches.keys()).filter(k => !keep.includes(k)).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

async function trimTiles() {
  const cache = await caches.open(TILES), keys = await cache.keys();
  if (keys.length > MAX_TILES) await Promise.all(keys.slice(0, keys.length - MAX_TILES).map(k => cache.delete(k)));
}

// Fichiers de l'appli : servis depuis l'appareil ; rafraîchis en arrière-plan quand il y a du réseau
async function appFile(request, event) {
  const cache = await caches.open(APP);
  const cached = await cache.match(request, { ignoreSearch: true });
  const refresh = fetch(request).then(resp => {
    if (resp && resp.ok && resp.type === 'basic') {
      const u = new URL(request.url); u.search = '';
      cache.put(u.href, resp.clone()).catch(() => {});
    }
    return resp;
  });
  if (cached) { event.waitUntil(refresh.catch(() => {})); return cached; }
  try { return await refresh; }
  catch (e) {
    if (request.mode === 'navigate') { const home = await cache.match('index.html'); if (home) return home; }
    throw e;
  }
}
// Ressources externes conservées (lecteur de codes-barres, tuiles de carte déjà consultées)
async function keepExternal(request, cacheName, event) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request.url);
  if (cached) return cached;
  const resp = await fetch(request.url, { mode: 'cors', credentials: 'omit' });
  if (resp && resp.ok) {
    event.waitUntil(cache.put(request.url, resp.clone()).then(() => cacheName === TILES && Math.random() < 0.02 ? trimTiles() : null).catch(() => {}));
  }
  return resp;
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) { event.respondWith(appFile(req, event)); return; }
  if (/(^|\.)jsdelivr\.net$/.test(url.hostname)) { event.respondWith(keepExternal(req, CDN, event)); return; }
  if (url.hostname === 'tile.openstreetmap.org') { event.respondWith(keepExternal(req, TILES, event)); return; }
  // Tout le reste (recherche d'adresse…) : réseau uniquement, facultatif
});
