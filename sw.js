// JustAPlaylist service worker.
// Its only job: receive chat exports shared from WhatsApp (Android share sheet)
// and keep them until the page has read them. Nothing else is cached.

const SHARE_CACHE = 'jap-share-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method === 'POST' && url.pathname.endsWith('/share-target')) {
    event.respondWith(receiveShare(event.request));
  }
});

async function receiveShare(request) {
  const scope = self.registration.scope;
  const key = new URL('pending-share', scope).href;
  try {
    const form = await request.formData();
    const files = form.getAll('chat').filter(f => f && typeof f !== 'string' && f.size > 0);
    const file = files.find(f => /\.(txt|zip)$/i.test(f.name)) || files[0];
    const cache = await caches.open(SHARE_CACHE);
    if (file) {
      await cache.put(key, new Response(file, {
        headers: {
          'Content-Type': file.type || 'application/octet-stream',
          'X-File-Name': encodeURIComponent(file.name || 'Shared chat.txt'),
        },
      }));
    } else {
      // Some apps share plain text instead of a file.
      const text = ['title', 'text', 'url'].map(k => form.get(k)).filter(v => typeof v === 'string').join('\n');
      if (text.trim()) {
        await cache.put(key, new Response(text, {
          headers: { 'Content-Type': 'text/plain', 'X-File-Name': encodeURIComponent('Shared text') },
        }));
      }
    }
  } catch {
    // Fall through: the page simply opens without a shared file.
  }
  return Response.redirect(new URL('./?shared=1', scope).href, 303);
}
