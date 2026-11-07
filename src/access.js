'use strict';
const crypto = require('node:crypto');

const hash = (text) => crypto.createHash('sha256').update(text).digest();
function credentialsMatch(header, username, password) {
  if (typeof header !== 'string' || header.length > 4096 || !/^Basic [A-Za-z0-9+/]+={0,2}$/i.test(header)) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  return crypto.timingSafeEqual(hash(decoded), hash(`${username}:${password}`));
}

/** A private team workspace is required before exposing conversations and paid API calls. */
function authorize(req, res, config) {
  if (!config.CLOUD_MODE && !config.ACCESS_PASSWORD) return true;
  res.setHeader('Cache-Control', 'no-store');
  if (!config.ACCESS_PASSWORD || config.ACCESS_PASSWORD.length < 16) {
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Для облачного приложения настройте CQA_ACCESS_PASSWORD: не менее 16 символов.');
    return false;
  }
  if (credentialsMatch(req.headers.authorization, config.ACCESS_USERNAME, config.ACCESS_PASSWORD)) return true;
  res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8', 'WWW-Authenticate': 'Basic realm="Midnight Commit", charset="UTF-8"' });
  res.end('Войдите с логином и паролем команды.');
  return false;
}

function isSameOrigin(req, origin, cloudMode) {
  // Proxy headers are trusted only inside the explicitly selected cloud runtime.
  const protocol = cloudMode ? 'https' : req.socket?.encrypted ? 'https' : 'http';
  return origin === `${protocol}://${req.headers.host}`;
}

module.exports = { authorize, credentialsMatch, isSameOrigin };
