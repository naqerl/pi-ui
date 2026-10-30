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
