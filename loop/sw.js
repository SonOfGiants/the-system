/* Loop Quest — app shell only.
   On GitHub Pages the script lives at /the-system/loop/sw.js, so the
   default scope is /the-system/loop/ and cannot control the root app.
   Cache names stay under the loop-quest- prefix. Tiles and the foot
   router are other origins and are never cached. */
const CACHE_VERSION = "loop-quest-v2";

const SHELL = [
  "./",
  "./index.html",
  "./app.js",
  "./manifest.webmanifest",
  "./apple-touch-icon.png",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-maskable-512.png",
  "./favicon.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_VERSION).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key.startsWith("loop-quest-") && key !== CACHE_VERSION)
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

function isShell(url) {
  if (url.origin !== self.location.origin) return false;
  const path = url.pathname;
  if (!path.includes("/loop/") && !/\/loop\/?$/.test(path)) return false;
  return (
    path.endsWith("/loop/") ||
    path.endsWith("/loop/index.html") ||
    path.endsWith("/app.js") ||
    path.endsWith("/manifest.webmanifest") ||
    path.endsWith("/apple-touch-icon.png") ||
    path.endsWith("/icon-192.png") ||
    path.endsWith("/icon-512.png") ||
    path.endsWith("/icon-maskable-512.png") ||
    path.endsWith("/favicon.png")
  );
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  let url;
  try { url = new URL(request.url); } catch (e) { return; }

  // Tiles, Leaflet, and the foot router stay on the network.
  if (url.origin !== self.location.origin) return;
  if (!isShell(url) && request.mode !== "navigate") return;
  if (request.mode === "navigate" && !isLoopNavigation(url)) return;

  event.respondWith(networkFirst(request));
});

function isLoopNavigation(url) {
  return /\/loop\/?$/.test(url.pathname) || url.pathname.endsWith("/loop/index.html");
}

async function networkFirst(request) {
  const cache = await caches.open(CACHE_VERSION);
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      await cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    return (await cache.match(request))
      || (await cache.match("./index.html"))
      || (await cache.match("./"));
  }
}
