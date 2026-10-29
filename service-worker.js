/* Offline application shell and public library assets only.
   Never cache Firebase database, authentication, or Google Drive API responses. */
const VERSION = 'ataya-shell-v5-ataya-1.0.2';
const APP_SHELL = [
    './', './index.html', './login.html',
    './manifest.json?v=2', './icon.png?v=2', './icon-192.png?v=2', './offline-sync.js',
    './category-search.js?v=2', './voice-input.js?v=1'
];
const PRELOAD = [
    { url: 'https://cdn.tailwindcss.com', mode: 'no-cors' },
    { url: 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js', mode: 'no-cors' },
    { url: 'https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js', mode: 'no-cors' },
    { url: 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js', mode: 'cors' },
    { url: 'https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js', mode: 'cors' },
    { url: 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js', mode: 'cors' }
];
const allowedExternal = url =>
    (url.hostname === 'www.gstatic.com' && url.pathname.startsWith('/firebasejs/12.19.0/')) ||
    (url.hostname === 'cdn.tailwindcss.com') ||
    (url.hostname === 'cdn.jsdelivr.net' && url.pathname.startsWith('/npm/xlsx@0.18.5/')) ||
    (url.hostname === 'cdnjs.cloudflare.com' && url.pathname.startsWith('/ajax/libs/html2pdf.js/0.10.1/')) ||
    (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com');

self.addEventListener('install', event => {
    event.waitUntil((async () => {
        const cache = await caches.open(VERSION);
        await cache.addAll(APP_SHELL);
        await Promise.allSettled(PRELOAD.map(async ({ url, mode }) => {
            const response = await fetch(url, { mode });
            if (response.ok || response.type === 'opaque') {
                await cache.put(url, response);
            }
        }));
        await self.skipWaiting();
    })());
});

self.addEventListener('activate', event => {
    event.waitUntil((async () => {
        const keys = await caches.keys();
        await Promise.all(keys.filter(k => k.startsWith('ataya-shell-') && k !== VERSION).map(k => caches.delete(k)));
        await self.clients.claim();
    })());
});

self.addEventListener('fetch', event => {
    const request = event.request;
    if (request.method !== 'GET') return;
    const url = new URL(request.url);
    const isLocal = url.origin === self.location.origin && url.pathname.startsWith(self.registration.scope.replace(self.location.origin, ''));
    if (!isLocal && !allowedExternal(url)) return;

    if (request.mode === 'navigate') {
        event.respondWith((async () => {
            try {
                const response = await fetch(request);
                if (response.ok) {
                    const cache = await caches.open(VERSION);
                    await cache.put(request, response.clone());
                }
                return response;
            } catch (_) {
                const cached = await caches.match(request, { ignoreSearch: true });
                return cached || (await caches.match('./index.html'));
            }
        })());
        return;
    }
    event.respondWith((async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        const response = await fetch(request);
        if (response.ok || response.type === 'opaque') {
            const cache = await caches.open(VERSION);
            await cache.put(request, response.clone());
        }
        return response;
    })());
});