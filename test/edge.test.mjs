import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openArchive} from '../src/archive.mjs';
import {collect} from '../src/collector.mjs';
import {parseDecimal, formatMinor, SCALES} from '../src/money.mjs';

// 测试专用最小本地来源：与产品来源服务相互独立，全部为合成资料。
function startTestSource(routes) {
  const state = {routes};
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const route = state.routes.find(item => item.method === request.method && item.path === url.pathname);
    if (!route) { response.writeHead(404).end('not found'); return; }
    const body = typeof route.body === 'string' || Buffer.isBuffer(route.body)
      ? route.body
      : JSON.stringify(route.body);
    response.writeHead(route.status ?? 200, {'content-type': route.type ?? 'application/json'}).end(body);
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        setRoutes: routes => { state.routes = routes; },
        close: () => new Promise(done => { server.close(done); server.closeAllConnections(); })
      });
    });
  });
}

const adviceRoute = envelopes => ({method: 'GET', path: '/advice', body: {envelopes}});
const envelope = (sender, control, href) => ({sender, control, href});

async function withArchive(callback) {
  const directory = await mkdtemp(join(tmpdir(), 'edge-'));
  try { await callback(directory); } finally { await rm(directory, {recursive: true, force: true}); }
}

test('金额按币种 scale 精确解释，保留原文，拒绝超精度与非字符串', () => {
  assert.deepEqual(parseDecimal('89.90', SCALES.CNY), {ok: true, minor: 8990});
  assert.deepEqual(parseDecimal('1000', SCALES.JPY), {ok: true, minor: 1000});
  assert.equal(parseDecimal('100.5', SCALES.JPY).ok, false);
  assert.equal(parseDecimal('89.909', SCALES.CNY).ok, false);
  assert.equal(parseDecimal(9.9, SCALES.CNY).ok, false);
  assert.equal(parseDecimal('1,000.00', SCALES.CNY).ok, false);
  assert.equal(formatMinor(8990, 2), '89.90');
  assert.equal(formatMinor(-5, 2), '-0.05');
  assert.equal(formatMinor(1000, 0), '1000');
});

test('整批费用留在付款层，不向申报或服务行摊分', async () => {
  const source = await startTestSource([
    adviceRoute([envelope('s', 'c1', '/e1')]),
    {method: 'GET', path: '/e1', body: {
      paymentId: 'p1', currency: 'CNY', paid: '198.00',
      providerAdjustments: [{group: 'P', reason: 'batch-fee', amount: '2.00'}],
      claims: [
        {claimId: 'cA', submitted: '100.00', paid: '100.00', adjustments: [], lines: [
          {lineId: 'l1', charge: '100.00', paid: '100.00', adjustments: []}
        ]},
        {claimId: 'cB', submitted: '100.00', paid: '100.00', adjustments: [], lines: [
          {lineId: 'l2', charge: '100.00', paid: '100.00', adjustments: []}
        ]}
      ]
    }}
  ]);
  await withArchive(async directory => {
    try {
      const archive = await openArchive(directory);
      const result = await collect({baseUrl: source.baseUrl, archive, mode: 'source'});
      assert.equal(result.complete, true);
      assert.equal(result.records.length, 2);
      for (const row of result.records) {
        assert.equal(row.lineAdjustments.length, 0);
        assert.equal(row.claimAdjustments.length, 0);
        // 整批调整只出现在付款层视图
        assert.deepEqual(row.providerAdjustments.map(a => a.group), ['P']);
        assert.equal(row.balances.payment.status, 'balanced');
        assert.equal(row.balances.payment.providerAdjustmentsTotal.minorUnits, 200);
        assert.equal(row.balances.payment.residual.minorUnits, 0);
      }
      const paid = result.records.map(r => r.minorUnits.paid);
      assert.deepEqual(paid.sort((a, b) => a - b), [10000, 10000]);
    } finally { await source.close(); }
  });
});

test('申报身份由 sender/claimId 决定，控制号不充当申报身份', async () => {
  const body = {
    paymentId: 'p1', currency: 'CNY', paid: '90.00', providerAdjustments: [],
    claims: [{claimId: 'cA', submitted: '100.00', paid: '90.00',
      adjustments: [{group: 'C', reason: 'x', amount: '10.00'}],
      lines: [{lineId: 'l1', charge: '100.00', paid: '90.00', adjustments: []}]}]
  };
  const source = await startTestSource([
    adviceRoute([envelope('s', 'control-9', '/e1'), envelope('other', 'control-9', '/e2')]),
    {method: 'GET', path: '/e1', body},
    {method: 'GET', path: '/e2', body}
  ]);
  await withArchive(async directory => {
    try {
      const archive = await openArchive(directory);
      const result = await collect({baseUrl: source.baseUrl, archive, mode: 'source'});
      const keys = result.records.map(r => r.claimKey).sort();
      assert.deepEqual(keys, ['other/cA', 's/cA']);
      for (const row of result.records) {
        assert.ok(!row.claimKey.includes('control-9'), 'claimKey 不得使用 control');
        assert.ok(row.id.startsWith('line:'), '归档 id 仍稳定区分到行');
        assert.ok(row.evidence.adviceHash.length === 64);
      }
    } finally { await source.close(); }
  });
});

test('无服务行付款输出付款级记录并保留不平衡差异，不改写来源金额', async () => {
  const source = await startTestSource([
    adviceRoute([envelope('s', 'c2', '/e2')]),
    {method: 'GET', path: '/e2', body: {
      paymentId: 'p2', currency: 'CNY', paid: '89.90', providerAdjustments: [],
      claims: [{claimId: 'cB', submitted: '100.00', paid: '90.00', adjustments: [], lines: []}]
    }}
  ]);
  await withArchive(async directory => {
    try {
      const archive = await openArchive(directory);
      const result = await collect({baseUrl: source.baseUrl, archive, mode: 'source'});
      assert.equal(result.records.length, 1);
      const payment = result.records[0];
      assert.equal(payment.type, 'payment');
      assert.equal(payment.balanceStatus, 'unbalanced');
      assert.equal(payment.paid, '89.90');
      assert.equal(payment.balances.payment.residual.minorUnits, 10);
      assert.equal(payment.balances.payment.residual.text, '0.10');
      assert.ok(result.issues.some(i => i.code === 'PAYMENT_UNBALANCED'));
      // 来源原文与归档证据均保留差异金额
      const evidence = archive.snapshot().evidence;
      const raw = JSON.parse(await archive.raw(evidence.find(e => e.url.endsWith('/e2')).hash));
      assert.equal(raw.paid, '89.90');
    } finally { await source.close(); }
  });
});

test('环形替换保持未决：链上回执不进入有效视图，证据仍归档', async () => {
  const makeBody = (paid, replaces) => ({
    paymentId: 'p1', currency: 'CNY', paid, providerAdjustments: [], replaces,
    claims: [{claimId: 'cA', submitted: '100.00', paid, adjustments: [],
      lines: [{lineId: 'l1', charge: '100.00', paid, adjustments: []}]}]
  });
  const source = await startTestSource([
    adviceRoute([envelope('s', 'c1', '/e1'), envelope('s', 'c2', '/e2')]),
    {method: 'GET', path: '/e1', body: makeBody('90.00', {sender: 's', control: 'c2'})},
    {method: 'GET', path: '/e2', body: makeBody('80.00', {sender: 's', control: 'c1'})}
  ]);
  await withArchive(async directory => {
    try {
      const archive = await openArchive(directory);
      const result = await collect({baseUrl: source.baseUrl, archive, mode: 'source'});
      assert.equal(result.complete, false);
      assert.equal(result.records.length, 0);
      assert.ok(result.issues.some(i => i.code === 'REPLACEMENT_PENDING'));
      assert.ok(result.issues.filter(i => i.severity === 'gap').every(i => i.code === 'REPLACEMENT_PENDING'));
      const snapshot = archive.snapshot();
      assert.equal(snapshot.records.filter(r => r.type === 'source-receipt').length, 2);
      assert.ok(snapshot.evidence.length >= 3);
    } finally { await source.close(); }
  });
});

test('替换目标缺失保持未决，目标随后到达时自动转为有效视图', async () => {
  const makeBody = (paid, replaces) => ({
    paymentId: 'p1', currency: 'CNY', paid, providerAdjustments: [], ...(replaces ? {replaces} : {}),
    claims: [{claimId: 'cA', submitted: '100.00', paid, adjustments: [],
      lines: [{lineId: 'l1', charge: '100.00', paid, adjustments: []}]}]
  });
  const source = await startTestSource([
    adviceRoute([envelope('s', 'c2', '/e2')]),
    {method: 'GET', path: '/e2', body: makeBody('80.00', {sender: 's', control: 'c1'})}
  ]);
  await withArchive(async directory => {
    try {
      const firstArchive = await openArchive(directory);
      const first = await collect({baseUrl: source.baseUrl, archive: firstArchive, mode: 'source'});
      assert.equal(first.complete, false);
      assert.equal(first.records.length, 0);

      source.setRoutes([
        adviceRoute([envelope('s', 'c1', '/e1'), envelope('s', 'c2', '/e2')]),
        {method: 'GET', path: '/e1', body: makeBody('90.00', null)},
        {method: 'GET', path: '/e2', body: makeBody('80.00', {sender: 's', control: 'c1'})}
      ]);
      const secondArchive = await openArchive(directory);
      const second = await collect({baseUrl: source.baseUrl, archive: secondArchive, mode: 'source'});
      assert.equal(second.complete, true);
      assert.equal(second.records.length, 1);
      assert.equal(second.records[0].paid, '80.00');
      assert.equal(second.records[0].replacementState, 'active');
      const snapshot = secondArchive.snapshot();
      const receipts = snapshot.records.filter(r => r.type === 'source-receipt');
      // 归档保留全部修订；同一回执的最后修订才是当前替换状态。
      const latest = control => receipts.filter(r => r.control === control).at(-1);
      const c1 = latest('c1');
      const c2 = latest('c2');
      assert.equal(c1.replacementState, 'superseded');
      assert.equal(c2.replacementState, 'active');
      // 旧的未决修订仍保留为审计轨迹
      assert.ok(receipts.some(r => r.control === 'c2' && r.replacementState === 'pending'));
      // 被替换回执的原文证据仍在
      assert.ok(snapshot.evidence.some(e => e.url.endsWith('/e1')));
    } finally { await source.close(); }
  });
});

test('重复领取同一回执不增加归档修订', async () => {
  const source = await startTestSource([
    adviceRoute([envelope('s', 'c1', '/e1')]),
    {method: 'GET', path: '/e1', body: {
      paymentId: 'p1', currency: 'CNY', paid: '90.00', providerAdjustments: [],
      claims: [{claimId: 'cA', submitted: '100.00', paid: '90.00', adjustments: [],
        lines: [{lineId: 'l1', charge: '100.00', paid: '90.00', adjustments: []}]}]
    }}
  ]);
  await withArchive(async directory => {
    try {
      const archive = await openArchive(directory);
      await collect({baseUrl: source.baseUrl, archive, mode: 'source'});
      await collect({baseUrl: source.baseUrl, archive, mode: 'source'});
      const snapshot = archive.snapshot();
      assert.equal(snapshot.records.length, 2); // 一份回执证据 + 一行业务记录
      assert.equal(new Set(snapshot.records.map(r => r.revision)).size, 2);
    } finally { await source.close(); }
  });
});

test('越界相对链接不发请求，登记可复核缺口，已收证据保留', async () => {
  const source = await startTestSource([
    adviceRoute([envelope('s', 'c1', 'http://example.invalid/e1')])
  ]);
  await withArchive(async directory => {
    try {
      const archive = await openArchive(directory);
      const result = await collect({baseUrl: source.baseUrl, archive, mode: 'source'});
      assert.equal(result.complete, false);
      assert.equal(result.records.length, 0);
      assert.ok(result.issues.some(i => i.code === 'ENVELOPE_FETCH_BLOCKED'));
      assert.equal(result.evidenceCount, 1); // 只有 /advice 真正发出
    } finally { await source.close(); }
  });
});

test('损坏回执正文与超精度金额：原样保留、不四舍五入、标记未决', async () => {
  const source = await startTestSource([
    adviceRoute([envelope('s', 'c1', '/e1'), envelope('s', 'c2', '/e2')]),
    {method: 'GET', path: '/e1', body: 'not-json{', type: 'text/plain'},
    {method: 'GET', path: '/e2', body: {
      paymentId: 'p2', currency: 'CNY', paid: '89.909', providerAdjustments: [],
      claims: [{claimId: 'cB', submitted: '100.00', paid: '90.00', adjustments: [], lines: []}]
    }}
  ]);
  await withArchive(async directory => {
    try {
      const archive = await openArchive(directory);
      const result = await collect({baseUrl: source.baseUrl, archive, mode: 'source'});
      assert.equal(result.complete, false);
      assert.ok(result.issues.some(i => i.code === 'ENVELOPE_MALFORMED'));
      const payment = result.records.find(r => r.type === 'payment');
      assert.ok(payment);
      assert.equal(payment.paid, '89.909');
      assert.equal(payment.minorUnits.paid, null);
      assert.equal(payment.balanceStatus, 'pending');
    } finally { await source.close(); }
  });
});

test('空有效信封列表与未声明币种区分处理', async () => {
  const empty = await startTestSource([adviceRoute([])]);
  await withArchive(async directory => {
    try {
      const archive = await openArchive(directory);
      const result = await collect({baseUrl: empty.baseUrl, archive, mode: 'source'});
      assert.deepEqual(result.records, []);
      assert.equal(result.complete, true);
      assert.equal(result.issues.length, 0);
    } finally { await empty.close(); }
  });

  const foreign = await startTestSource([
    adviceRoute([envelope('s', 'c1', '/e1')]),
    {method: 'GET', path: '/e1', body: {
      paymentId: 'p1', currency: 'USD', paid: '90.00', providerAdjustments: [],
      claims: [{claimId: 'cA', submitted: '100.00', paid: '90.00', adjustments: [], lines: []}]
    }}
  ]);
  await withArchive(async directory => {
    try {
      const archive = await openArchive(directory);
      const result = await collect({baseUrl: foreign.baseUrl, archive, mode: 'source'});
      assert.equal(result.complete, false);
      assert.ok(result.issues.some(i => i.code === 'CURRENCY_UNSUPPORTED'));
      assert.equal(result.records.length, 0);
    } finally { await foreign.close(); }
  });
});

test('一笔汇款对应多份申报：各申报与服务行调整归属可分别追溯', async () => {
  const source = await startTestSource([
    adviceRoute([envelope('s', 'c1', '/e1')]),
    {method: 'GET', path: '/e1', body: {
      paymentId: 'p1', currency: 'JPY', paid: '1700',
      providerAdjustments: [{group: 'P', reason: 'fee', amount: '100'}],
      claims: [
        {claimId: 'cA', submitted: '1000', paid: '900',
          adjustments: [{group: 'C', reason: 'contract', amount: '100'}],
          lines: [{lineId: 'l1', charge: '1000', paid: '900', adjustments: []}]},
        {claimId: 'cB', submitted: '1000', paid: '900',
          adjustments: [{group: 'C', reason: 'contract', amount: '100'}],
          lines: [{lineId: 'l2', charge: '1000', paid: '900',
            adjustments: [{group: 'L', reason: 'line-discount', amount: '100'}]}]}
      ]
    }}
  ]);
  await withArchive(async directory => {
    try {
      const archive = await openArchive(directory);
      const result = await collect({baseUrl: source.baseUrl, archive, mode: 'source'});
      assert.equal(result.complete, true);
      assert.equal(result.records.length, 2);
      const byLine = Object.fromEntries(result.records.map(r => [r.lineId, r]));
      assert.equal(byLine.l1.currency, 'JPY');
      assert.equal(byLine.l1.balances.line.status, 'unbalanced'); // 差异由申报层调整解释
      assert.equal(byLine.l1.balances.claim.status, 'balanced');
      assert.equal(byLine.l2.balances.line.status, 'balanced');
      assert.equal(byLine.l2.lineAdjustments[0].minorUnits, 100);
      assert.equal(byLine.l1.balances.payment.status, 'balanced');
      assert.equal(byLine.l1.balances.payment.residual.minorUnits, 0);
      assert.deepEqual([...new Set(result.records.map(r => r.paymentKey))], ['s/p1']);
      assert.deepEqual(result.records.map(r => r.claimKey).sort(), ['s/cA', 's/cB']);
    } finally { await source.close(); }
  });
});
