// Naturaleza al Día — siempre intenta lo más fresco de la red; si no hay señal, usa lo guardado.
const CACHE = 'naturaleza-al-dia-v2';
const BASE = ['./', 'index.html', 'manifest.json', 'icon.svg', 'data/noticias.json'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(BASE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return; // proxies y noticias en vivo: directo a la red
  e.respondWith(
    fetch(e.request).then(r => {
      const copia = r.clone();
      const clave = url.pathname.endsWith('noticias.json') ? 'data/noticias.json' : e.request;
      caches.open(CACHE).then(c => c.put(clave, copia));
      return r;
    }).catch(() => caches.match(url.pathname.endsWith('noticias.json') ? 'data/noticias.json' : e.request, { ignoreSearch: true }))
  );
});
