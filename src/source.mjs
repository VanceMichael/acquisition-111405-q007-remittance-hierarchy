import {parseDecimal, formatMinor, sumMinor, SCALES} from './money.mjs';

function issue(code, severity, message, loc, extra = {}) {
  return {code, severity, message, loc, ...extra};
}

function parseAmount(text, scale, loc, issues, code = 'AMOUNT_INVALID') {
  const parsed = parseDecimal(text, scale);
  if (parsed.ok) return parsed.minor;
  issues.push(issue(code, 'gap', `金额无法按币种精度解释（${parsed.reason}）`, loc, {value: text, reason: parsed.reason}));
  return null;
}

function normalizeAdjustments(list, scale, loc, issues) {
  if (!Array.isArray(list)) {
    issues.push(issue('ADJUSTMENTS_INVALID', 'gap', '调整列表不是数组', loc));
    return [];
  }
  return list.map((item, index) => {
    const itemLoc = `${loc}/${index}`;
    const amount = parseAmount(item && item.amount, scale, `${itemLoc}/amount`, issues, 'ADJUSTMENT_AMOUNT_INVALID');
    return {
      group: item && typeof item.group === 'string' ? item.group : null,
      reason: item && typeof item.reason === 'string' ? item.reason : null,
      amount: item && item.amount !== undefined ? item.amount : null,
      minorUnits: amount
    };
  });
}

function statusFor(residuals) {
  if (residuals.some(item => item === null)) return 'pending';
  if (residuals.some(item => item !== 0)) return 'unbalanced';
  return 'balanced';
}

function residualObject(minor, scale) {
  return minor === null
    ? {text: null, minorUnits: null}
    : {text: formatMinor(minor, scale), minorUnits: minor};
}

/**
 * 解释单份回执正文，保留付款/申报/服务行三个层次与各自调整。
 * 不做任何平均摊分；对不上的金额保留原文并在 balances 中定位差异。
 * @returns {{identity, replaces, rows: Array, receiptRecord: object, issues: Array}}
 */
export function interpretReceipt({sender, control, body, adviceHash, envelopeHash, href}) {
  const issues = [];
  const loc = `/advice/envelope[${JSON.stringify({sender, control})}]`;
  const identity = {sender, control};

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    issues.push(issue('ENVELOPE_INVALID', 'gap', '回执正文不是对象', loc, {href}));
    return {identity, replaces: null, rows: [], receiptRecord: null, issues, interpretable: false};
  }

  let replaces = null;
  if ('replaces' in body) {
    const target = body.replaces;
    if (!target || typeof target !== 'object' || typeof target.sender !== 'string' || !target.sender
      || typeof target.control !== 'string' || !target.control) {
      issues.push(issue('REPLACES_INVALID', 'gap', 'replaces 必须是 {sender, control}', `${loc}/replaces`));
    } else {
      replaces = {sender: target.sender, control: target.control};
    }
  }

  const paymentId = typeof body.paymentId === 'string' && body.paymentId ? body.paymentId : null;
  if (!paymentId) issues.push(issue('PAYMENT_ID_MISSING', 'gap', '回执缺少 paymentId', loc));

  const currency = body.currency;
  const scaleKnown = typeof currency === 'string' && Object.hasOwn(SCALES, currency);
  if (!scaleKnown) {
    issues.push(issue('CURRENCY_UNSUPPORTED', 'gap', `未声明的币种，无法解释金额精度：${String(currency)}`, `${loc}/currency`, {value: currency ?? null}));
  }
  const scale = scaleKnown ? SCALES[currency] : null;

  const receiptRecord = {
    id: `receipt:${sender}/${control}`,
    type: 'source-receipt',
    sender,
    control,
    paymentId,
    currency: currency ?? null,
    replaces,
    adviceHash,
    envelopeHash,
    href
  };

  // 币种未声明时不解释任何金额，只保留原文证据与身份，等待后续回执或人工复核。
  if (!scaleKnown) {
    receiptRecord.balanceStatus = 'pending';
    return {identity, replaces, rows: [], receiptRecord, issues, interpretable: false};
  }

  const paidText = body.paid;
  const paidMinor = parseAmount(paidText, scale, `${loc}/paid`, issues, 'PAYMENT_AMOUNT_INVALID');

  const providerAdjustments = normalizeAdjustments(body.providerAdjustments, scale, `${loc}/providerAdjustments`, issues);
  const providerMinor = sumMinor(providerAdjustments.map(item => item.minorUnits ?? 0));

  const claimsInput = Array.isArray(body.claims) ? body.claims : [];
  if (!Array.isArray(body.claims)) {
    issues.push(issue('CLAIMS_INVALID', 'gap', 'claims 不是数组', `${loc}/claims`));
  }

  const rows = [];
  const claimSummaries = [];

  claimsInput.forEach((claim, claimIndex) => {
    const claimLoc = `${loc}/claims/${claimIndex}`;
    const claimId = claim && typeof claim.claimId === 'string' && claim.claimId ? claim.claimId : null;
    if (!claimId) issues.push(issue('CLAIM_ID_MISSING', 'gap', '申报缺少 claimId', claimLoc));

    const claimKey = claimId ? `${sender}/${claimId}` : `${sender}/#claim-${claimIndex}`;
    const paymentKey = paymentId ? `${sender}/${paymentId}` : `${sender}/#payment-${control}`;

    const submittedMinor = parseAmount(claim && claim.submitted, scale, `${claimLoc}/submitted`, issues, 'CLAIM_SUBMITTED_INVALID');
    const claimPaidMinor = parseAmount(claim && claim.paid, scale, `${claimLoc}/paid`, issues, 'CLAIM_PAID_INVALID');
    const claimAdjustments = normalizeAdjustments(claim && claim.adjustments, scale, `${claimLoc}/adjustments`, issues);
    const claimAdjustMinor = sumMinor(claimAdjustments.map(item => item.minorUnits ?? 0));

    // 申报自身平衡：submitted - 申报调整 = paid（调整正数表示扣减）
    const claimResidual = (submittedMinor === null || claimPaidMinor === null)
      ? null
      : submittedMinor - claimAdjustMinor - claimPaidMinor;

    const linesInput = Array.isArray(claim && claim.lines) ? claim.lines : [];
    if (claim && !Array.isArray(claim.lines)) {
      issues.push(issue('LINES_INVALID', 'gap', '服务行列表不是数组', `${claimLoc}/lines`));
    }

    const seenLineIds = new Set();
    const linePaidMinors = [];
    const lineSummaries = [];

    linesInput.forEach((line, lineIndex) => {
      const lineLoc = `${claimLoc}/lines/${lineIndex}`;
      let lineId = line && typeof line.lineId === 'string' && line.lineId ? line.lineId : null;
      if (!lineId) {
        lineId = `#line-${lineIndex}`;
        issues.push(issue('LINE_ID_MISSING', 'gap', '服务行缺少 lineId', lineLoc));
      } else if (seenLineIds.has(lineId)) {
        issues.push(issue('LINE_ID_DUPLICATE', 'gap', '同一申报内 lineId 重复，按序号区分归档身份', lineLoc, {lineId}));
        lineId = `${lineId}#dup-${lineIndex}`;
      }
      seenLineIds.add(lineId);

      const chargeMinor = parseAmount(line && line.charge, scale, `${lineLoc}/charge`, issues, 'LINE_CHARGE_INVALID');
      const linePaidMinor = parseAmount(line && line.paid, scale, `${lineLoc}/paid`, issues, 'LINE_PAID_INVALID');
      const lineAdjustments = normalizeAdjustments(line && line.adjustments, scale, `${lineLoc}/adjustments`, issues);
      const lineAdjustMinor = sumMinor(lineAdjustments.map(item => item.minorUnits ?? 0));

      // 服务行差异：charge - 行调整 - paid，差异留在行上，不向来源补差。
      const lineResidual = (chargeMinor === null || linePaidMinor === null)
        ? null
        : chargeMinor - lineAdjustMinor - linePaidMinor;
      linePaidMinors.push(linePaidMinor);
      lineSummaries.push({lineId, charge: (line && line.charge) ?? null, paid: (line && line.paid) ?? null});

      const balances = {
        line: {
          status: statusFor([lineResidual]),          charge: {text: (line && line.charge) ?? null, minorUnits: chargeMinor},
          paid: {text: (line && line.paid) ?? null, minorUnits: linePaidMinor},
          adjustmentsTotal: {text: formatMinor(lineAdjustMinor, scale), minorUnits: lineAdjustMinor},
          residual: residualObject(lineResidual, scale)
        },
        claim: {
          status: statusFor([claimResidual]),
          submitted: {text: (claim && claim.submitted) ?? null, minorUnits: submittedMinor},
          paid: {text: (claim && claim.paid) ?? null, minorUnits: claimPaidMinor},
          adjustmentsTotal: {text: formatMinor(claimAdjustMinor, scale), minorUnits: claimAdjustMinor},
          residual: residualObject(claimResidual, scale)
        }
      };
      const rowStatus = statusFor([lineResidual, claimResidual]);

      rows.push({
        id: `line:${sender}/${control}/${claimId ?? '#claim-' + claimIndex}/${lineId}`,
        type: 'service-line',
        paymentKey,
        claimKey,
        lineId,
        paymentId,
        claimId,
        sender,
        control,
        currency,
        scale,
        // 顶层金额保留来源原文十进制字符串；minorUnits 只用于复核计算。
        charge: (line && line.charge) ?? null,
        paid: (line && line.paid) ?? null,
        minorUnits: {charge: chargeMinor, paid: linePaidMinor},
        lineAdjustments,
        claimAdjustments,
        providerAdjustments,
        balances,
        balanceStatus: rowStatus,
        replaces,
        evidence: {adviceHash, envelopeHash, href}
      });
    });

    // 申报覆盖检查：有服务行时，各行 paid 合计应等于申报 paid。
    let coverageResidual = null;
    if (linesInput.length > 0 && claimPaidMinor !== null) {
      if (linePaidMinors.includes(null)) coverageResidual = null;
      else coverageResidual = sumMinor(linePaidMinors) - claimPaidMinor;
    }

    claimSummaries.push({
      claimId,
      claimKey,
      submitted: (claim && claim.submitted) ?? null,
      paid: (claim && claim.paid) ?? null,
      minorUnits: {submitted: submittedMinor, paid: claimPaidMinor},
      adjustments: claimAdjustments,
      adjustmentsTotal: {text: formatMinor(claimAdjustMinor, scale), minorUnits: claimAdjustMinor},
      residual: residualObject(claimResidual, scale),
      coverageResidual: residualObject(coverageResidual, scale),
      status: statusFor([claimResidual, coverageResidual]),
      lineCount: linesInput.length,
      lines: lineSummaries
    });

    // 无服务行的申报不在此处单独出行：整份回执没有任何服务行时，
    // 由付款级记录统一承载 balanceStatus，并在 claims 中保留各申报层次。
  });

  // 付款层平衡：各申报 paid 合计 - 整批调整 = 实际到账。
  // providerAdjustments 作用于整笔 payment，只保留在付款层，绝不向下摊。
  const claimPaidValues = claimSummaries.map(item => item.minorUnits.paid);
  const paymentResidual = (paidMinor === null || claimPaidValues.includes(null) || claimsInput.length === 0)
    ? null
    : sumMinor(claimPaidValues) - providerMinor - paidMinor;

  const paymentBalances = {
    status: statusFor([paymentResidual]),
    paid: {text: paidText ?? null, minorUnits: paidMinor},
    claimsPaidTotal: {
      text: claimPaidValues.includes(null) ? null : formatMinor(sumMinor(claimPaidValues), scale),
      minorUnits: claimPaidValues.includes(null) ? null : sumMinor(claimPaidValues)
    },
    providerAdjustmentsTotal: {text: formatMinor(providerMinor, scale), minorUnits: providerMinor},
    residual: residualObject(paymentResidual, scale)
  };

  // 无服务行的付款（整个回执都没有可落到行的记录）：输出付款级 balanceStatus 记录，
  // 申报层次保留在 claims 中，不被付款合计吞掉。
  const paymentRecordStatus = statusFor([
    paymentResidual,
    ...claimSummaries.map(item => item.residual.minorUnits)
  ]);
  if (!rows.length) {
    rows.push({
      id: `payment:${sender}/${control}`,
      type: 'payment',
      paymentKey: paymentId ? `${sender}/${paymentId}` : `${sender}/#payment-${control}`,
      paymentId,
      sender,
      control,
      currency,
      scale,
      paid: paidText ?? null,
      minorUnits: {paid: paidMinor},
      providerAdjustments,
      claims: claimSummaries,
      claimCount: claimsInput.length,
      balances: {line: null, claim: claimSummaries, payment: paymentBalances},
      balanceStatus: paymentRecordStatus,
      replaces,
      evidence: {adviceHash, envelopeHash, href}
    });
  } else {
    // 行/申报记录补充付款层平衡视图，使每笔差额可定位到三个层次。
    for (const row of rows) {
      row.paymentBalances = paymentBalances;
      row.balances.payment = paymentBalances;
      row.claimCoverage = claimSummaries.map(item => ({
        claimKey: item.claimKey,
        lineCount: item.lineCount,
        coverageResidual: item.coverageResidual,
        status: item.status
      }));
      const layerStatuses = [
        row.balances.line?.status,
        row.balances.claim?.status,
        paymentBalances.status
      ].filter(Boolean);
      row.balanceStatus = layerStatuses.includes('pending')
        ? 'pending'
        : layerStatuses.includes('unbalanced') ? 'unbalanced' : 'balanced';
    }
  }

  for (const row of rows.filter(item => item.type === 'service-line')) {
    const residual = row.balances.line?.residual;
    if (residual && residual.minorUnits !== null && residual.minorUnits !== 0) {
      issues.push(issue('LINE_UNBALANCED', 'difference', '服务行金额对不平：charge - 行调整 ≠ paid（差额可能由上层调整解释，不代来源摊分）',
        `${loc}/claims/${row.claimId ?? ''}/lines/${row.lineId}`, {claimKey: row.claimKey, lineId: row.lineId, residual}));
    }
  }
  for (const summary of claimSummaries) {
    if (summary.residual.minorUnits !== null && summary.residual.minorUnits !== 0) {
      issues.push(issue('CLAIM_UNBALANCED', 'difference', '申报金额对不平：submitted - 调整 ≠ paid',
        `${loc}/claims/${summary.claimId ?? ''}`, {claimKey: summary.claimKey, residual: summary.residual}));
    }
    if (summary.coverageResidual.minorUnits !== null && summary.coverageResidual.minorUnits !== 0) {
      issues.push(issue('CLAIM_COVERAGE_UNBALANCED', 'difference', '服务行 paid 合计与申报 paid 不一致',
        `${loc}/claims/${summary.claimId ?? ''}`, {claimKey: summary.claimKey, residual: summary.coverageResidual}));
    }
  }
  if (paymentResidual !== null && paymentResidual !== 0) {
    issues.push(issue('PAYMENT_UNBALANCED', 'difference', '付款金额对不平：申报 paid 合计 - 整批调整 ≠ 到账',
      `${loc}`, {residual: residualObject(paymentResidual, scale)}));
  }

  return {identity, replaces, rows, receiptRecord, issues, interpretable: true};
}

/**
 * 按 sender/control 追踪替换链（不按领取顺序）。
 * 缺失目标或环形替换：整条链保持未决，链上任何回执都不能当作当前有效视图。
 * @returns {Map<string, {state: 'active'|'superseded'|'pending', replacesTarget: object|null, reason?: string}>}
 */
export function resolveReplacementStates(nodes) {
  const byKey = new Map(nodes.map(node => [`${node.sender}/${node.control}`, node]));
  const states = new Map();

  // 沿每个节点自身的 replaces 边行走：走到无 replaces 的终点即为可解析链；
  // 中途缺失目标或回到已访问节点（成环）则该链未决。
  const chains = new Map();
  for (const key of byKey.keys()) {
    const members = [];
    const onPath = new Set();
    let cursorKey = key;
    let reason = null;
    for (;;) {
      if (onPath.has(cursorKey)) {
        reason = `替换链成环：${[...onPath, cursorKey].join(' -> ')}`;
        break;
      }
      const cursor = byKey.get(cursorKey);
      if (!cursor) {
        reason = `替换目标缺失：${cursorKey}`;
        break;
      }
      onPath.add(cursorKey);
      members.push(cursorKey);
      if (!cursor.replaces) break;
      cursorKey = `${cursor.replaces.sender}/${cursor.replaces.control}`;
    }
    chains.set(key, {members, reason});
  }

  // 未决链上的所有回执保持 pending；可解析链中，被其他可解析回执指向的为 superseded，
  // 链头（携带 replaces 的最新回执，无人指向）才是当前有效视图。
  const pendingMembers = new Map();
  const targetedBy = new Map();
  for (const [key, chain] of chains) {
    if (chain.reason) {
      for (const member of chain.members) {
        if (!pendingMembers.has(member)) pendingMembers.set(member, chain.reason);
      }
    } else {
      for (const member of chain.members.slice(1)) {
        if (!targetedBy.has(member)) targetedBy.set(member, key);
      }
    }
  }

  for (const key of byKey.keys()) {
    if (pendingMembers.has(key)) {
      states.set(key, {state: 'pending', replacesTarget: byKey.get(key)?.replaces ?? null, reason: pendingMembers.get(key)});
    } else if (targetedBy.has(key)) {
      states.set(key, {state: 'superseded', replacesTarget: byKey.get(key)?.replaces ?? null});
    } else {
      states.set(key, {state: 'active', replacesTarget: byKey.get(key)?.replaces ?? null});
    }
  }
  return states;
}
