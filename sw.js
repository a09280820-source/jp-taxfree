/* 離線快取：App 本體優先用網路（有更新就拿新的），沒網路就用快取 */
const CACHE = 'jptax-v24';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'calc.js', 'config.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];
const COUPON_FILES = ["coupons/alpen.jpg", "coupons/alpen-t.jpg", "coupons/cosmos.jpg", "coupons/cosmos-t.jpg", "coupons/snowpeak.jpg", "coupons/snowpeak-t.jpg", "coupons/keio.jpg", "coupons/keio-t.jpg", "coupons/matsumoto.jpg", "coupons/matsumoto-t.jpg", "coupons/cocokara.jpg", "coupons/cocokara-t.jpg", "coupons/sapporo.jpg", "coupons/sapporo-t.jpg", "coupons/drug11.jpg", "coupons/drug11-t.jpg", "coupons/sugi.jpg", "coupons/sugi-t.jpg", "coupons/yamada.jpg", "coupons/yamada-t.jpg", "coupons/biccamera.jpg", "coupons/biccamera-t.jpg", "coupons/daimaru.jpg", "coupons/daimaru-t.jpg", "coupons/tsuruha.jpg", "coupons/tsuruha-t.jpg", "coupons/sundrug.jpg", "coupons/sundrug-t.jpg", "coupons/kokumin.jpg", "coupons/kokumin-t.jpg", "coupons/edion.jpg", "coupons/edion-t.jpg"];
const STATIC_HOSTS = ['cdn.sheetjs.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL).catch(() => {}).then(() => Promise.all(COUPON_FILES.map(f => c.add(f).catch(() => {}))))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // 字型與 Excel 元件：先用快取，背景更新
  if (STATIC_HOSTS.includes(url.hostname)) {
    e.respondWith(
      caches.open(CACHE).then(cache =>
        cache.match(req).then(hit => {
          const net = fetch(req).then(res => { cache.put(req, res.clone()); return res; }).catch(() => hit);
          return hit || net;
        })
      )
    );
    return;
  }

  // 自己網站的檔案：網路優先，失敗用快取
  if (url.origin === location.origin) {
    e.respondWith(
      fetch(req, { cache: 'no-cache' }).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy));
        return res;
      }).catch(() => caches.match(req).then(hit => hit || caches.match('index.html')))
    );
  }
  // 其他（GAS、Google 登入、匯率）不攔截
});
