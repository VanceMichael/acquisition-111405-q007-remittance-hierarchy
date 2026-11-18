import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp, rm, mkdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {parseDecimal, sumDecimals, decimalEquals, negateDecimal} from '../src/decimal.mjs';
import {parseAdvice, interpretEnvelope, resolveValidity, recordsFromPayment} from '../src/remittance.mjs';
import {collect} from '../src/collector.mjs';
import {openArchive} from '../src/archive.mjs';
import {startSource} from '../provider/server.mjs';

async function startStub(handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    })
  };
}

function respond(response, status, body) {
  response.writeHead(status, {'content-type': 'application/json'});
  response.end(JSON.stringify(body));
}

test('十进制原文精确求和与比较，不引入浮点误差', () => {
  assert.ok(decimalEquals(sumDecimals([parseDecimal('0.10'), parseDecimal('0.20')]), parseDecimal('0.3')));
  assert.ok(decimalEquals(parseDecimal('89.9'), parseDecimal('89.90')));
  assert.ok(!decimalEquals(parseDecimal('89.91'), parseDecimal('89.90')));
  assert.ok(decimalEquals(
    sumDecimals([parseDecimal('100.00'), negateDecimal(parseDecimal('10.00'))]),
    parseDecimal('90.00')));
  assert.ok(decimalEquals(sumDecimals([parseDecimal('100'), parseDecimal('-5')]), parseDecimal('95')));
  assert.equal(parseDecimal('abc'), null);
  assert.equal(parseDecimal('1.2.3'), null);
  assert.equal(parseDecimal(''), null);
  assert.equal(parseDecimal(90), null);
});

test('信封解释保留三层金额原文与各层调整归属，批次费用不下摊', () => {
  const entry = {sender: 's', control: 'c1', href: '/envelope/1'};
  const body = {
    paymentId: 'p1', currency: 'CNY', paid: '89.90',
    providerAdjustments: [{group: 'P', reason: 'fee', amount: '0.10'}],
    claims: [{
      claimId: 'cA', submitted: '100.00', paid: '90.00',
      adjustments: [{group: 'C', reason: 'contract', amount: '10.00'}],
      lines: [{lineId: 'l1', charge: '100.00', paid: '90.00',
        adjustments: [{group: 'C', reason: 'line-contract', amount: '10.00'}]}]
    }]
  };
  const {payment, issues} = interpretEnvelope(entry, body);
  assert.equal(issues.length, 0);
  assert.equal(payment.balanceStatus, 'balanced');
  assert.equal(payment.claims[0].balanceStatus, 'balanced');
  assert.equal(payment.claims[0].lines[0].balanceStatus, 'balanced');
  const records = recordsFromPayment(payment);
  assert.equal(records.length, 3);
  const [paymentRecord, claimRecord, lineRecord] = records;
  assert.equal(paymentRecord.paid, '89.90');
  assert.deepEqual(paymentRecord.providerAdjustments, [{group: 'P', reason: 'fee', amount: '0.10'}]);
  assert.equal(claimRecord.claimKey, 's/cA');
  assert.equal(claimRecord.submitted, '100.00');
  assert.deepEqual(claimRecord.adjustments, [{group: 'C', reason: 'contract', amount: '10.00'}]);
  assert.equal('providerAdjustments' in claimRecord, false);
  assert.equal('providerAdjustments' in lineRecord, false);
  assert.deepEqual(lineRecord.adjustments, [{group: 'C', reason: 'line-contract', amount: '10.00'}]);
  // 控制号只作信封追溯，不代替申报身份
  assert.equal(claimRecord.claimKey.includes('c1'), false);
  assert.equal(claimRecord.control, 'c1');
  assert.equal(lineRecord.control, 'c1');
  assert.equal(paymentRecord.id, 'payment:s/p1');
  assert.equal(claimRecord.id, 'claim:s/p1/cA');
  assert.equal(lineRecord.id, 'line:s/p1/cA/l1');
});

test('申报级调整不下摊到服务行，差额归属留在申报层', () => {
  const entry = {sender: 's', control: 'c1', href: '/e'};
  const body = {
    paymentId: 'p1', currency: 'CNY', paid: '90.00', providerAdjustments: [],
    claims: [{
      claimId: 'cA', submitted: '100.00', paid: '90.00',
      adjustments: [{group: 'C', reason: 'contract', amount: '10.00'}],
      lines: [{lineId: 'l1', charge: '100.00', paid: '90.00', adjustments: []}]
    }]
  };
  const {payment, issues} = interpretEnvelope(entry, body);
  assert.equal(issues.length, 0);
  assert.equal(payment.balanceStatus, 'balanced');
  assert.equal(payment.claims[0].balanceStatus, 'balanced');
  // 服务行自身账面对不平，差额由申报级调整解释，而不是把调整摊到行上
  assert.equal(payment.claims[0].lines[0].balanceStatus, 'unbalanced');
  const lineRecord = recordsFromPayment(payment).find(record => record.level === 'line');
  assert.deepEqual(lineRecord.adjustments, []);
});

test('对不上的金额原样保留并把差异定位到层，不替来源补差', () => {
  const entry = {sender: 's', control: 'c2', href: '/envelope/2'};
  const body = {
    paymentId: 'p2', currency: 'CNY', paid: '89.90', providerAdjustments: [],
    claims: [{claimId: 'cB', submitted: '100.00', paid: '90.00', adjustments: [], lines: []}]
  };
  const {payment, issues} = interpretEnvelope(entry, body);
  assert.equal(issues.length, 0);
  assert.equal(payment.balanceStatus, 'unbalanced');
  assert.equal(payment.claims[0].balanceStatus, 'unbalanced');
  const records = recordsFromPayment(payment);
  assert.equal(records[0].paid, '89.90');
  assert.equal(records[1].paid, '90.00');
  assert.equal(records.every(record => !('difference' in record)), true);
});

test('未声明币种不解释对平，金额原文保留并留下缺口', () => {
  const entry = {sender: 's', control: 'c1', href: '/e'};
  const body = {
    paymentId: 'p1', currency: 'EUR', paid: '89.90', providerAdjustments: [],
    claims: [{claimId: 'cA', submitted: '100.00', paid: '89.90', adjustments: [], lines: []}]
  };
  const {payment, issues} = interpretEnvelope(entry, body);
  assert.equal(payment.balanceStatus, 'unknown');
  assert.equal(payment.claims[0].balanceStatus, 'unknown');
  assert.ok(issues.some(issue => issue.code === 'currency-unknown'));
  const records = recordsFromPayment(payment);
  assert.equal(records[0].paid, '89.90');
  assert.equal(records[0].currency, 'EUR');
});

test('金额不是十进制字符串时该层对平未知并定位字段', () => {
  const entry = {sender: 's', control: 'c1', href: '/e'};
  const body = {
    paymentId: 'p1', currency: 'CNY', paid: '89.90', providerAdjustments: [],
    claims: [{claimId: 'cA', submitted: '一百', paid: '90.00', adjustments: [], lines: []}]
  };
  const {payment, issues} = interpretEnvelope(entry, body);
  assert.equal(payment.claims[0].balanceStatus, 'unknown');
  const issue = issues.find(item => item.code === 'amount-invalid');
  assert.equal(issue.field, 'submitted');
  assert.equal(issue.claimId, 'cA');
  assert.equal(payment.claims[0].submitted, '一百');
});

test('替换链按 sender/control 追踪：链式、自环、缺失目标、重复与冲突', () => {
  const entry = (sender, control, replaces) => ({
    sender, control, href: `/${control}`,
    payment: {sender, control, href: `/${control}`, paymentId: 'p1', balanceStatus: 'balanced', claims: [],
      ...(replaces ? {replaces} : {})}
  });
  let result = resolveValidity([
    entry('s', 'c1'),
    entry('s', 'c2', {sender: 's', control: 'c1'}),
    entry('s', 'c3', {sender: 's', control: 'c2'})
  ]);
  assert.deepEqual(result.valid.map(item => item.control), ['c3']);
  assert.equal(result.issues.length, 0);
  result = resolveValidity([entry('s', 'c1', {sender: 's', control: 'c1'})]);
  assert.equal(result.valid.length, 0);
  assert.ok(result.issues.some(issue => issue.code === 'replacement-cycle'));
  result = resolveValidity([entry('s', 'c2', {sender: 's', control: 'c9'})]);
  assert.equal(result.valid.length, 1);
  assert.ok(result.issues.some(issue => issue.code === 'replacement-target-missing'));
  result = resolveValidity([entry('s', 'c1'), entry('s', 'c1')]);
  assert.equal(result.valid.length, 0);
  assert.ok(result.issues.some(issue => issue.code === 'envelope-duplicate'));
  result = resolveValidity([
    entry('s', 'c1'),
    entry('s', 'c2', {sender: 's', control: 'c1'}),
    entry('s', 'c3', {sender: 's', control: 'c1'})
  ]);
  assert.equal(result.valid.length, 0);
  assert.ok(result.issues.some(issue => issue.code === 'replacement-conflict'));
});

test('回执清单只接受声明的信封结构', () => {
  assert.deepEqual(parseAdvice({envelopes: []}), {entries: [], issues: []});
  const bad = parseAdvice({envelopes: [{sender: 's'}]});
  assert.equal(bad.entries.length, 0);
  assert.equal(bad.issues.length, 1);
  assert.equal(parseAdvice('nope').issues[0].code, 'advice-invalid');
  assert.equal(parseAdvice({}).issues[0].code, 'advice-invalid');
});

test('清单领取失败与空清单、错误状态区分开', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'source-'));
  const stub = await startStub((request, response) => {
    if (request.url === '/advice') return respond(response, 503, {error: 'down'});
    respond(response, 404, {});
  });
  try {
    const archive = await openArchive(directory);
    const result = await collect({baseUrl: stub.baseUrl, archive, mode: 'source'});
    assert.equal(result.complete, false);
    assert.equal(result.records.length, 0);
    assert.ok(result.issues.some(issue => issue.code === 'advice-unavailable' && issue.status === 503));
    assert.equal(result.evidenceCount, 1);
    assert.equal(archive.snapshot().evidence.length, 1);
  } finally {
    await stub.close();
    await rm(directory, {recursive: true, force: true});
  }
});

test('空的有效清单是完整结果而非错误', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'source-'));
  const stub = await startStub((request, response) => respond(response, 200, {envelopes: []}));
  try {
    const archive = await openArchive(directory);
    const result = await collect({baseUrl: stub.baseUrl, archive, mode: 'source'});
    assert.equal(result.complete, true);
    assert.deepEqual(result.records, []);
    assert.deepEqual(result.issues, []);
    assert.equal(result.evidenceCount, 1);
  } finally {
    await stub.close();
    await rm(directory, {recursive: true, force: true});
  }
});

test('单个信封领取失败时保留已收的安全部分并标记未决', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'source-'));
  const stub = await startStub((request, response) => {
    if (request.url === '/advice') {
      return respond(response, 200, {envelopes: [
        {sender: 's', control: 'c1', href: '/ok'},
        {sender: 's', control: 'c2', href: '/broken'}
      ]});
    }
    if (request.url === '/ok') {
      return respond(response, 200, {
        paymentId: 'p1', currency: 'CNY', paid: '90.00', providerAdjustments: [],
        claims: [{claimId: 'cA', submitted: '100.00', paid: '90.00',
          adjustments: [{group: 'C', reason: 'contract', amount: '10.00'}], lines: []}]
      });
    }
    respond(response, 500, {});
  });
  try {
    const archive = await openArchive(directory);
    const result = await collect({baseUrl: stub.baseUrl, archive, mode: 'source'});
    assert.equal(result.complete, false);
    assert.ok(result.issues.some(issue => issue.code === 'envelope-fetch-failed' && issue.href === '/broken'));
    assert.ok(result.records.some(record => record.paymentKey === 's/p1'));
    assert.equal(result.evidenceCount, 3);
  } finally {
    await stub.close();
    await rm(directory, {recursive: true, force: true});
  }
});

test('信封链接越界时不发请求并留下缺口', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'source-'));
  const stub = await startStub((request, response) => {
    respond(response, 200, {envelopes: [{sender: 's', control: 'c1', href: 'http://example.invalid/x'}]});
  });
  try {
    const archive = await openArchive(directory);
    const result = await collect({baseUrl: stub.baseUrl, archive, mode: 'source'});
    assert.equal(result.complete, false);
    assert.ok(result.issues.some(issue => issue.code === 'envelope-fetch-failed'));
    assert.equal(result.records.length, 0);
    assert.equal(result.evidenceCount, 1);
  } finally {
    await stub.close();
    await rm(directory, {recursive: true, force: true});
  }
});

test('重复领取生成稳定标识，归档不堆叠相同修订', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'source-'));
  const source = await startSource('levels');
  try {
    let archive = await openArchive(directory);
    const first = await collect({baseUrl: source.baseUrl, archive, mode: 'source'});
    assert.equal(first.complete, true);
    archive = await openArchive(directory);
    const second = await collect({baseUrl: source.baseUrl, archive, mode: 'source'});
    assert.deepEqual(second.records, first.records);
    const snapshot = archive.snapshot();
    assert.equal(snapshot.records.length, 3);
    assert.ok(snapshot.evidence.length > 0);
    const advice = snapshot.evidence.find(item => item.url.endsWith('/advice'));
    assert.ok(advice);
    const raw = JSON.parse(await archive.raw(advice.hash));
    assert.ok(Array.isArray(raw.envelopes));
  } finally {
    await source.close();
    await rm(directory, {recursive: true, force: true});
  }
});

test('既有 schema=1 归档缺少 issues 字段时仍可读取与提交', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'source-'));
  await mkdir(join(directory, 'raw'), {recursive: true});
  await writeFile(join(directory, 'index.json'), JSON.stringify({
    schema: 1,
    records: [{id: 'p0', paid: '90.00', currency: 'CNY', revision: 'old'}],
    evidence: []
  }));
  const source = await startSource('levels');
  try {
    const archive = await openArchive(directory);
    assert.equal(archive.snapshot().records.length, 1);
    const result = await collect({baseUrl: source.baseUrl, archive, mode: 'source'});
    assert.equal(result.complete, true);
    assert.ok(archive.snapshot().records.length > 1);
  } finally {
    await source.close();
    await rm(directory, {recursive: true, force: true});
  }
});
