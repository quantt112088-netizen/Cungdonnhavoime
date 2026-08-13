/* ============================================================
   sw-con.js — Cache "vỏ" app (app-shell) cho bản Của Con
   ------------------------------------------------------------
   Mục tiêu: khi mất mạng / mạng yếu, bé vẫn mở lại được app
   (trang, font chữ, thư viện Firebase) để xem tiến độ đã lưu.
   Dữ liệu thật (điểm, nhiệm vụ...) do Firestore tự lo lưu offline
   và tự đồng bộ lại khi có mạng (bật ở phần enablePersistence
   trong trang chính) — service worker này KHÔNG can thiệp vào
   các request tới Firestore/Firebase API.

   Khi bạn sửa app và deploy bản mới, chỉ cần đổi CACHE_VERSION
   bên dưới để buộc trình duyệt lấy bản cache mới.
   ============================================================ */

const CACHE_VERSION = 'con-shell-v1';
const RUNTIME_CACHE = CACHE_VERSION;

// Các domain KHÔNG bao giờ can thiệp/cache — cứ để chạy thẳng ra mạng,
// để không ảnh hưởng tới kết nối realtime & đồng bộ dữ liệu của Firestore.
const NEVER_CACHE_HOSTS = [
  'firestore.googleapis.com',
  'firebaseio.com',
  'googleapis.com/identitytoolkit',
  'fcmregistrations.googleapis.com',
  'firebaseinstallations.googleapis.com',
];

function isNeverCache(url){
  return NEVER_CACHE_HOSTS.some(h => url.hostname.includes(h) || (url.hostname + url.pathname).includes(h));
}

self.addEventListener('install', (event) => {
  self.skipWaiting();
  // Cố gắng "làm nóng" cache với manifest ngay từ đầu, không bắt buộc phải thành công
  event.waitUntil(
    caches.open(RUNTIME_CACHE).then((cache) => {
      return cache.addAll(['manifest-con.json']).catch(() => {
        /* nếu chưa online lúc cài SW hoặc tên file khác thì bỏ qua, sẽ cache dần lúc chạy */
      });
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== RUNTIME_CACHE)
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Chỉ lo GET, các request khác (POST/PUT của Firestore...) để mạng xử lý bình thường
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Không đụng vào các API Firebase/Firestore — tránh phá luồng realtime & offline sync riêng của nó
  if (isNeverCache(url)) return;

  // Điều hướng trang (mở app / load lại trang): network trước, offline thì lấy bản cache đã lưu
  if (req.mode === 'navigate') {
    event.respondWith(networkFirstForNavigate(req));
    return;
  }

  // Tài nguyên tĩnh cùng nguồn hoặc từ font/CDN quen thuộc: lấy cache trước cho nhanh,
  // đồng thời âm thầm cập nhật bản mới nếu có mạng (stale-while-revalidate)
  const cdnHosts = ['fonts.googleapis.com', 'fonts.gstatic.com', 'gstatic.com', 'jsdelivr.net', 'cdnjs.cloudflare.com'];
  const sameOrigin = url.origin === self.location.origin;
  if (sameOrigin || cdnHosts.some(h => url.hostname.includes(h))) {
    event.respondWith(staleWhileRevalidate(req));
  }
});

async function networkFirstForNavigate(req){
  const cache = await caches.open(RUNTIME_CACHE);
  try{
    const fresh = await fetch(req);
    cache.put(req, fresh.clone());
    return fresh;
  }catch(err){
    const cached = await cache.match(req);
    if(cached) return cached;
    // fallback cuối cùng: thử bản cache của trang gốc app (scope root)
    const rootCached = await cache.match(self.registration.scope);
    if(rootCached) return rootCached;
    return new Response(
      '<h1>Đang mất mạng</h1><p>Chưa có bản lưu sẵn của trang này. Hãy mở app một lần khi có mạng để lần sau xem offline được nhé.</p>',
      { headers: { 'Content-Type': 'text/html; charset=UTF-8' } }
    );
  }
}

async function staleWhileRevalidate(req){
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await cache.match(req);
  const networkFetch = fetch(req)
    .then((fresh) => { cache.put(req, fresh.clone()); return fresh; })
    .catch(() => null);
  return cached || (await networkFetch) || new Response('', { status: 504, statusText: 'Offline' });
}
