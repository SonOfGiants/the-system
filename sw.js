/* The System — offline shell. Bump CACHE_VERSION when icons or the shell change. */
const CACHE_VERSION = "the-system-v1";

const PRECACHE = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./apple-touch-icon.png",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-maskable-512.png",
  "./favicon.png",
  "./favicon.ico"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(PRECACHE))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

function isAppShell(url, request) {
  if (request.mode === "navigate") return true;
  const path = url.pathname;
  return path.endsWith("/index.html") || /\/$/.test(path);
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  let url;
  try { url = new URL(request.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return;

  if (isAppShell(url, request)) {
    event.respondWith(networkFirstDocument(request));
    return;
  }

  event.respondWith(cacheFirst(request));
});

async function networkFirstDocument(request) {
  const cache = await caches.open(CACHE_VERSION);
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      await cache.put(request, response.clone());
      await cache.put("./index.html", response.clone());
    }
    return response;
  } catch (err) {
    return (await cache.match(request))
      || (await cache.match("./index.html"))
      || (await cache.match("./"));
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response && response.ok) {
    const cache = await caches.open(CACHE_VERSION);
    cache.put(request, response.clone());
  }
  return response;
}
