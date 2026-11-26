'use strict';

// SaamSaam app-shell service worker (sync-engine v2 M4; update rules Y-update).
//
// Goal: the app opens from this cache when the server cannot answer (offline,
// or the dev box behind the Cloudflare tunnel is down and Cloudflare answers
// 5xx or hangs), and a new build replaces the cached one the first time the
// server answers OK. Data freshness stays entirely owned by the sync engine.
//
// Rules:
//  - /api/* and /sync/* are never touched. A cache-busting query on
//    version.json (the update probe) goes straight to the network.
//  - Content-hashed files (main.<hash>.dart.js, <name>.<hash>.otf, see
//    HASHED_NAME) are immutable: cache-first.
//  - Every other shell file (navigations / index.html, flutter_bootstrap.js,
//    flutter.js, version.json, assets/*Manifest*, canvaskit/*, ...) is
//    NETWORK-FIRST. It keeps its name across builds, so serving it from the
//    cache without asking the server is how an old build stays pinned. The
//    request revalidates past the HTTP cache (cache: 'no-cache'): Cloudflare
//    rewrites the browser max-age of .js files to 4 h, so a plain fetch could
//    hand back the previous flutter_bootstrap.js.
//  - Only a usable answer is served from the network or cached: status 200,
//    same-origin, and a content type that matches the file. An HTML page is
//    usable only for a navigation or an .html file: a proxy's error page is not
//    a script, and production nginx answers a missing file with index.html.
//    Anything else (a 5xx such as Cloudflare's 530, a network error, or no
//    response headers within NETWORK_TIMEOUT_MS) falls back to the cached
//    copy. Error responses are never cached.
//  - A usable answer goes to the page as soon as its headers arrive; the cache
//    write runs alongside (event.waitUntil), so a body that stalls never holds
//    the page while it reads into the cache.
//  - Deadlines stop the waiting, not the download. When one expires the page
//    gets the cached copy and the download carries on in the background, so a
//    slow link still converges on the new build at the next boot. With nothing
//    cached there is nothing to fall back on, so the worker waits for the
//    network however long it takes.
//  - After a server failure (no answer, or a 5xx) the server counts as down for
//    SERVER_DOWN_MS and network-first files come straight from the cache, so a
//    boot against a hung server waits for one timeout, not one per file. A
//    wrong-type 200 does not count: it arrives at once, so the breaker would
//    save no waiting, and on production nginx it is how a healthy server
//    answers a missing file.
//  - flutter_bootstrap.js names the build's main.<hash>.dart.js. A new
//    bootstrap is served and cached only once that entrypoint is cached too, so
//    the cache never holds a bootstrap whose build it cannot boot offline.

// Bumped when the cache layout changes; activate drops every other generation
// (the pre-Y worker also cached './' under -v1).
const CACHE = 'saamsaam-shell-v2';

// No response headers within this, or no bootstrap body, → use the cache.
// Short, because the fallback is a working app; long enough for a slow mobile
// link to answer a 304.
const NETWORK_TIMEOUT_MS = 4000;

// How long a new flutter_bootstrap.js waits for its main.<hash>.dart.js to
// download before the cached build boots instead. The download goes on.
const ENTRYPOINT_TIMEOUT_MS = 30000;

// How long a server failure marks the server as down.
const SERVER_DOWN_MS = 30000;

// Stable-named shell files that exist under the same name in every build.
// Best-effort, except REQUIRED: an install that cannot cache a bootable shell
// fails, so the previous worker keeps control with its cache intact.
const PRECACHE = [
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
const REQUIRED = ['index.html', 'flutter_bootstrap.js'];

// agollum patch-cache-bust.sh names a content-hashed file <name>.<8 hex>.<ext>
// (main.<hash>.dart.js, MaterialIcons-Regular.<hash>.otf).
const HASHED_NAME = /\.[0-9a-f]{8}\./i;
const ENTRYPOINT_NAME = /^main\.[0-9a-f]{8}\.dart\.js$/i;
const MAIN_JS_PATH = /"mainJsPath"\s*:\s*"([^"]+)"/;

const TIMED_OUT = Symbol('timed out');

let serverDownUntil = 0;

function markServerDown() {
  serverDownUntil = Date.now() + SERVER_DOWN_MS;
}

function serverLooksDown() {
  return Date.now() < serverDownUntil;
}

function scopeUrl(path) {
  return new URL(path, self.registration.scope);
}

function fileName(url) {
  return url.pathname.slice(url.pathname.lastIndexOf('/') + 1);
}

function isHashed(url) {
  return HASHED_NAME.test(fileName(url));
}

function isBootstrap(url) {
  return fileName(url) === 'flutter_bootstrap.js';
}

function isApiOrSync(url) {
  // The data engine owns this freshness; the shell SW must never cache it.
  return /\/(api|sync)\//.test(url.pathname) || /\/(api|sync)$/.test(url.pathname);
}

function isVersionProbe(url) {
  return url.pathname.endsWith('version.json') && url.search.length > 0;
}

// The content type a usable answer for this file must carry, or null when any
// type but HTML will do (images, fonts).
function expectedType(url, navigation) {
  const name = fileName(url);
  if (navigation || name === '' || name.endsWith('.html')) return /text\/html/i;
  if (name.endsWith('.js') || name.endsWith('.mjs')) return /javascript|ecmascript/i;
  if (name.endsWith('.wasm')) return /application\/wasm/i;
  if (name.endsWith('.json')) return /json/i;
  return null;
}

function isUsable(res, url, navigation) {
  if (!res || res.status !== 200 || res.type !== 'basic') return false;
  const type = res.headers.get('content-type') || '';
  const want = expectedType(url, navigation);
  return want ? want.test(type) : !/text\/html/i.test(type);
}

// Whether an unusable answer means the server (or the path to it) is down: no
// answer, or a 5xx. A 4xx or a wrong-type 200 comes from a server that is up
// (see the header).
function isServerFailure(res) {
  return !res || res.status >= 500;
}

// fetch() that resolves to null on a network error instead of rejecting.
function fetchOrNull(request) {
  return fetch(request).catch(() => null);
}

// Settles like promise, or with TIMED_OUT after ms; promise keeps running.
function within(promise, ms) {
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

// Waits for promise within ms when there is a cached copy to fall back on,
// and for as long as it takes when there is not.
function waitFor(promise, ms, cached) {
  return cached ? within(promise, ms) : promise;
}

// Writes to the cache. A failure (quota, or a body that broke off) caches
// nothing and must never reach the page. Resolves to whether it was written.
function put(cache, key, res) {
  return cache.put(key, res).then(() => true, () => false);
}

function entrypointOf(bootstrapBody) {
  const match = MAIN_JS_PATH.exec(bootstrapBody);
  return match ? scopeUrl(match[1]) : null;
}

// Ensures the entrypoint is cached, downloading it if not. Resolves to whether
// it is. No deadline of its own: callers bound how long they wait for it.
async function cacheEntrypoint(cache, mainUrl) {
  if (await cache.match(mainUrl)) return true;
  const res = await fetchOrNull(new Request(mainUrl));
  return isUsable(res, mainUrl, false) && (await put(cache, mainUrl, res));
}

// Caches a fetched flutter_bootstrap.js (body already read) only together with
// the entrypoint it names. Resolves to whether that entrypoint is cached, that
// is whether the bootstrap may be served; caches nothing when it is not.
async function commitBootstrap(cache, key, res, body) {
  const mainUrl = entrypointOf(body);
  // No mainJsPath (an unpatched or wasm build): nothing to pair it with.
  if (mainUrl && !(await cacheEntrypoint(cache, mainUrl))) return false;
  await put(cache, key, new Response(body, { status: res.status, headers: res.headers }));
  return true;
}

// Drops the entrypoints of earlier builds. Only once the page has been handed
// the bootstrap naming mainUrl: a page booting the cached build still needs
// its entrypoint.
async function pruneEntrypoints(cache, mainUrl) {
  for (const old of await cache.keys()) {
    const url = new URL(old.url);
    if (ENTRYPOINT_NAME.test(fileName(url)) && url.href !== mainUrl.href) {
      await cache.delete(old);
    }
  }
}

// Fetches flutter_bootstrap.js and caches it with its build, in the
// background. Never served to the page.
async function refreshBootstrap(cache) {
  const url = scopeUrl('flutter_bootstrap.js');
  const res = await fetchOrNull(new Request(url, { cache: 'no-cache' }));
  if (isUsable(res, url, false)) await commitBootstrap(cache, url, res, await res.text());
}

// Caches an answer that arrived after the page was served the cached copy.
async function storeLate(cache, key, url, navigation, res) {
  if (!isUsable(res, url, navigation)) return;
  if (isBootstrap(url)) {
    await commitBootstrap(cache, key, res, await res.text());
    return;
  }
  await put(cache, key, res);
  // The server is slow, not down, but it is marked down, so this boot took the
  // cached bootstrap without asking. Fetch the one the new shell loads, or a
  // server that is always this slow would pin the old build for good.
  if (navigation) await refreshBootstrap(cache);
}

function offlineResponse(navigation) {
  return navigation
    ? new Response('Offline', { status: 503, statusText: 'Offline' })
    : new Response('', { status: 504, statusText: 'Offline' });
}

// Serves a usable flutter_bootstrap.js only once the entrypoint it names is
// cached; else the cached bootstrap, whose build boots offline. The body has
// to be read to find that entrypoint, so the body gets a deadline too.
async function serveBootstrap(event, cache, key, res, cached) {
  const reading = res.clone().text().catch(() => null);
  const body = await waitFor(reading, NETWORK_TIMEOUT_MS, cached);
  if (body === TIMED_OUT) {
    markServerDown();
    event.waitUntil(reading.then((late) => late !== null && commitBootstrap(cache, key, res, late)));
    return cached;
  }
  if (body === null) {
    // The body broke off.
    markServerDown();
    return cached || res;
  }
  const committing = commitBootstrap(cache, key, res, body);
  const committed = await waitFor(committing, ENTRYPOINT_TIMEOUT_MS, cached);
  if (committed === TIMED_OUT) {
    // A slow link: boot the cached build, and let the download finish so the
    // next boot gets the new one.
    markServerDown();
    event.waitUntil(committing);
    return cached;
  }
  if (!committed) {
    // The entrypoint did not download: boot the cached build.
    markServerDown();
    return cached || res;
  }
  const mainUrl = entrypointOf(body);
  if (mainUrl) event.waitUntil(pruneEntrypoints(cache, mainUrl));
  return res;
}

// Network-first for a stable-named shell file (see the header). key is the
// cache entry: index.html for every navigation.
async function networkFirst(event, req, url, key, navigation) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(key);
  if (cached && serverLooksDown()) return cached;

  const answer = fetchOrNull(new Request(req, { cache: 'no-cache' }));
  const res = await waitFor(answer, NETWORK_TIMEOUT_MS, cached);
  if (res === TIMED_OUT) {
    markServerDown();
    event.waitUntil(answer.then((late) => storeLate(cache, key, url, navigation, late)));
    return cached;
  }
  if (isUsable(res, url, navigation)) {
    if (isBootstrap(url)) return serveBootstrap(event, cache, key, res, cached);
    event.waitUntil(put(cache, key, res.clone()));
    return res;
  }
  if (isServerFailure(res)) markServerDown();
  if (cached) return cached;
  // Nothing cached. With no answer at all, the HTTP cache may still hold a
  // fresh copy (offline); a server answer is passed on uncached so the page
  // sees the real status.
  if (!res) return (await fetchOrNull(req)) || offlineResponse(navigation);
  return res;
}

async function cacheFirst(event, req, url) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  // Nothing to fall back on: wait for the network however long it takes.
  const res = await fetchOrNull(req);
  if (isUsable(res, url, false)) {
    event.waitUntil(put(cache, req, res.clone()));
    return res;
  }
  if (isServerFailure(res)) markServerDown();
  return res || offlineResponse(false);
}

// Precaches one shell file through the same checks as the fetch handler.
// Resolves to whether it is cached.
async function precache(cache, path) {
  const url = scopeUrl(path);
  const res = await fetchOrNull(new Request(url, { cache: 'reload' }));
  if (!isUsable(res, url, false)) return false;
  if (isBootstrap(url)) return commitBootstrap(cache, url, res, await res.text());
  return put(cache, url, res);
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // Each file on its own, so an optional file cannot abort the precache.
      // No deadline: no page is waiting on an install.
      const done = await Promise.all(PRECACHE.map((path) => precache(cache, path)));
      const missing = REQUIRED.filter((path) => !done[PRECACHE.indexOf(path)]);
      if (missing.length) throw new Error(`could not precache ${missing.join(', ')}`);
      // Take control at once: the next load (which may be offline) is then
      // served from this cache.
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.filter((n) => n.startsWith('saamsaam-shell-') && n !== CACHE)
          .map((n) => caches.delete(n))
      );
      await self.clients.claim();
    })()
  );
});

// PURGE_SHELL is sent by the page before it reloads to apply an update. The
// pre-Y cache-first worker empties its cache on it, which is the only way a
// client still running that worker reaches a new build. This worker serves the
// shell network-first, so a reload replaces it whenever the server answers OK,
// and emptying the cache would throw away the offline copy for when it does
// not: it only acknowledges.
self.addEventListener('message', (event) => {
  const data = event.data;
  if (data && data.type === 'PURGE_SHELL' && event.ports && event.ports[0]) {
    event.ports[0].postMessage({ ok: true });
  }
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (isApiOrSync(url) || isVersionProbe(url)) return;

  if (req.mode === 'navigate') {
    // Client-side routes all resolve to the one shell.
    event.respondWith(networkFirst(event, req, url, scopeUrl('index.html'), true));
    return;
  }
  event.respondWith(isHashed(url) ? cacheFirst(event, req, url) : networkFirst(event, req, url, req, false));
});
