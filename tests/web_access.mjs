import assert from 'node:assert/strict';
import { webAccess } from '../server/lib/webAccess.js';

const password = 'synthetic-test-password-for-access-only';
const auth = 'Basic ' + Buffer.from(`moneysaver:${password}`).toString('base64');
function request(middleware, { ip = '::1', host = 'localhost:3100', headers = {}, url = '/api/settings', method = 'GET' } = {}) {
  const result = { status: 200, headers: {}, passed: false };
  const res = {
    setHeader(k, v) { result.headers[k] = v; },
    status(code) { result.status = code; return this; },
    json(body) { result.body = body; return this; },
  };
  middleware({ socket: { remoteAddress: ip }, headers: { host, ...headers }, originalUrl: url, method }, res, () => { result.passed = true; });
  return result;
}
const local = webAccess();
for (const ip of ['::1', '127.0.0.1', '::ffff:127.0.0.1']) assert(request(local, { ip }).passed);
assert.equal(request(local, { ip: '192.0.2.10' }).status, 403);
assert.equal(request(local, { host: 'attacker.example.com' }).status, 403);
assert.equal(request(local, { host: 'localhost:3100@attacker.example.com' }).status, 403);
assert.equal(request(local, { headers: { origin: 'https://attacker.example.com' }, method: 'POST' }).status, 403);
assert.equal(request(local, { headers: { origin: 'null' } }).status, 403);
assert.equal(request(local, { headers: { 'sec-fetch-site': 'cross-site' } }).status, 403);
assert.equal(request(local, { headers: { 'x-forwarded-for': '127.0.0.1' } }).status, 403);
assert.equal(request(local, { headers: { 'x-forwarded-proto': 'https' } }).status, 403);
assert(request(local, { headers: { origin: 'http://localhost:3100' }, method: 'POST' }).passed);
const secured = webAccess({ password });
assert.equal(request(secured).status, 401);
assert(request(secured, { headers: { authorization: auth } }).passed);
assert(request(secured, { url: '/api/health' }).passed);
assert.equal(request(secured, { url: '/api/health?anything' }).status, 401);
const remote = webAccess({ password, publicOrigin: 'https://money.example.com', trustLocalProxy: true });
const proxyHeaders = { 'x-forwarded-proto': 'https', authorization: auth, origin: 'https://money.example.com' };
assert(request(remote, { host: 'money.example.com', headers: proxyHeaders }).passed);
assert.equal(request(remote, { host: 'money.example.com', headers: proxyHeaders, ip: '192.0.2.10' }).status, 403);
assert.equal(request(remote, { host: 'money.example.com', headers: { ...proxyHeaders, 'x-forwarded-proto': 'http' } }).status, 403);
assert.equal(request(remote, { host: 'attacker.example.com', headers: proxyHeaders }).status, 403);
assert.equal(request(remote, { host: 'money.example.com', headers: { 'x-forwarded-proto': 'https' }, url: '/api/health' }).status, 401);
assert.equal(request(remote, { host: 'money.example.com', headers: proxyHeaders }).headers['Strict-Transport-Security'], 'max-age=31536000');
assert.throws(() => webAccess({ password: 'short' }));
assert.throws(() => webAccess({ publicOrigin: 'https://money.example.com' }));
assert.throws(() => webAccess({ password, trustLocalProxy: true, publicOrigin: 'http://money.example.com' }));
let time = 0;
const limited = webAccess({ password, now: () => time });
for (let i = 0; i < 20; i++) assert.equal(request(limited).status, 401);
assert.equal(request(limited, { headers: { authorization: auth } }).status, 429);
time = 300001;
assert(request(limited, { headers: { authorization: auth } }).passed);
console.log('Web access passed: loopback, authentication, proxy spoofing, HTTPS, host/origin guards, rate limiting.');
