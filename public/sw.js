// 코스맥스 뉴스 모니터 — Service Worker v1

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(clients.claim()));

// ─── Push 수신 ────────────────────────────────────────────────────────────────
self.addEventListener('push', event => {
  if (!event.data) return;

  let data;
  try { data = event.data.json(); }
  catch { data = { title: '코스맥스 뉴스', body: event.data.text() }; }

  const options = {
    body:    data.body  || '새 기사가 등록되었습니다',
    icon:    '/icon.png',
    badge:   '/icon.png',
    tag:     data.tag   || 'cosmax-news',
    data:    { url: data.url || '/' },
    vibrate: [200, 100, 200],
    requireInteraction: false,
  };

  event.waitUntil(
    self.registration.showNotification(data.title || '코스맥스 뉴스', options)
  );
});

// ─── 알림 클릭 ────────────────────────────────────────────────────────────────
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data?.url || '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if ('focus' in c) return c.focus();
      }
      return clients.openWindow(url);
    })
  );
});
