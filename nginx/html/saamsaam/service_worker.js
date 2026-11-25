'use strict';

// SaamSaam app-shell service worker (sync-engine v2 M4).
//
// Goal: a tap opens the app FROM CACHE — instant, and offline after the first
// online visit — while data freshness stays entirely owned by the sync engine.
//
// Design notes (see _docs/plan/sync-engine.md M4):
//  - We own the caching SW. Flutter's own flutter_service_worker.js is a
//    self-unregistering stub on 3.29+; index.html suppresses its registration
//    so it cannot collide with us on scope '/'.
//  - The agollum build content-hashes filenames (main.<hash>.dart.js, the icon
//    font) but emits no enumerable precache manifest, and the build script is
//    shared tooling we must not modify. So we PRECACHE the stable-named
//    entrypoints and CACHE-FIRST everything else in the shell on demand: the
//    first online load fills the cache, every later cold start serves from it.
//    Hashed assets are immutable, so cache-first is always correct for them.
//  - We NEVER touch /api/* or /sync/* — the data engine owns that freshness.
//    version.json is served cache-first (it marks the running build generation);
//    a cache-busting query on it bypasses us to the network for update
//    detection.
//  - "Apply update" = purge this cache generation + reload; cache-first then
//    re-fetches the build. A refill of an UNHASHED file (index.html,
//    flutter_bootstrap.js, flutter.js, version.json, canvaskit/*, ...) asks the
//    browser to revalidate (cache: 'no-cache'): a plain fetch would go through
//    the HTTP cache, and Cloudflare rewrites the browser TTL of these files to
//    hours, so the refill could hand back the old flutter_bootstrap.js — which
//    names the old main.<hash>.dart.js — and the SW would cache the old build
//    again. Hashed files are immutable, so their HTTP-cache copy is correct.

const CACHE = 'saamsaam-shell-v1';

// Stable-named shell entrypoints that exist under the same name in every build.
// Best-effort: a missing one must not fail the whole install.
const PRECACHE = [
  './',
  'index.html',
  'flutter_bootstrap.js',
  'flutter.js',
  'manifest.json',
  'favicon.png',
  'version.json',
  // Versioned names; must match web_database_location.dart (checked by
  // test/core/storage/web_assets_test.dart).
  'drift_worker-2.35.4.js',
  'sqlite3-3.5.2.wasm',
  'icons/Icon-192.png',
  'icons/Icon-512.png',
  'icons/Icon-maskable-192.png',
  'icons/Icon-maskable-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // Add individually so one 404 cannot abort the whole precache.
      await Promise.all(
        PRECACHE.map((path) =>
          cache
            .add(new Request(new URL(path, self.registration.scope), { cache: 'reload' }))
            .catch(() => {})
        )
      );
      // Take control on first install so the SECOND load (which may be offline)
      // is already served from cache.
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Drop any older-named shell caches.
      const names = await caches.keys();
      await Promise.all(
        names.filter((n) => n.startsWith('saamsaam-shell-') && n !== CACHE)
          .map((n) => caches.delete(n))
      );
      await self.clients.claim();
    })()
  );
});

// Message channel from the page: purge the shell cache so the next load
// re-fetches the new build. The page reloads once this resolves.
self.addEventListener('message', (event) => {
  const data = event.data;
  if (data && data.type === 'PURGE_SHELL') {
    const done = caches.delete(CACHE).then(() => {
      if (event.ports && event.ports[0]) {
        event.ports[0].postMessage({ ok: true });
      }
    });
    event.waitUntil(done);
  }
});

function isApiOrSync(url) {
  // The data engine owns this freshness; the shell SW must never cache it.
  return /\/(api|sync)\//.test(url.pathname) || /\/(api|sync)$/.test(url.pathname);
}

function isVersionProbe(url) {
  // A cache-busting query on version.json is the update-detection probe — always
  // straight to the network, never cached.
  return url.pathname.endsWith('version.json') && url.search.length > 0;
}

// agollum patch-cache-bust.sh names a content-hashed file <name>.<8 hex>.<ext>
// (main.<hash>.dart.js, MaterialIcons-Regular.<hash>.otf).
const HASHED_NAME = /\.[0-9a-f]{8}\./i;

function isHashed(url) {
  return HASHED_NAME.test(url.pathname.slice(url.pathname.lastIndexOf('/') + 1));
}

// Fetch a shell file from the network, revalidating an unhashed one past the
// HTTP cache (see the header). If that fails — offline — retry with the
// request's own cache mode, so a copy still fresh in the HTTP cache can boot
// the app as it did before; only a second failure is a real miss.
async function fetchShell(req, url) {
  if (isHashed(url)) return fetch(req);
  try {
    return await fetch(new Request(req, { cache: 'no-cache' }));
  } catch (_) {
    return fetch(req);
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Only the shell's own origin. Cross-origin (should be none — CanvasKit is
  // bundled locally) is left to the browser.
  if (url.origin !== self.location.origin) return;

  // Data traffic and the update probe bypass the cache entirely.
  if (isApiOrSync(url) || isVersionProbe(url)) return;

  // SPA navigations: serve the cached shell so a cold/offline open boots, and
  // client-side routes resolve to index.html.
  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        const shell = await cache.match(new URL('index.html', self.registration.scope));
        if (shell) return shell;
        try {
          const fresh = await fetchShell(req, url);
          // Self-heal the shell. The precache is the ONLY other path that stores
          // index.html, and it runs solely on SW (re)install. So when PURGE_SHELL
          // (an "apply update") empties the cache while THIS file is unchanged —
          // e.g. only the Dart bundle changed — the browser does not reinstall the
          // SW, install never re-runs, and index.html is never restored: the cache
          // then holds every hashed asset (filled cache-first below) but not the
          // shell, and the next offline open falls through to the 503 below. The
          // navigate handler is the one path that always sees index.html online, so
          // it must be the one that puts it back. Same-origin 200s only; a failed
          // cache write must never break serving the live response.
          if (fresh && fresh.status === 200 && fresh.type === 'basic') {
            cache.put(new URL('index.html', self.registration.scope), fresh.clone())
              .catch(() => {});
          }
          return fresh;
        } catch (_) {
          // Last resort if index.html was never cached.
          const root = await cache.match(new URL('./', self.registration.scope));
          if (root) return root;
          return new Response('Offline', { status: 503, statusText: 'Offline' });
        }
      })()
    );
    return;
  }

  // Cache-first for every other shell asset; fill the cache on first fetch.
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(req);
      if (hit) return hit;
      try {
        const res = await fetchShell(req, url);
        // Only cache successful, basic (same-origin) responses.
        if (res && res.status === 200 && res.type === 'basic') {
          cache.put(req, res.clone());
        }
        return res;
      } catch (e) {
        // Offline and not cached: nothing we can do.
        return new Response('', { status: 504, statusText: 'Offline' });
      }
    })()
  );
});
