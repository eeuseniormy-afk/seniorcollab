// Rede primeiro, cache como reserva (o app abre mesmo com internet ruim).
const CACHE = 'seniorcollab-v1';
self.addEventListener('install', (e) => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.hostname.endsWith('supabase.co')) return;
  e.respondWith(
    fetch(req).then((res) => {
      if (res.ok && (url.origin === location.origin || url.hostname === 'cdn.jsdelivr.net')) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
      }
      return res;
    }).catch(() => caches.match(req))
  );
});
