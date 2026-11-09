// Finstack Turf service worker: makes the app installable and loads the shell fast.
// Data always comes live from Supabase; nothing financial is cached.
const CACHE = "finstack-turf-v4.2";
const SHELL = ["./", "./index.html", "./css/style.css?v=4.2", "./js/config.js?v=4.2", "./js/app.js?v=4.2", "./manifest.json", "./icons/icon-192.png", "./icons/icon-512.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return; // Supabase/API calls always go to the network
  // network-first for the shell so updates arrive on the next open; cache is the offline fallback
  e.respondWith(fetch(e.request).then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return res; }).catch(() => caches.match(e.request).then(r => r || caches.match("./index.html"))));
});
// Push message from the push-notify Edge Function
self.addEventListener("push", e => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch (_) { d = { title: "Finstack Turf", body: e.data ? e.data.text() : "" }; }
  const title = d.title || "Finstack Turf";
  e.waitUntil((async () => {
    // Live-score updates: skip the alert if the app is open on screen (the user already sees the scoreboard).
    if (d.kind === "score") {
      const cs = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      if (cs.some(c => c.visibilityState === "visible")) return;
    }
    await self.registration.showNotification(title, {
      body: d.body || "", icon: "./icons/icon-192.png", badge: "./icons/icon-192.png", tag: d.tag || undefined, renotify: d.kind !== "score" && !!d.tag,
      silent: d.kind === "score", data: { url: d.url || "./" }, vibrate: d.kind === "score" ? undefined : [100, 50, 100]
    });
  })());
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || "./", self.location.href).href;
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(cs => {
    const c = cs.find(x => x.url.startsWith(self.registration.scope));
    if (c) { c.focus(); return c.navigate ? c.navigate(url) : (c.postMessage({ type: "navigate", url }), undefined); }
    return self.clients.openWindow(url);
  }));
});
