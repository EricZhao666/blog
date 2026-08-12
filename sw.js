// Service Worker for blog offline support
const CACHE = 'blog-v1';
const ASSETS = [
  './',
  './index.html',
  './css/style.css',
  './vendor/marked.min.js',
  './vendor/highlight.min.js',
  './vendor/atom-one-light.min.css',
  './js/data.js',
  './js/user-posts.js',
  './js/courses.js',
  './js/papers.js',
  './js/projects.js',
  './js/app.js'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      return c.addAll(ASSETS);
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) {
        return k !== CACHE;
      }).map(function (k) {
        return caches.delete(k);
      }));
    }).then(function () {
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then(function (cached) {
      if (cached) return cached;
      return fetch(e.request).then(function (resp) {
        const copy = resp.clone();
        caches.open(CACHE).then(function (c) {
          c.put(e.request, copy);
        });
        return resp;
      }).catch(function () {
        return caches.match('./');
      });
    })
  );
});
