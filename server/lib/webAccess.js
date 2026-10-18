// ברירת מחדל: גישה מקומית בלבד. גישה דרך proxy מקומי מחייבת HTTPS וסיסמה.
import { createHash, timingSafeEqual } from 'node:crypto';

export function isLoopback(address = '') {
  return address === '::1' || address === '127.0.0.1' || address === '::ffff:127.0.0.1';
}

export function webAccess({ password = '', publicOrigin = '', trustLocalProxy = false, now = Date.now } = {}) {
  if (password && (password.length < 32 || /[\r\n:]/.test(password))) {
    throw new Error('MONEYSAVER_WEB_PASSWORD must contain at least 32 characters and no colon or newline.');
  }
  let origin;
  if (publicOrigin) {
    const u = new URL(publicOrigin);
    if (u.protocol !== 'https:' || u.username || u.password || u.pathname !== '/' || u.search || u.hash) {
      throw new Error('MONEYSAVER_PUBLIC_ORIGIN must be an HTTPS origin without a path or credentials.');
    }
    origin = u.origin;
  }
  if ((origin || trustLocalProxy) && !(origin && password && trustLocalProxy)) {
    throw new Error('Remote access requires a password, HTTPS public origin, and explicit trust of a local proxy.');
  }
  const expected = createHash('sha256').update(`moneysaver:${password}`).digest();
  const failures = new Map();
  const deny = (res, code, message) => res.status(code).json({ error: message });
  return (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    const local = isLoopback(req.socket.remoteAddress);
    const forwarded = ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto']
      .some((key) => req.headers[key] !== undefined);
    const proxied = local && trustLocalProxy && req.headers['x-forwarded-proto'] === 'https';
    if (!local || (forwarded && !proxied)) return deny(res, 403, 'Remote access requires the configured local HTTPS proxy.');
    let requestOrigin;
    try {
      const url = new URL(`${proxied ? 'https' : 'http'}://${req.headers.host}`);
      if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error();
      if (proxied) {
        if (url.origin !== origin) throw new Error();
      } else if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error();
      requestOrigin = url.origin;
    } catch { return deny(res, 403, 'Host is not allowed.'); }
    // נגד CSRF ו-DNS rebinding, כולל בקשות GET עם השפעות צד.
    if (req.headers['sec-fetch-site'] === 'cross-site'
      || (req.headers.origin !== undefined && req.headers.origin !== requestOrigin)) {
      return deny(res, 403, 'Cross-origin requests are not allowed.');
    }
    // ה-watchdog המקומי רואה רק אינדיקציית חיים, ללא נתונים או הגדרות.
    if (!proxied && req.method === 'GET' && req.originalUrl === '/api/health') return next();
    if (!password) return next();
    if (proxied) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    const key = req.socket.remoteAddress;
    const t = now();
    const prior = failures.get(key);
    if (prior && prior.until > t && prior.count >= 20) {
      res.setHeader('Retry-After', String(Math.ceil((prior.until - t) / 1000)));
      return deny(res, 429, 'Too many login attempts. Try again later.');
    }
    const auth = req.headers.authorization || '';
    let supplied = '';
    if (/^Basic [A-Za-z0-9+/]+={0,2}$/i.test(auth) && auth.length <= 2048) {
      supplied = Buffer.from(auth.slice(6), 'base64').toString('utf8');
    }
    const actual = createHash('sha256').update(supplied).digest();
    if (!timingSafeEqual(expected, actual)) {
      if (failures.size >= 1024) failures.clear();
      failures.set(key, { count: prior && prior.until > t ? prior.count + 1 : 1, until: prior && prior.until > t ? prior.until : t + 300000 });
      res.setHeader('WWW-Authenticate', 'Basic realm="MoneySaver", charset="UTF-8"');
      return deny(res, 401, 'Authentication required.');
    }
    next();
  };
}
