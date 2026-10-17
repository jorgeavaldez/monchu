/**
 * The offline shell. The build defines its version and the files to keep. Navigation always tries the network first,
 * so an expired sign-in reaches the login page; hashed assets come from the cache.
 */
declare const self: ServiceWorkerGlobalScope;
declare const MONCHU_VERSION: string;
declare const MONCHU_SHELL: string[];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(MONCHU_VERSION)
      .then((cache) =>
        cache.addAll(MONCHU_SHELL.map((path) => new Request(path, { credentials: "include" }))),
      )
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== MONCHU_VERSION).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(async () => (await caches.match("/")) ?? Response.error()),
    );
    return;
  }
  event.respondWith(caches.match(request).then((cached) => cached ?? fetch(request)));
});

export {};
