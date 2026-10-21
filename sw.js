const CACHE_NAME = 'medicamentos-v41';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './config.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  // Llamadas a Supabase (auth, datos, funciones): las dejamos pasar
  // directo, sin que el service worker las toque para nada.
  if (request.url.includes('supabase.co')) {
    return;
  }
  // Shell de la app: siempre va a buscar al servidor de verdad
  // (cache: 'no-store' evita que el propio navegador conteste con
  // una copia guardada "fresca" sin siquiera avisarnos). Si no hay
  // conexión, recién ahí usa la copia guardada.
  event.respondWith(
    fetch(request, { cache: 'no-store' })
      .then((response) => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        return response;
      })
      .catch(() => caches.match(request))
  );
});
