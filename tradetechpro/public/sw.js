/* Quick Comp service worker — web push only (no offline caching: the app is
 * network-first by design; a stale cached shell caused ALTO more support
 * tickets than offline mode ever saved). */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { /* non-JSON payload */ }
  e.waitUntil(self.registration.showNotification(d.title || "Quick Comp", {
    body: d.body || "",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    tag: d.tag || "qc-lead",           // same-tag notifications collapse
    renotify: true,                     // …but still buzz on each new lead
    data: { url: d.url || "/" },
  }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = e.notification.data?.url || "/";
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((tabs) => {
    for (const t of tabs) { if ("focus" in t) { t.navigate(url); return t.focus(); } }
    return self.clients.openWindow(url);
  }));
});
