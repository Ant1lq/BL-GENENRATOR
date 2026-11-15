/* MicroPort Cardioflow — service worker : l'appli complète est copiée sur l'appareil
   à la première ouverture, puis fonctionne sans réseau. Changer VERSION à chaque mise à jour. */
const VERSION = 'v2.1.1';
const APP = 'mp-app-' + VERSION, CDN = 'mp-cdn-v1', TILES = 'mp-tiles-v1';
const MAX_TILES = 2500;

// Indispensable au fonctionnement
const CORE = [
  './', 'index.html', 'bl.html', 'depot.html', 'carte.html', 'admin.html', 'manifest.webmanifest',
  'assets/local-db.js', 'assets/scan.js', 'assets/logo-microport.png', 'assets/icon-180.png', 'assets/icon-192.png', 'assets/icon-512.png',
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

// Secours : si une bibliothèque n'est pas présente dans le dépôt, elle est prise une fois sur son
// CDN d'origine puis conservée sur l'appareil sous son adresse locale (même fonctionnement hors ligne).
const CJS = 'https://cdnjs.cloudflare.com/ajax/libs/';
const FALLBACK = {
  'assets/vendor/html2canvas.min.js': CJS + 'html2canvas/1.4.1/html2canvas.min.js',
  'assets/vendor/cropper.min.js': CJS + 'cropperjs/1.5.13/cropper.min.js',
  'assets/vendor/cropper.min.css': CJS + 'cropperjs/1.5.13/cropper.min.css',
  'assets/vendor/xlsx.full.min.js': CJS + 'xlsx/0.18.5/xlsx.full.min.js',
  'assets/vendor/pdf.min.js': CJS + 'pdf.js/3.11.174/pdf.min.js',
  'assets/vendor/pdf.worker.min.js': CJS + 'pdf.js/3.11.174/pdf.worker.min.js',
  'assets/vendor/pdf-lib.min.js': CJS + 'pdf-lib/1.17.1/pdf-lib.min.js',
  'assets/vendor/leaflet/leaflet.min.js': CJS + 'leaflet/1.9.4/leaflet.min.js',
  'assets/vendor/leaflet/leaflet.min.css': CJS + 'leaflet/1.9.4/leaflet.min.css',
  'assets/vendor/leaflet/images/marker-icon.png': CJS + 'leaflet/1.9.4/images/marker-icon.png',
  'assets/vendor/leaflet/images/marker-icon-2x.png': CJS + 'leaflet/1.9.4/images/marker-icon-2x.png',
  'assets/vendor/leaflet/images/marker-shadow.png': CJS + 'leaflet/1.9.4/images/marker-shadow.png',
  'assets/vendor/leaflet/images/layers.png': CJS + 'leaflet/1.9.4/images/layers.png',
  'assets/vendor/leaflet/images/layers-2x.png': CJS + 'leaflet/1.9.4/images/layers-2x.png',
  'assets/vendor/tesseract/tesseract.min.js': CJS + 'tesseract.js/4.1.1/tesseract.min.js',
  'assets/vendor/tesseract/worker.min.js': CJS + 'tesseract.js/4.1.1/worker.min.js',
  'assets/vendor/tesseract/tesseract-core.wasm.js': 'https://cdn.jsdelivr.net/npm/tesseract.js-core@4.0.4/tesseract-core.wasm.js',
  'assets/vendor/tesseract/tesseract-core-simd.wasm.js': 'https://cdn.jsdelivr.net/npm/tesseract.js-core@4.0.4/tesseract-core-simd.wasm.js',
  'assets/vendor/tesseract/eng.traineddata.gz': 'https://tessdata.projectnaptha.com/4.0.0/eng.traineddata.gz'
};
const SCOPE = new URL('./', self.location.href).href;
function localKey(url) { const u = new URL(url, SCOPE); u.search = ''; u.hash = ''; return u.href; }
function relPath(url) { const k = localKey(url); return k.indexOf(SCOPE) === 0 ? k.slice(SCOPE.length) : null; }
// Récupère un fichier de l'appli (dépôt, sinon CDN de secours) et le range dans le cache sous son adresse locale
async function obtain(url, cache, reload) {
  const key = localKey(url);
  let resp = null;
  try { resp = await fetch(new Request(key, reload ? { cache: 'reload' } : {})); } catch (e) { resp = null; }
  if (!(resp && resp.ok)) {
    const alt = FALLBACK[relPath(key)];
    if (alt) { try { const r = await fetch(alt, { mode: 'cors', credentials: 'omit' }); if (r.ok) resp = r; } catch (e) {} }
  }
  if (resp && resp.ok) await cache.put(key, resp.clone());
  return resp;
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(APP);
    const got = await Promise.all(CORE.map(u => obtain(u, cache, true).catch(() => null)));
    // Les pages et le moteur de stockage sont indispensables ; le reste peut arriver plus tard
    const vital = ['index.html', 'bl.html', 'depot.html', 'carte.html', 'admin.html', 'assets/local-db.js', 'assets/scan.js'];
    CORE.forEach((u, i) => { if (vital.includes(u) && !(got[i] && got[i].ok)) throw new Error('Fichier indispensable manquant : ' + u); });
    await Promise.all(HEAVY.map(u => obtain(u, cache, true).catch(() => null)));
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
  const cache = await caches.open(APP), key = localKey(request.url);
  const cached = await cache.match(key);
  if (cached) {
    event.waitUntil(fetch(key).then(resp => (resp && resp.ok && resp.type === 'basic') ? cache.put(key, resp) : null).catch(() => {}));
    return cached;
  }
  const resp = await obtain(key, cache, false).catch(() => null);
  if (resp) return resp;
  if (request.mode === 'navigate') { const home = await cache.match(localKey('index.html')); if (home) return home; }
  return Response.error();
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
