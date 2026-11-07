/* The web app's service worker (v4 — bump SW_VERSION in src/shared/pwa.web.ts with it). One worker for the installed web
   app (PWA) and for push. The file keeps its old name so browsers that registered it for push update in place.

   Offline: the app shell (the page and its hashed bundles, fonts and icons) is kept, so an installed app opens without
   a connection; pages that need the server then say they cannot reach it. Never cached: the APIs (/svc/), the media
   bucket (/s3/: protected video), the admin panel, and anything not GET.
   Push: see the push section below. */
const VERSION = 'v4-3f8ed39f9396ee5bed5b0b3ed86049ecbd24d9b2';   // the deploy writes the build in (web/Dockerfile): a new build gets fresh caches
const SHELL = `couchbay-shell-${VERSION}`;
const STATIC = `couchbay-static-${VERSION}`;
const PRECACHE = ['/', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/icon-maskable-512.png', '/apple-touch-icon.png',
  '/badge-96.png', '/icon-monochrome-192.png', '/icon-monochrome-512.png'];
const SEEN = 'couchbay-push-seen';   // push ids already drawn (kept across worker restarts; not a build cache)

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const c = await caches.open(SHELL);
    // one by one: a missing icon must not stop the worker from installing
    await Promise.all(PRECACHE.map((u) => c.add(new Request(u, { cache: 'reload' })).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('couchbay-') && k !== SHELL && k !== STATIC && k !== SEEN) await caches.delete(k);
    await self.clients.claim();
  })());
});

const NEVER = /^\/(svc|s3|admin)(\/|$)/;
const IMMUTABLE = /^\/(_expo\/static|assets)\//;

const OFFLINE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Offline</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f8f3ec;color:#3b0d14;font:16px/1.5 system-ui,sans-serif;text-align:center;padding:24px}b{display:block;font-size:20px;margin-bottom:6px}</style></head>
<body><div><b>You are offline</b>Connect to the internet and open the app again.<br><span lang="hi">इंटरनेट से जुड़ें और ऐप फिर से खोलें।</span></div></body></html>`;

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || NEVER.test(url.pathname)) return;

  // pages: the network first (always the latest app), the kept shell when offline (one SPA page serves every route)
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res.ok) (await caches.open(SHELL)).put('/', res.clone()).catch(() => {});
        return res;
      } catch (_) {
        return (await caches.match('/', { cacheName: SHELL })) || new Response(OFFLINE, { headers: { 'content-type': 'text/html; charset=utf-8' } });
      }
    })());
    return;
  }

  // hashed bundles, fonts and images never change under one name: the cache first, then the network (and keep it)
  if (IMMUTABLE.test(url.pathname)) {
    event.respondWith((async () => {
      const hit = await caches.match(req, { cacheName: STATIC });
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) (await caches.open(STATIC)).put(req, res.clone()).catch(() => {});
      return res;
    })());
    return;
  }

  // icons and the manifest: whatever is kept, refreshed in the background
  if (PRECACHE.includes(url.pathname)) {
    event.respondWith((async () => {
      const c = await caches.open(SHELL);
      const hit = await c.match(req);
      const fresh = fetch(req).then((res) => { if (res.ok) c.put(req, res.clone()).catch(() => {}); return res; }).catch(() => hit);
      return hit || fresh;
    })());
  }
});

/* ── Push ──────────────────────────────────────────────────────────────────────────────────────────────────────
   The notification service sends web tokens DATA-ONLY pushes (title, body, url, kind, entity_id, tag, dedupe_id …);
   this worker draws every one. No Firebase SDK here: it would draw its own copy and fight ours. Rules:
   • EVERY push ends in showNotification inside event.waitUntil. A push that shows nothing is a "silent push": iOS
     withdraws the subscription after a few, and Chrome shows its own "This site has been updated in the background".
   • Icons are absolute URLs on this origin; the badge is a white-on-transparent 96 px mark (Android's status bar).
   • tag = kind:entity_id (call pushes: call:<id>), renotify with it: one conversation, class or call is ONE
     notification that a newer push replaces and re-announces.
   • A push already drawn (same dedupe id within 10 min: two tokens of one browser) still calls showNotification, as a
     silent throwaway that is closed at once, so the one on screen is never changed or doubled.
   • Already on that page (a focused, visible tab whose path + query match data.url): drawn silently, handed to the
     page, and closed after a second — the page shows it in place, as WhatsApp does for the open chat.
   • A call invite rings (requireInteraction) until answered; one that arrives after expires_at becomes
     "Missed call from …". live_now also stays until handled. Chat does not.
   • A tap focuses an open tab of the app and asks it to open data.url itself (no reload: 'couchbay-open', answered on a
     MessageChannel port); no answer in 1 s → the tab is navigated; no tab → a new window. */
const ORIGIN = self.location.origin;
const ICON = `${ORIGIN}/icon-192.png`;
const BADGE = `${ORIGIN}/badge-96.png`;
const SEEN_MS = 10 * 60 * 1000;
const seen = new Map();   // dedupe id -> first seen (ms); the SEEN cache keeps it across worker restarts

const safeUrl = (u) => (typeof u === 'string' && u.startsWith('/') && !u.startsWith('//') ? u : null);

async function alreadySeen(id) {
  if (!id) return false;
  const now = Date.now();
  for (const [k, t] of seen) if (now - t > SEEN_MS) seen.delete(k);
  if (seen.has(id)) return true;
  seen.set(id, now);   // before any await: two copies arriving together cannot both pass
  try {
    const c = await caches.open(SEEN);
    const key = `${ORIGIN}/__push-seen/${encodeURIComponent(id)}`;
    const hit = await c.match(key);
    if (hit && now - Number(await hit.text()) < SEEN_MS) return true;
    await c.put(key, new Response(String(now)));
    for (const req of await c.keys()) {
      const r = await c.match(req);
      if (r && now - Number(await r.text()) > SEEN_MS) await c.delete(req);
    }
  } catch (_) { /* no Cache API: the in-memory set still covers copies arriving together */ }
  return false;
}

/** What to draw for a push: title, options and where a tap goes. Pure, so the node test can check it. */
function describe(d, now) {
  const kind = typeof (d.kind || d.type) === 'string' ? (d.kind || d.type) : null;
  const call = !!kind && kind.startsWith('call_');
  const entity = d.entity_id || (kind === 'chat_message' && d.conversation_id) || (call && d.call_id) || null;
  const tag = call && entity ? `call:${entity}` : (typeof d.tag === 'string' && d.tag) || (kind && entity ? `${kind}:${entity}` : undefined);
  let url = safeUrl(d.url) || '/notices';
  let title = d.title || (self.location && self.location.host) || 'Notification';   // the academy's own site, never a fixed name
  let body = d.body || '';
  let ring = kind === 'call_invite' || kind === 'live_now';
  if (kind === 'call_invite') {
    const until = Date.parse(d.expires_at || '');
    if (!Number.isNaN(until) && until <= now) {
      // too late to answer: say so instead of ringing (iOS: a push must still show something)
      const who = d.caller_name || d.title || '';
      title = who ? `Missed call from ${who}` : 'Missed call';
      body = d.mode === 'video' ? 'Video call' : 'Voice call';
      ring = false;
      if (d.conversation_id) url = `/group/${d.conversation_id}`;
    }
  }
  const options = { body, icon: ICON, badge: BADGE, requireInteraction: ring, silent: false, timestamp: now, data: { url, kind, tag: tag || null } };
  // renotify is only allowed with a tag (it throws without one)
  if (tag) { options.tag = tag; options.renotify = true; }
  if (kind === 'call_invite' && ring) options.vibrate = [300, 200, 300, 200, 300];
  return { title, options, url, kind, entity };
}

const samePage = (clientUrl, url) => {
  try { const a = new URL(clientUrl); const b = new URL(url, ORIGIN); return a.origin === b.origin && a.pathname === b.pathname && a.search === b.search; }
  catch (_) { return false; }
};

async function closeTagged(tag, nid) {
  const list = await self.registration.getNotifications(tag ? { tag } : {});
  list.filter((n) => !nid || (n.data && n.data.nid === nid)).forEach((n) => n.close());
}

self.addEventListener('push', (event) => {
  let p = {};
  try { p = event.data ? event.data.json() : {}; } catch (_) { p = {}; }
  const d = (p && (p.data || p.notification)) || p || {};
  event.waitUntil((async () => {
    const now = Date.now();
    const { title, options, url, kind, entity } = describe(d, now);
    const id = d.dedupe_id || d.message_id || d.notification_id || null;

    if (await alreadySeen(id)) {
      // a second copy: show a throwaway silently and close it, so the one on screen is left as it is
      const nid = `dup-${now}-${Math.random().toString(36).slice(2)}`;
      await self.registration.showNotification(title, { ...options, tag: nid, renotify: false, silent: true, requireInteraction: false, data: { ...options.data, nid } });
      await closeTagged(nid, null);
      return;
    }

    const tabs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const viewing = tabs.some((c) => c.visibilityState === 'visible' && c.focused && samePage(c.url, url));
    // open tabs hear about it too (the bell refreshes, the page shows it in place)
    tabs.forEach((c) => c.postMessage({ type: 'couchbay-push', url, kind, entity_id: entity, viewing }));

    if (viewing) {
      const nid = `seen-${now}`;
      await self.registration.showNotification(title, { ...options, renotify: false, silent: true, requireInteraction: false, data: { ...options.data, nid } });
      await new Promise((r) => setTimeout(r, 1000));
      await closeTagged(options.tag, nid);
      return;
    }
    await self.registration.showNotification(title, options);
  })());
});

/** Ask a tab to open url itself; true when it answers within `ms`. */
function askToOpen(client, url, ms) {
  return new Promise((resolve) => {
    let done = false;
    let ch = null;
    const finish = (v) => { if (!done) { done = true; try { ch && ch.port1.close(); } catch (_) { /* gone */ } resolve(v); } };
    try {
      ch = new MessageChannel();
      ch.port1.onmessage = (e) => finish(e.data === 'ok');
      client.postMessage({ type: 'couchbay-open', url }, [ch.port2]);
    } catch (_) { finish(false); return; }
    setTimeout(() => finish(false), ms);
  });
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = safeUrl(event.notification.data && event.notification.data.url) || '/notices';
  event.waitUntil((async () => {
    const tabs = (await self.clients.matchAll({ type: 'window', includeUncontrolled: true }))
      .filter((c) => { try { return new URL(c.url).origin === ORIGIN; } catch (_) { return false; } });
    const tab = tabs.find((c) => c.focused) || tabs.find((c) => c.visibilityState === 'visible') || tabs[0];
    if (!tab) { await self.clients.openWindow(url); return; }
    try { await tab.focus(); } catch (_) { /* still try to open the page */ }
    if (await askToOpen(tab, url, 1000)) return;
    if ('navigate' in tab) { try { await tab.navigate(url); return; } catch (_) { /* fall through */ } }
    await self.clients.openWindow(url);
  })());
});

// for the node test (scripts/test-push-sw.mts); a browser's worker has no module object
if (typeof module !== 'undefined') module.exports = { describe, samePage };
