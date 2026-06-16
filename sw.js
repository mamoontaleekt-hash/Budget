/* Service Worker for PWA (GitHub Pages-friendly)
   - Caches app shell for offline open.
   - Network-first for HTML, cache-first for static assets.
*/
const CACHE_NAME = "pfm-pwa-v4";
const REPORT_ENHANCEMENT_SCRIPT = '<script src="./report-enhancements.js?v=20260616-report-1"></script>';
const MOBILE_ENHANCEMENT_STYLE = '<link rel="stylesheet" href="./mobile-enhancements.css?v=20260616-mobile-1">';
const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "./sw.js",
  "./report-enhancements.js",
  "./mobile-enhancements.css",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];

async function enhanceHtml(response) {
  const headers = new Headers(response.headers);
  const contentType = headers.get("content-type") || "";
  if (!contentType.includes("text/html")) return response;

  const html = await response.text();
  let enhanced = html;
  if (!enhanced.includes("mobile-enhancements.css")) {
    enhanced = enhanced.replace("</head>", `${MOBILE_ENHANCEMENT_STYLE}\n</head>`);
  }
  if (!enhanced.includes("report-enhancements.js")) {
    enhanced = enhanced.replace("</body>", `${REPORT_ENHANCEMENT_SCRIPT}\n</body>`);
  }

  headers.set("content-type", "text/html; charset=utf-8");
  headers.delete("content-length");
  return new Response(enhanced, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

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
            const enhanced = await enhanceHtml(fresh.clone());
            const cache = await caches.open(CACHE_NAME);
            cache.put(req, enhanced.clone());
            return enhanced;
          } catch (e) {
            const cached = await caches.match(req);
            if (cached) return enhanceHtml(cached.clone());
            const shell = await caches.match("./index.html");
            return shell ? enhanceHtml(shell.clone()) : Response.error();
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
