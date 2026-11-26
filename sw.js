// Service worker : l'appli s'ouvre même sans réseau (les données sont déjà dans le téléphone).
const CACHE = 'visages-v1';
const FICHIERS = ['./', './index.html', './app.js', './noyau.js', './manifest.webmanifest', './icone-192.png', './icone-512.png'];
self.addEventListener('install', e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(FICHIERS))));
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(k => Promise.all(k.filter(x => x !== CACHE).map(x => caches.delete(x))))));
self.addEventListener('fetch', e => {  // réseau d'abord (mises à jour), sinon la copie en cache
  if (e.request.method === 'GET' && new URL(e.request.url).origin === location.origin)
    e.respondWith(fetch(e.request).then(r => { const copie = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copie)); return r; })
      .catch(() => caches.match(e.request)));
});
