/* Service Worker for PWA (GitHub Pages-friendly)
   - Caches app shell for offline open.
   - Network-first for HTML, cache-first for static assets.
*/
const CACHE_NAME = "pfm-pwa-v1";
const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "./sw.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => (k !== CACHE_NAME ? caches.delete(k) : Promise.resolve())));
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  if (req.method !== "GET") return;

  if (url.origin === self.location.origin) {
    const isNav = req.mode === "navigate" || (req.headers.get("accept") || "").includes("text/html");
    if (isNav) {
      event.respondWith(
        (async () => {
          try {
            const fresh = await fetch(req);
            const cache = await caches.open(CACHE_NAME);
            cache.put(req, fresh.clone());
            return fresh;
          } catch (e) {
            const cached = await caches.match(req);
            return cached || caches.match("./index.html");
          }
        })()
      );
      return;
    }

    event.respondWith(
      (async () => {
        const cached = await caches.match(req);
        if (cached) return cached;
        const fresh = await fetch(req);
        const cache = await caches.open(CACHE_NAME);
        cache.put(req, fresh.clone());
        return fresh;
      })()
    );
    return;
  }

  event.respondWith(
    (async () => {
      try {
        return await fetch(req);
      } catch (e) {
        const cached = await caches.match(req);
        return cached || Response.error();
      }
    })()
  );
});
