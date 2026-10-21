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

/** A push from this device's Monchu: shown unless a Monchu page is in front, where the stream already shows it. */
self.addEventListener("push", (event) => {
  const message: unknown = event.data?.json();
  const field = (key: string) => {
    const value: unknown =
      typeof message === "object" && message !== null ? Reflect.get(message, key) : undefined;
    return typeof value === "string" ? value : "";
  };
  event.waitUntil(
    self.clients.matchAll({ type: "window" }).then((windows) =>
      windows.some((each) => each.visibilityState === "visible" && each.focused)
        ? undefined
        : self.registration.showNotification(field("title") || "Monchu", {
            body: field("body"),
            tag: field("tag"),
            data: { url: field("url") || "/" },
          }),
    ),
  );
});

/** A tap opens the message: in an open Monchu window when there is one, and only ever a Monchu page, never a link. */
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data: unknown = event.notification.data;
  const path: unknown = typeof data === "object" && data !== null ? Reflect.get(data, "url") : "/";
  const target = new URL(typeof path === "string" ? path : "/", self.location.origin);
  const url = target.origin === self.location.origin ? target.href : self.location.origin + "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window" }).then(async (windows) => {
      const open = windows[0];
      if (open === undefined) return void (await self.clients.openWindow(url));
      await (await open.navigate(url))?.focus();
    }),
  );
});

export {};
