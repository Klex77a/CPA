'use strict';
// No DNS/network traffic: injected resolvers and HTTPS transport exercise the boundary.
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { execFileSync } = require('node:child_process');
const { assertAudioPageUrl, fetchAudioPage, isPublicAddress } = require('../src/audio-access');

let count = 0;
async function test(name, fn) { await fn(); count++; console.log('✔', name); }
const publicDns = async () => [{ address: '93.184.215.14', family: 4 }];

function mockTransport({ status = 200, type = 'text/html', body = '<audio></audio>' } = {}) {
  const calls = [];
  const request = (url, options, onResponse) => {
    calls.push({ url, options });
    const req = new EventEmitter();
    const response = Readable.from([Buffer.from(body)]);
    response.statusCode = status;
    response.headers = { 'content-type': type };
    req.end = () => queueMicrotask(() => onResponse(response));
    req.destroy = (error) => { response.destroy(); req.emit('error', error); };
    return req;
  };
  return { request, calls };
}

async function main() {
  await test('IPv4: localhost, metadata, private/shared, documentation, multicast и reserved запрещены', async () => {
    for (const address of ['0.0.0.0', '10.1.2.3', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.31.255.255', '192.168.1.1', '192.0.0.1', '192.0.2.1', '192.88.99.1', '198.19.1.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255']) assert.strictEqual(isPublicAddress(address), false, address);
    for (const address of ['8.8.8.8', '1.1.1.1', '93.184.215.14']) assert.strictEqual(isPublicAddress(address), true, address);
  });

  await test('IPv6: loopback, mapped IPv4, ULA/link-local, translation, special и documentation запрещены', async () => {
    for (const address of ['::', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1', 'fc00::1', 'fe80::1', 'ff02::1', '64:ff9b::a00:1', '100::1', '2001::1', '2001:db8::1', '2002:7f00:1::', '3fff::1', 'fe80::1%eth0']) assert.strictEqual(isPublicAddress(address), false, address);
    for (const address of ['2001:4860:4860::8888', '2606:4700:4700::1111', '2a00:1450:4001:800::200e']) assert.strictEqual(isPublicAddress(address), true, address);
  });

  await test('URL: HTTPS/443, отсутствие credentials и только точные разрешённые домены', async () => {
    for (const url of ['not a url', 'http://example.com/a', 'https://u:p@example.com/a', 'https://example.com:8443/a', 'https://localhost/a', 'https://host.internal/a', 'https://127.1/a', 'https://0x7f000001/a', 'https://[::ffff:127.0.0.1]/a']) {
      await assert.rejects(assertAudioPageUrl(url, { lookup: publicDns, allowedHosts: [] }));
    }
    await assert.rejects(assertAudioPageUrl('https://badexample.com/a', { lookup: publicDns, allowedHosts: ['example.com'] }));
    await assert.rejects(assertAudioPageUrl('https://sub.example.com/a', { lookup: publicDns, allowedHosts: ['example.com'] }));
    const result = await assertAudioPageUrl('https://EXAMPLE.COM/a', { lookup: publicDns, allowedHosts: ['example.com'] });
    assert.strictEqual(result.url.hostname, 'example.com');
  });

  await test('проверяются все DNS ответы; mixed public/private, пустой DNS и ошибка запрещены', async () => {
    const lookups = [
      async () => [{ address: '93.184.215.14', family: 4 }, { address: '10.0.0.1', family: 4 }],
      async () => [{ address: '93.184.215.14', family: 4 }, { address: '::ffff:192.168.1.1', family: 6 }],
      async () => [],
      async () => { throw new Error('ENOTFOUND'); },
    ];
    for (const lookup of lookups) await assert.rejects(assertAudioPageUrl('https://example.com/a', { lookup, allowedHosts: [] }));
    await assertAudioPageUrl('https://example.com/a', { allowedHosts: [], lookup: async (_host, options) => {
      assert.deepStrictEqual(options, { all: true, verbatim: true });
      return [{ address: '93.184.215.14', family: 4 }, { address: '2606:4700:4700::1111', family: 6 }];
    } });
  });

  await test('соединение закрепляет проверенный IP и не повторяет DNS при подключении', async () => {
    let lookups = 0;
    const lookup = async () => { lookups++; return [{ address: lookups === 1 ? '93.184.215.14' : '127.0.0.1', family: 4 }]; };
    const transport = mockTransport();
    const response = await fetchAudioPage('https://example.com/page', { allowedHosts: [], lookup, request: transport.request });
    assert.strictEqual(response.status, 200);
    assert.strictEqual(await response.text(), '<audio></audio>');
    const options = transport.calls[0].options;
    assert.strictEqual(options.agent, false);
    assert.strictEqual(options.family, 4);
    options.lookup('example.com', {}, (error, address, family) => {
      assert.ifError(error);
      assert.strictEqual(address, '93.184.215.14');
      assert.strictEqual(family, 4);
    });
    options.lookup('example.com', { all: true }, (error, addresses) => {
      assert.ifError(error);
      assert.deepStrictEqual(addresses, [{ address: '93.184.215.14', family: 4 }]);
    });
    assert.strictEqual(lookups, 1);
    assert.ok(!('rejectUnauthorized' in options), 'TLS validation must remain enabled');
  });

  await test('редиректы и слишком большие HTML страницы отклоняются; аудио не буферизуется', async () => {
    const common = { allowedHosts: [], lookup: publicDns };
    const redirect = mockTransport({ status: 302 });
    await assert.rejects(fetchAudioPage('https://example.com/page', { ...common, request: redirect.request }), /Перенаправления/);
    assert.strictEqual(redirect.calls.length, 1);
    const large = mockTransport({ body: '123456' });
    await assert.rejects(fetchAudioPage('https://example.com/page', { ...common, request: large.request, maxBytes: 3 }), /размер/);
    const audio = mockTransport({ type: 'audio/mpeg' });
    const response = await fetchAudioPage('https://example.com/a.mp3', { ...common, request: audio.request });
    assert.strictEqual(response.headers.get('content-type'), 'audio/mpeg');
    assert.strictEqual(response.body, null);
    const empty = mockTransport({ status: 204 });
    assert.strictEqual((await fetchAudioPage('https://example.com/empty', { ...common, request: empty.request })).status, 204);
    const invalidStatus = mockTransport({ status: 600 });
    await assert.rejects(fetchAudioPage('https://example.com/invalid', { ...common, request: invalidStatus.request }), /HTTP статус/);
  });

  await test('нечисловые env настройки не превращают batch/retry/стоимость в NaN', async () => {
    const selected = ['HOST', 'PORT', 'CONCURRENCY', 'SAMPLES', 'LLM_TIMEOUT_MS', 'LLM_MAX_ATTEMPTS', 'REPAIR_ATTEMPTS', 'PRICE_IN_PER_M', 'PRICE_OUT_PER_M', 'TEMPERATURE', 'MAX_OUTPUT_TOKENS'];
    const script = `const c=require('./src/config'); process.stdout.write(JSON.stringify(Object.fromEntries(${JSON.stringify(selected)}.map(k=>[k,c[k]]))));`;
    const result = JSON.parse(execFileSync(process.execPath, ['-e', script], {
      cwd: require('node:path').join(__dirname, '..'), encoding: 'utf8',
      env: { ...process.env, LLM_PROVIDER: 'mock', HOST: '', PORT: 'NaN', CONCURRENCY: 'bad', SAMPLES: 'Infinity', LLM_TIMEOUT_MS: 'NaN', LLM_MAX_ATTEMPTS: 'bad', REPAIR_ATTEMPTS: '0', PRICE_IN_PER_M: 'bad', PRICE_OUT_PER_M: '0', TEMPERATURE: 'bad', MAX_OUTPUT_TOKENS: 'bad' },
    }));
    assert.strictEqual(result.HOST, '127.0.0.1');
    assert.strictEqual(result.PORT, 3000);
    assert.strictEqual(result.CONCURRENCY, 2);
    assert.strictEqual(result.SAMPLES, 1);
    assert.strictEqual(result.LLM_TIMEOUT_MS, 240000);
    assert.strictEqual(result.LLM_MAX_ATTEMPTS, 3);
    assert.strictEqual(result.REPAIR_ATTEMPTS, 0);
    assert.strictEqual(result.PRICE_IN_PER_M, 0);
    assert.strictEqual(result.PRICE_OUT_PER_M, 0);
    assert.strictEqual(result.TEMPERATURE, null);
    assert.strictEqual(result.MAX_OUTPUT_TOKENS, null);
  });
  console.log(`audio-access: пройдено ${count}`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
