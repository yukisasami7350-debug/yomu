// 専用のページの控え(工程W1)。電波の無いときも、このページ(index.html)だけは開けるようにする。
//   ふだんは置き場から取って控えを新しくする(電波があれば、いつも新しい)。取れないとき・待っても来ないときは、控えを出す。
//   このページ以外(スクリプト・辞書など)には、手を出さない(置き場から、そのまま取る)。
'use strict';
const CACHE = 'page-v1';
const WAIT = 4000;   // 電波が弱いとき、置き場の返事をこれだけ待ってから、控えを出す(ms)

const scope = () => new URL(self.registration.scope);
const isPage = url => {
  const u = new URL(url), s = scope();
  return u.origin === s.origin && (u.pathname === s.pathname || u.pathname === s.pathname + 'index.html');
};

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.add(scope().href)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const r = e.request;
  if (r.method !== 'GET' || r.mode !== 'navigate' || !isPage(r.url)) return;
  const key = scope().href;
  const saved = () => caches.open(CACHE).then(c => c.match(key));
  const net = fetch(r).then(res => {
    if (res.ok){ const copy = res.clone(); caches.open(CACHE).then(c => c.put(key, copy)); }
    return res;
  });
  e.respondWith(new Promise(done => {
    let over = false;
    const fallback = () => { if (over) return; saved().then(m => { if (m && !over){ over = true; done(m); } }); };
    const t = setTimeout(fallback, WAIT);
    net.then(res => { clearTimeout(t); if (!over){ over = true; done(res); } },
      () => { clearTimeout(t); saved().then(m => { if (!over){ over = true; done(m || Response.error()); } }); });
  }));
});
