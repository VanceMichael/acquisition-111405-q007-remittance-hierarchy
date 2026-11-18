import {parseDecimal, sumDecimals, decimalEquals, negateDecimal} from './decimal.mjs';

// 本地来源声明的币种 scale；未声明的币种不得解释成有效业务事实。
export const CURRENCY_SCALES = new Map([['CNY', 2], ['JPY', 0]]);

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonEmpty = value => typeof value === 'string' && value.length > 0;
const envelopeKey = (sender, control) => JSON.stringify([sender, control]);

// 解释 /advice 清单：只接受声明的信封结构，坏条目记为缺口而不是静默跳过。
export function parseAdvice(body) {
  const issues = [];
  if (!isObject(body) || !Array.isArray(body.envelopes)) {
    issues.push({code: 'advice-invalid', path: '/advice', message: '回执清单不是声明的 envelopes 结构'});
    return {entries: [], issues};
  }
  const entries = [];
  body.envelopes.forEach((envelope, index) => {
    if (!isObject(envelope) || !nonEmpty(envelope.sender) || !nonEmpty(envelope.control) || !nonEmpty(envelope.href)) {
      issues.push({code: 'envelope-invalid', path: '/advice', index, message: '信封缺少 sender/control/href，无法领取'});
      return;
    }
    entries.push({sender: envelope.sender, control: envelope.control, href: envelope.href});
  });
  return {entries, issues};
}

// 解释单个信封正文：保留付款、申报、服务行三层的金额原文与调整归属，
// 各层独立对平（正数调整表示扣减），对不上只标记状态，不改写来源金额。
export function interpretEnvelope(entry, body) {
  const issues = [];
  const locate = extra => ({href: entry.href, sender: entry.sender, control: entry.control, ...extra});
  if (!isObject(body)) {
    return {payment: null, issues: [{code: 'envelope-body-invalid', ...locate({}), message: '回执正文不是对象'}]};
  }
  if (!nonEmpty(body.paymentId)) {
    return {payment: null, issues: [{code: 'payment-id-invalid', ...locate({}), message: '回执缺少付款身份 paymentId，无法建立业务标识'}]};
  }
  const payment = {
    sender: entry.sender,
    control: entry.control,
    href: entry.href,
    paymentId: body.paymentId,
    balanceStatus: 'unknown',
    claims: []
  };
  const currencyKnown = typeof body.currency === 'string' && CURRENCY_SCALES.has(body.currency);
  if (typeof body.currency === 'string') payment.currency = body.currency;
  if (!currencyKnown) {
    issues.push({code: 'currency-unknown', ...locate({field: 'currency'}), value: body.currency ?? null,
      message: '币种不在本地声明的 scale 范围，金额仅保留原文，各层对平状态记为未知'});
  }
  const readAmount = (value, field, scope) => {
    const parsed = typeof value === 'string' ? parseDecimal(value) : null;
    if (parsed === null) {
      issues.push({code: 'amount-invalid', ...locate({field, ...scope}), value: typeof value === 'string' ? value : null,
        message: '金额不是可解释的十进制字符串，该层对平状态记为未知'});
    }
    return parsed;
  };
  const readAdjustments = (value, field, scope) => {
    if (!Array.isArray(value)) {
      issues.push({code: 'adjustments-invalid', ...locate({field, ...scope}), message: '调整集合不是数组，该层对平状态记为未知'});
      return null;
    }
    const parsed = [];
    let complete = true;
    value.forEach((adjustment, index) => {
      if (!isObject(adjustment)) {
        issues.push({code: 'adjustment-invalid', ...locate({field: `${field}[${index}]`, ...scope}), message: '调整条目不是对象'});
        complete = false;
        return;
      }
      const amount = readAmount(adjustment.amount, `${field}[${index}].amount`, scope);
      if (amount === null) complete = false;
      else parsed.push(amount);
    });
    return complete ? parsed : null;
  };

  if (typeof body.paid === 'string') payment.paid = body.paid;
  const paidParsed = readAmount(body.paid, 'paid', {});
  const providerAdjustments = readAdjustments(body.providerAdjustments, 'providerAdjustments', {});
  if (Array.isArray(body.providerAdjustments)) payment.providerAdjustments = structuredClone(body.providerAdjustments);

  let claimsComplete = true;
  const claimPaids = [];
  if (!Array.isArray(body.claims)) {
    issues.push({code: 'claims-invalid', ...locate({field: 'claims'}), message: '申报集合不是数组，付款级对平状态记为未知'});
    payment.claims = undefined;
    claimsComplete = false;
  } else {
    body.claims.forEach((rawClaim, index) => {
      if (!isObject(rawClaim) || !nonEmpty(rawClaim.claimId)) {
        issues.push({code: 'claim-invalid', ...locate({field: `claims[${index}]`}), message: '申报缺少身份 claimId，付款级对平状态记为未知'});
        claimsComplete = false;
        return;
      }
      const scope = {claimId: rawClaim.claimId};
      const claim = {claimId: rawClaim.claimId, balanceStatus: 'unknown', lines: []};
      if (typeof rawClaim.submitted === 'string') claim.submitted = rawClaim.submitted;
      if (typeof rawClaim.paid === 'string') claim.paid = rawClaim.paid;
      const submittedParsed = readAmount(rawClaim.submitted, 'submitted', scope);
      const claimPaidParsed = readAmount(rawClaim.paid, 'paid', scope);
      claimPaids.push(claimPaidParsed);
      const claimAdjustments = readAdjustments(rawClaim.adjustments, 'adjustments', scope);
      if (Array.isArray(rawClaim.adjustments)) claim.adjustments = structuredClone(rawClaim.adjustments);
      if (currencyKnown && submittedParsed && claimPaidParsed && claimAdjustments) {
        const expected = sumDecimals([submittedParsed, ...claimAdjustments.map(negateDecimal)]);
        claim.balanceStatus = decimalEquals(expected, claimPaidParsed) ? 'balanced' : 'unbalanced';
      }
      if (!Array.isArray(rawClaim.lines)) {
        issues.push({code: 'lines-invalid', ...locate({field: 'lines', ...scope}), message: '服务行集合不是数组'});
        claim.lines = undefined;
      } else {
        rawClaim.lines.forEach((rawLine, lineIndex) => {
          if (!isObject(rawLine) || !nonEmpty(rawLine.lineId)) {
            issues.push({code: 'line-invalid', ...locate({field: `lines[${lineIndex}]`, ...scope}), message: '服务行缺少身份 lineId'});
            return;
          }
          const lineScope = {...scope, lineId: rawLine.lineId};
          const line = {lineId: rawLine.lineId, balanceStatus: 'unknown'};
          if (typeof rawLine.charge === 'string') line.charge = rawLine.charge;
          if (typeof rawLine.paid === 'string') line.paid = rawLine.paid;
          const chargeParsed = readAmount(rawLine.charge, 'charge', lineScope);
          const linePaidParsed = readAmount(rawLine.paid, 'paid', lineScope);
          const lineAdjustments = readAdjustments(rawLine.adjustments, 'adjustments', lineScope);
          if (Array.isArray(rawLine.adjustments)) line.adjustments = structuredClone(rawLine.adjustments);
          if (currencyKnown && chargeParsed && linePaidParsed && lineAdjustments) {
            const expected = sumDecimals([chargeParsed, ...lineAdjustments.map(negateDecimal)]);
            line.balanceStatus = decimalEquals(expected, linePaidParsed) ? 'balanced' : 'unbalanced';
          }
          claim.lines.push(line);
        });
      }
      payment.claims.push(claim);
    });
  }
  if (body.replaces !== undefined) {
    if (isObject(body.replaces) && nonEmpty(body.replaces.sender) && nonEmpty(body.replaces.control)) {
      payment.replaces = {sender: body.replaces.sender, control: body.replaces.control};
    } else {
      issues.push({code: 'replaces-invalid', ...locate({field: 'replaces'}), message: '替换指向不是声明的 {sender, control} 结构'});
    }
  }
  // 付款级对平：整批实付 = 各申报实付之和 − 付款级调整；批次费用留在本层，不下摊。
  if (currencyKnown && paidParsed && providerAdjustments && claimsComplete && claimPaids.every(parsed => parsed !== null)) {
    const expected = sumDecimals([...claimPaids, ...providerAdjustments.map(negateDecimal)]);
    payment.balanceStatus = decimalEquals(expected, paidParsed) ? 'balanced' : 'unbalanced';
  }
  return {payment, issues};
}

// 替换链按 sender/control 追踪，与领取顺序无关。
// 被替换、成环、冲突、身份重复的信封都保持未决，不进当前有效视图；缺失目标只记缺口。
export function resolveValidity(entries) {
  const issues = [];
  const keys = new Set(entries.map(entry => envelopeKey(entry.sender, entry.control)));
  const duplicated = new Set();
  {
    const seen = new Set();
    for (const entry of entries) {
      const key = envelopeKey(entry.sender, entry.control);
      if (seen.has(key)) duplicated.add(key);
      seen.add(key);
    }
  }
  const edges = new Map();
  const incoming = new Map();
  for (const entry of entries) {
    const replaces = entry.payment?.replaces;
    if (!replaces) continue;
    const source = envelopeKey(entry.sender, entry.control);
    const target = envelopeKey(replaces.sender, replaces.control);
    edges.set(source, target);
    const list = incoming.get(target) ?? [];
    list.push(source);
    incoming.set(target, list);
  }
  const excluded = new Set();
  for (const [target, sources] of incoming) {
    const unique = [...new Set(sources)];
    if (unique.length < 2) continue;
    for (const source of unique) excluded.add(source);
    issues.push({code: 'replacement-conflict', target: JSON.parse(target), replacers: unique.map(key => JSON.parse(key)),
      message: '多份回执声明替换同一目标，相关回执有效性未决'});
  }
  {
    const state = new Map();
    for (const start of edges.keys()) {
      if (state.has(start)) continue;
      const path = [];
      let current = start;
      while (current !== undefined && !state.has(current)) {
        state.set(current, 'visiting');
        path.push(current);
        current = edges.get(current);
      }
      if (current !== undefined && state.get(current) === 'visiting') {
        const members = path.slice(path.indexOf(current));
        issues.push({code: 'replacement-cycle', members: members.map(key => JSON.parse(key)),
          message: '替换关系成环，相关回执有效性未决'});
      }
      for (const key of path) state.set(key, 'done');
    }
  }
  for (const [source, target] of edges) {
    if (!keys.has(target)) {
      issues.push({code: 'replacement-target-missing', replacer: JSON.parse(source), target: JSON.parse(target),
        message: '替换目标不在本次领取范围，替换关系未决'});
    }
  }
  for (const target of incoming.keys()) excluded.add(target);
  for (const key of duplicated) {
    excluded.add(key);
    issues.push({code: 'envelope-duplicate', envelope: JSON.parse(key), message: '同一 sender/control 出现多份信封，有效性未决'});
  }
  const valid = entries.filter(entry => entry.payment != null && !excluded.has(envelopeKey(entry.sender, entry.control)));
  return {valid, issues};
}

// 由当前有效回执生成业务记录：付款、申报、服务行三层，金额保留来源原文。
// 申报身份是 sender/claimId；控制号只作信封追溯，不代替申报身份。
export function recordsFromPayment(payment) {
  const paymentKey = `${payment.sender}/${payment.paymentId}`;
  const origin = {
    paymentKey,
    sender: payment.sender,
    paymentId: payment.paymentId,
    control: payment.control,
    href: payment.href
  };
  const paymentIdPart = `${encodeURIComponent(payment.sender)}/${encodeURIComponent(payment.paymentId)}`;
  const records = [];
  const paymentRecord = {id: `payment:${paymentIdPart}`, level: 'payment', ...origin};
  if (payment.currency !== undefined) paymentRecord.currency = payment.currency;
  if (payment.paid !== undefined) paymentRecord.paid = payment.paid;
  if (payment.providerAdjustments !== undefined) paymentRecord.providerAdjustments = structuredClone(payment.providerAdjustments);
  if (payment.replaces !== undefined) paymentRecord.replaces = {...payment.replaces};
  paymentRecord.balanceStatus = payment.balanceStatus;
  records.push(paymentRecord);
  for (const claim of payment.claims ?? []) {
    const claimKey = `${payment.sender}/${claim.claimId}`;
    const claimRecord = {
      id: `claim:${paymentIdPart}/${encodeURIComponent(claim.claimId)}`,
      level: 'claim',
      ...origin,
      claimKey,
      claimId: claim.claimId
    };
    if (payment.currency !== undefined) claimRecord.currency = payment.currency;
    if (claim.submitted !== undefined) claimRecord.submitted = claim.submitted;
    if (claim.paid !== undefined) claimRecord.paid = claim.paid;
    if (claim.adjustments !== undefined) claimRecord.adjustments = structuredClone(claim.adjustments);
    claimRecord.balanceStatus = claim.balanceStatus;
    records.push(claimRecord);
    for (const line of claim.lines ?? []) {
      const lineRecord = {
        id: `line:${paymentIdPart}/${encodeURIComponent(claim.claimId)}/${encodeURIComponent(line.lineId)}`,
        level: 'line',
        ...origin,
        claimKey,
        claimId: claim.claimId,
        lineId: line.lineId
      };
      if (payment.currency !== undefined) lineRecord.currency = payment.currency;
      if (line.charge !== undefined) lineRecord.charge = line.charge;
      if (line.paid !== undefined) lineRecord.paid = line.paid;
      if (line.adjustments !== undefined) lineRecord.adjustments = structuredClone(line.adjustments);
      lineRecord.balanceStatus = line.balanceStatus;
      records.push(lineRecord);
    }
  }
  return records;
}
