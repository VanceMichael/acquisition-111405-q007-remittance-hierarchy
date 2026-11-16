import {createTransport} from './transport.mjs';
import {normalizeLegacy} from './legacy.mjs';
import {interpretReceipt, resolveReplacementStates} from './source.mjs';
import {digest} from './archive.mjs';

function issue(code, severity, message, loc, extra = {}) {
  return {code, severity, message, loc, ...extra};
}

async function collectSource({baseUrl, archive, transport}) {
  const issues = [];
  const advice = await transport.request('/advice');
  if (!advice.ok) throw new Error(`回执信封领取失败：${advice.status}`);

  let payload;
  try {
    payload = advice.json();
  } catch (error) {
    throw new Error(`回执信封不是有效JSON：${error.message}`);
  }
  const adviceHash = digest(advice.bytes);
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.envelopes)) {
    issues.push(issue('ADVICE_INVALID', 'gap', '/advice 缺少 envelopes 数组', '/advice'));
    await archive.commit({records: [], exchanges: transport.exchanges, issues});
    return {records: [], complete: false, issues, evidenceCount: transport.exchanges.length};
  }

  const seen = new Set();
  const entries = [];
  payload.envelopes.forEach((envelope, index) => {
    const loc = `/advice/envelopes/${index}`;
    if (!envelope || typeof envelope !== 'object'
      || typeof envelope.sender !== 'string' || !envelope.sender
      || typeof envelope.control !== 'string' || !envelope.control
      || typeof envelope.href !== 'string' || !envelope.href) {
      issues.push(issue('ENVELOPE_REF_INVALID', 'gap', '信封引用缺少 sender/control/href', loc));
      return;
    }
    const key = `${envelope.sender}/${envelope.control}`;
    if (seen.has(key)) {
      issues.push(issue('ENVELOPE_DUPLICATE', 'gap', '同一 sender/control 出现多份信封，保留首次出现项', loc, {sender: envelope.sender, control: envelope.control}));
      return;
    }
    seen.add(key);
    entries.push({sender: envelope.sender, control: envelope.control, href: envelope.href});
  });

  const runReceipts = [];
  for (const entry of entries) {
    // HTTP 相对链接基于来源 origin 解析；越界由 transport 拦截，这里转成可复核问题。
    let response;
    try {
      response = await transport.request(entry.href);
    } catch (error) {
      issues.push(issue('ENVELOPE_FETCH_BLOCKED', 'gap', `回执领取被拦截：${error.message}`, entry.href, {...entry}));
      continue;
    }
    if (!response.ok) {
      issues.push(issue('ENVELOPE_FETCH_FAILED', 'gap', `回执领取失败：HTTP ${response.status}`, entry.href, {...entry, status: response.status}));
      continue;
    }
    let body;
    try {
      body = response.json();
    } catch (error) {
      issues.push(issue('ENVELOPE_MALFORMED', 'gap', `回执不是有效JSON：${error.message}`, entry.href, {...entry}));
      continue;
    }
    const interpretation = interpretReceipt({
      sender: entry.sender,
      control: entry.control,
      body,
      adviceHash,
      envelopeHash: digest(response.bytes),
      href: entry.href
    });
    issues.push(...interpretation.issues);
    runReceipts.push({
      sender: entry.sender,
      control: entry.control,
      replaces: interpretation.replaces,
      interpretable: interpretation.interpretable,
      receiptRecord: interpretation.receiptRecord,
      rows: interpretation.rows
    });
  }

  // 替换链按 sender/control 追踪，而不是领取顺序；结合既有归档，跨批次仍可识别有效回执。
  const snapshot = archive.snapshot();
  const archived = new Map();
  for (const record of snapshot.records) {
    if (record.type !== 'source-receipt') continue;
    archived.set(`${record.sender}/${record.control}`, {
      sender: record.sender,
      control: record.control,
      // 替换链必须随归档持久化，重开后仍能按 sender/control 追踪。
      replaces: record.replaces ?? null
    });
  }
  for (const receipt of runReceipts) {
    archived.set(`${receipt.sender}/${receipt.control}`, {
      sender: receipt.sender,
      control: receipt.control,
      replaces: receipt.replaces
    });
  }
  const states = resolveReplacementStates([...archived.values()]);

  const records = [];
  for (const receipt of runReceipts) {
    const key = `${receipt.sender}/${receipt.control}`;
    const state = states.get(key) ?? {state: 'pending', reason: '替换状态无法确定'};
    if (receipt.receiptRecord) {
      records.push({...receipt.receiptRecord, replacementState: state.state, replacementReason: state.reason ?? null});
    }
    if (state.state === 'active') {
      for (const row of receipt.rows) records.push({...row, replacementState: 'active'});
    } else {
      issues.push(issue(
        state.state === 'superseded' ? 'RECEIPT_SUPERSEDED' : 'REPLACEMENT_PENDING',
        state.state === 'superseded' ? 'info' : 'gap',
        state.state === 'superseded'
          ? `回执已被替换，保留归档证据，不进入当前有效视图：${key}`
          : `替换关系未决，回执不能作为有效视图：${state.reason ?? key}`,
        receipt.receiptRecord?.href ?? key,
        {sender: receipt.sender, control: receipt.control, replaces: receipt.replaces ?? null}
      ));
    }
  }

  const hasGap = issues.some(item => item.severity === 'gap');
  await archive.commit({records, exchanges: transport.exchanges, issues});
  const businessRecords = records.filter(record => record.type !== 'source-receipt');
  return {
    records: businessRecords,
    complete: !hasGap,
    issues,
    evidenceCount: transport.exchanges.length
  };
}

export async function collect({baseUrl, archive, mode = 'legacy'}) {
  const transport = createTransport(baseUrl);
  if (mode === 'source') return collectSource({baseUrl, archive, transport});
  if (mode !== 'legacy') throw new Error(`不支持的来源模式：${mode}`);
  const response = await transport.request('/legacy');
  if (!response.ok) throw new Error(`摘要领取失败：${response.status}`);
  const records = [normalizeLegacy(response.json())];
  await archive.commit({records, exchanges: transport.exchanges});
  return {records, complete: true, issues: [], evidenceCount: transport.exchanges.length};
}
