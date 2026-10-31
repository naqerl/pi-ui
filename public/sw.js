const CACHE = "pi-ui-v2";
const SHELL = [
  "/",
  "/activity",
  "/events",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-512-maskable.png",
];

async function cacheShell() {
  const cache = await caches.open(CACHE);

  await Promise.allSettled(
    SHELL.map(async (url) => {
      const response = await fetch(url, { cache: "reload" });
      if (response.ok) await cache.put(url, response);
    }),
  );

  for (const page of ["/", "/activity", "/events"]) {
    const response = await cache.match(page);
    if (!response) continue;
    const html = await response.clone().text();
    const assets = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
      .map((match) => match[1])
      .filter((url) => url.startsWith("/") && !url.startsWith("//"));
    const unique = [...new Set(assets)];
    await Promise.allSettled(
      unique.map(async (url) => {
        if (await cache.match(url)) return;
        const asset = await fetch(url, { cache: "reload" });
        if (asset.ok) await cache.put(url, asset);
      }),
    );
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(cacheShell().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)));
      await self.clients.claim();
    })(),
  );
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(request, response.clone());
    return response;
  } catch {
    return (await cache.match(request)) ?? Response.error();
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) await cache.put(request, response.clone());
  return response;
}

async function navigation(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(request, response.clone());
    return response;
  } catch {
    return (
      (await cache.match(request)) ??
      (await cache.match("/activity")) ??
      (await cache.match("/")) ??
      new Response("Offline", { status: 503, headers: { "Content-Type": "text/plain" } })
    );
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname === "/api/stream") return;

  if (url.pathname.startsWith("/api/") || url.pathname === "/manifest.webmanifest") {
    event.respondWith(networkFirst(request));
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(navigation(request));
    return;
  }

  event.respondWith(cacheFirst(request));
});

/** A focused app has the user's attention, so a push stays silent. */
function shouldNotify(clients) {
  return !Array.isArray(clients) || !clients.some((client) => client && client.focused === true);
}

function pushPayload(event) {
  if (event.data === null || event.data === undefined) return {};
  try {
    const value = event.data.json();
    return value !== null && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

self.addEventListener("push", (event) => {
  event.waitUntil(
    (async () => {
      const list = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      if (!shouldNotify(list)) return;

      const payload = pushPayload(event);
      const title = typeof payload.title === "string" && payload.title ? payload.title : "pi";
      const body = typeof payload.body === "string" ? payload.body : "";
      const url =
        typeof payload.url === "string" && payload.url.startsWith("/") ? payload.url : "/";
      const tag = typeof payload.tag === "string" && payload.tag ? payload.tag : "pi";
      const extra = payload.data !== null && typeof payload.data === "object" ? payload.data : {};

      await self.registration.showNotification(title, {
        body,
        data: { ...extra, url },
        tag,
        icon: "/icons/icon-192.png",
        badge: "/icons/icon-192.png",
      });
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data;
  const target = data && typeof data.url === "string" && data.url.startsWith("/") ? data.url : "/";
  event.waitUntil(
    (async () => {
      const list = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of list) {
        if (typeof client.focus !== "function") continue;
        try {
          await client.focus();
        } catch {
          continue;
        }
        if (typeof client.navigate === "function") {
          try {
            await client.navigate(target);
            return;
          } catch {
            // A client that cannot navigate still got focus, but the target
            // page is what the notification promised, so open it below.
          }
        }
      }
      await self.clients.openWindow(target);
    })(),
  );
});
