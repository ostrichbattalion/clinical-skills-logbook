/*
 * Keeps the student pages on the phone so the logbook opens and logs entries without signal.
 * Network first (so updates arrive as soon as there is signal), falling back to the saved copy.
 * Only this site's own files are cached: API and sign-in requests go to other origins and are never touched.
 */
const VERSION = 'logbook-shell-v1';
const SHELL = [
  './', 'index.html', 'login.html', 'student_pwa_dashboard.html', 'log_new_encounter.html', 'log_single_skill.html',
  'skills_tracker.html', 'request_signature.html', 'handover.html',
  'css/style.css', 'css/live.css',
  'js/config.js', 'js/api.js', 'js/log-entry.js', 'js/student-dashboard.js', 'js/skills-tracker.js',
  'js/request-signature.js', 'js/handover.js', 'js/sign-batch.js', 'js/vendor/qrcode.js',
  'manifest.webmanifest', 'icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('logbook-shell-') && k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith((async () => {
    const cache = await caches.open(VERSION);
    try {
      const res = await fetch(req);
      if (res.ok && res.type === 'basic') cache.put(req, res.clone());
      return res;
    } catch (err) {
      // pages are opened with ?ids=... etc.; the saved page is the same file
      const saved = await cache.match(req, { ignoreSearch: true });
      if (saved) return saved;
      if (req.mode === 'navigate') return (await cache.match('student_pwa_dashboard.html')) || Response.error();
      throw err;
    }
  })());
});
