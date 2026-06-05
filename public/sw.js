// 코스맥스 뉴스 모니터 — Service Worker v4
const APP_ROOT = 'https://cosmaxpr.onrender.com/';

self.addEventListener('install', e => e.waitUntil(self.skipWaiting()));

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 메시지 수신 (강제 skipWaiting)
self.addEventListener('message', e => {
  if (e.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

// ─── Push 수신 ────────────────────────────────────────────────────────────────
self.addEventListener('push', event => {
  if (!event.data) return;
  let data;
  try { data = event.data.json(); }
  catch { data = { title: '코스맥스 뉴스', body: event.data.text() }; }

  event.waitUntil(
    self.registration.showNotification(data.title || '코스맥스 뉴스', {
      body:    data.body || '새 기사가 등록되었습니다',
      icon:    '/apple-touch-icon-v2.png',
      badge:   '/apple-touch-icon-v2.png',
      tag:     'cosmax-news',
      vibrate: [200, 100, 200],
    })
  );
});

// ─── 알림 클릭 → 앱 메인 (빈화면 완전 방지) ─────────────────────────────────
self.addEventListener('notificationclick', event => {
  event.notification.close();

  event.waitUntil((async () => {
    const allClients = await self.clients.matchAll({
      type: 'window',
      includeUncontrolled: true,
    });

    // 1. 이미 열려있는 앱 창 찾기
    for (const client of allClients) {
      if (client.url.startsWith(APP_ROOT)) {
        await client.focus();
        // 앱에 새로고침 메시지 전송
        client.postMessage({ type: 'NOTIFICATION_CLICK' });
        return;
      }
    }

    // 2. 앱이 없으면 새로 열기
    const newClient = await self.clients.openWindow(APP_ROOT);
    // 약간 딜레이 후 메시지 (앱 로드 대기)
    if (newClient) {
      setTimeout(() => {
        newClient.postMessage({ type: 'NOTIFICATION_CLICK' });
      }, 1500);
    }
  })());
});
