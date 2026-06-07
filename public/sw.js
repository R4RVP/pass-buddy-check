/**
 * PASS Buddy Check — Service Worker
 * M5: Web Push notification reception
 * M10: PWA manifest, app icon, offline support (to be added)
 */

const SW_VERSION = 'v1';

// Take over immediately on install/activate — no waiting for old tabs
self.addEventListener('install',  () => self.skipWaiting());
self.addEventListener('activate', e  => e.waitUntil(self.clients.claim()));

// ── Push event ────────────────────────────────────────────────────────────────
// Fires when the push service delivers a message.
// The browser automatically decrypts the payload before calling this handler.

self.addEventListener('push', event => {
  if (!event.data) return;

  let data = {};
  try {
    data = event.data.json();
  } catch {
    // Fallback for non-JSON payloads
    data = { title: 'PASS Buddy Check', body: event.data.text() };
  }

  const title   = data.title   ?? 'PASS Buddy Check';
  const options = {
    body:               data.body    ?? '',
    // icon + badge paths are placeholders until M10 adds PWA assets
    icon:               '/icon-192.png',
    badge:              '/badge-72.png',
    tag:                data.tag     ?? 'buddy-check',
    data:               { url: data.url ?? '/' },
    requireInteraction: data.requireInteraction === true,
    silent:             false,
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// ── Notification click ────────────────────────────────────────────────────────
// Focus the app if already open; otherwise open a new window.

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const targetUrl = event.notification.data?.url ?? '/';

  event.waitUntil(
    clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then(clientList => {
        for (const client of clientList) {
          if ('focus' in client) return client.focus();
        }
        return clients.openWindow(targetUrl);
      })
  );
});
