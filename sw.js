// R.E.I.G.N. service worker
// 1. Caches the app shell so the PWA opens instantly and works offline.
// 2. Receives Firebase Cloud Messaging push events while the app is
//    closed/backgrounded and shows a system notification for them —
//    this is the piece that makes reminders work when the tab isn't open.

const CACHE_NAME = 'reign-shell-v1';
const SHELL_FILES = ['./', './index.html', './manifest.json', './icons/icon-192.png', './icons/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

// Cache-first for the app shell, falling back to network (and caching
// what we fetch) for everything else — keeps Firebase/API calls live.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        if (response && response.ok && event.request.url.startsWith(self.location.origin)) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => cached);
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) { if ('focus' in client) return client.focus(); }
      if (self.clients.openWindow) return self.clients.openWindow('./index.html');
    })
  );
});

// ---- Firebase Cloud Messaging (background) ----
// TODO: this config must match the firebaseConfig in index.html exactly.
importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyADokP7WL2GzFtcV4f1R2nm6kbpkRRyEXg",
  authDomain: "reign-self-improvement.firebaseapp.com",
  projectId: "reign-self-improvement",
  storageBucket: "reign-self-improvement.firebasestorage.app",
  messagingSenderId: "643393213266",
  appId: "1:643393213266:web:71f1efe20372501481a08b",
  measurementId: "G-LRG8NWGHXQ"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  const notif = payload.notification || {};
  self.registration.showNotification(notif.title || 'Quest reminder', {
    body: notif.body || '',
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
    tag: 'reign-reminder-' + (payload.data && payload.data.id ? payload.data.id : Date.now()),
  });
});
