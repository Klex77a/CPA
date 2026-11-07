'use strict';
// Audio pages are untrusted imported URLs. Check every DNS answer, then pin the
// validated address during the HTTPS connection instead of resolving it again.
const dns = require('node:dns').promises;
const https = require('node:https');
const net = require('node:net');
const cfg = require('./config');

const accessError = (message) => Object.assign(new Error(message), { status: 502 });
const normalizeHost = (host) => String(host).toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');

function ipv4Number(address) {
  return address.split('.').reduce((value, part) => (value << 8n) + BigInt(part), 0n);
}

function ipv6Number(address) {
  let text = address.toLowerCase();
  if (text.includes('.')) {
    const colon = text.lastIndexOf(':');
    const value = ipv4Number(text.slice(colon + 1));
    text = text.slice(0, colon + 1) + (value >> 16n).toString(16) + ':' + (value & 65535n).toString(16);
  }
  const halves = text.split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const groups = halves.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  return groups.reduce((value, group) => (value << 16n) + BigInt('0x' + group), 0n);
}

function inRange(value, start, prefix, bits) {
  const shift = BigInt(bits - prefix);
  return value >> shift === start >> shift;
}

// Conservative IANA special-purpose exclusions. Some special anycast addresses
// are globally reachable; audio playback has no reason to contact those ranges.
// https://www.iana.org/assignments/iana-ipv4-special-registry/
const blockedV4 = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
].map(([address, prefix]) => [ipv4Number(address), prefix]);

function isPublicAddress(address) {
  const family = net.isIP(address);
  if (family === 4) {
    const value = ipv4Number(address);
    return !blockedV4.some(([start, prefix]) => inRange(value, start, prefix, 32));
  }
  if (family !== 6 || address.includes('%')) return false;
  const value = ipv6Number(address);
  // Only global unicast; excludes mapped IPv4, NAT64, local, link-local and multicast.
  // https://www.iana.org/assignments/iana-ipv6-special-registry/
  if (!inRange(value, ipv6Number('2000::'), 3, 128)) return false;
  return ![['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]]
    .some(([start, prefix]) => inRange(value, ipv6Number(start), prefix, 128));
}

/** Validate the URL and all DNS answers. Returns {url: URL, addresses: AddressInfo[]}. */
async function assertAudioPageUrl(value, options = {}) {
  let url;
  try { url = new URL(value); } catch (_) { throw accessError('Некорректная ссылка на запись'); }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) {
    throw accessError('Запись должна использовать HTTPS на порту 443 без логина и пароля в URL');
  }
  const host = normalizeHost(url.hostname);
  if (!host || host === 'localhost' || /\.(localhost|local|internal|home|lan)$/.test(host)) throw accessError('Локальные адреса записей запрещены');
  const allowed = options.allowedHosts ?? cfg.AUDIO_ALLOWED_HOSTS;
  if (allowed.length && !allowed.some((item) => normalizeHost(item) === host)) throw accessError('Домен записи отсутствует в AUDIO_ALLOWED_HOSTS');

  let addresses;
  if (net.isIP(host)) addresses = [{ address: host, family: net.isIP(host) }];
  else {
    const lookup = options.lookup || ((name, opts) => dns.lookup(name, opts));
    let timer;
    try {
      addresses = await Promise.race([
        lookup(host, { all: true, verbatim: true }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(accessError('Превышено время DNS-проверки записи')), 5000); }),
      ]);
    } catch (error) {
      if (error.status) throw error;
      throw accessError('Не удалось проверить DNS сервиса записей');
    } finally { clearTimeout(timer); }
  }
  if (!Array.isArray(addresses) || !addresses.length || addresses.some((entry) => !entry || !isPublicAddress(entry.address) || net.isIP(entry.address) !== entry.family)) {
    throw accessError('Сервис записей ссылается на закрытый или служебный IP-адрес');
  }
  return { url, addresses };
}

/** Fetch one audio page with pinned DNS, normal TLS validation and no redirects.
 * Returns a Response; non-HTML bodies are closed immediately (the browser streams audio).
 * lookup/request can be injected by offline tests; production uses Node DNS/HTTPS.
 */
async function fetchAudioPage(value, options = {}) {
  const { url, addresses } = await assertAudioPageUrl(value, options);
  const address = addresses.find((entry) => entry.family === 4) || addresses[0];
  const request = options.request || https.request;
  const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const req = request(url, {
      method: 'GET', agent: false, family: address.family,
      signal: AbortSignal.timeout(options.timeoutMs ?? 20000),
      lookup: (_host, lookupOptions, callback) => {
        if (typeof lookupOptions === 'function') { callback = lookupOptions; lookupOptions = {}; }
        if (lookupOptions.all) callback(null, [address]);
        else callback(null, address.address, address.family);
      },
      headers: { Accept: 'text/html,audio/*;q=0.9,*/*;q=0.1', 'Accept-Encoding': 'identity' },
    }, (res) => {
      const status = res.statusCode || 502;
      const headers = new Headers();
      for (const [name, item] of Object.entries(res.headers)) if (item !== undefined) headers.set(name, Array.isArray(item) ? item.join(', ') : item);
      if (status < 200 || status > 599) {
        res.destroy();
        return reject(accessError('Сервис записей вернул некорректный HTTP статус'));
      }
      if (status >= 300 && status < 400) {
        res.destroy();
        return reject(accessError('Перенаправления сервиса записей запрещены'));
      }
      if (status === 204 || status === 205 || !/text\/html/i.test(headers.get('content-type') || '')) {
        res.destroy();
        return resolve(new Response(null, { status, headers }));
      }
      const chunks = [];
      let bytes = 0;
      res.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > maxBytes) {
          req.destroy(accessError('HTML-страница записи превышает допустимый размер'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status, headers })));
      res.on('error', reject);
    });
    req.on('error', (error) => reject(error.status ? error : accessError('Не удалось безопасно получить запись')));
    req.end();
  });
}

module.exports = { assertAudioPageUrl, fetchAudioPage, isPublicAddress };
