// Copia local de la app para que funcione sin internet.
// Al cambiar cualquier archivo de la app, sube VERSION para que el celular descargue la nueva.
const VERSION = 'vibra-v2';
const ARCHIVOS = ['./', './index.html', './app.js', './dsp.js', './sensores.js', './grafica.js', './manifest.json', './icono.svg', './icono-192.png', './icono-512.png', './icono-maskable-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(ARCHIVOS.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k.startsWith('vibra-') && k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  // Solo los archivos de esta app (otras apps pueden compartir la dirección y tienen su propia copia).
  if (url.origin !== location.origin || !url.pathname.startsWith(new URL(self.registration.scope).pathname)) return;
  // Con internet, siempre la versión más reciente (y se actualiza la copia);
  // sin internet o si la red tarda más de 3 s, la copia guardada.
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const red = fetch(e.request, { cache: 'no-cache' }).then(res => { if (res.ok) cache.put(e.request, res.clone()); return res; });
    const guardada = await cache.match(e.request, { ignoreSearch: true });
    if (!guardada) return red;
    return Promise.race([red.catch(() => guardada), new Promise(r => setTimeout(() => r(guardada), 3000))]);
  })());
});
