import {createTransport} from './transport.mjs';
import {parseAdvice, interpretEnvelope, resolveValidity, recordsFromPayment} from './remittance.mjs';

// 新来源采集：清单 → 信封正文 → 层次解释 → 替换链有效性 → 当前有效业务视图。
// 任何领取或解释缺口都记入 issues 并使 complete=false；已收的安全独立部分仍然保留。
export async function collectSource({baseUrl, archive}) {
  const transport = createTransport(baseUrl);
  const issues = [];
  let entries = [];
  try {
    const response = await transport.request('/advice');
    if (!response.ok) {
      issues.push({code: 'advice-unavailable', path: '/advice', status: response.status, message: `回执清单领取失败：${response.status}`});
    } else {
      try {
        const parsed = parseAdvice(response.json());
        entries = parsed.entries;
        issues.push(...parsed.issues);
      } catch (error) {
        issues.push({code: 'advice-invalid', path: '/advice', message: `回执清单无法解释：${error.message}`});
      }
    }
  } catch (error) {
    issues.push({code: 'advice-unavailable', path: '/advice', message: `回执清单领取异常：${error.message}`});
  }
  for (const entry of entries) {
    entry.payment = null;
    let body = null;
    try {
      const response = await transport.request(entry.href);
      if (!response.ok) {
        issues.push({code: 'envelope-fetch-failed', href: entry.href, sender: entry.sender, control: entry.control,
          status: response.status, message: `信封正文领取失败：${response.status}`});
      } else {
        try {
          body = response.json();
        } catch (error) {
          issues.push({code: 'envelope-body-invalid', href: entry.href, sender: entry.sender, control: entry.control,
            message: `信封正文不是可解释的JSON：${error.message}`});
        }
      }
    } catch (error) {
      issues.push({code: 'envelope-fetch-failed', href: entry.href, sender: entry.sender, control: entry.control,
        message: `信封正文领取异常：${error.message}`});
    }
    if (body !== null) {
      const interpreted = interpretEnvelope(entry, body);
      entry.payment = interpreted.payment;
      issues.push(...interpreted.issues);
    }
  }
  const validity = resolveValidity(entries);
  issues.push(...validity.issues);
  const records = [];
  const paymentsByKey = new Map();
  for (const entry of validity.valid) {
    records.push(...recordsFromPayment(entry.payment));
    const paymentKey = `${entry.payment.sender}/${entry.payment.paymentId}`;
    const controls = paymentsByKey.get(paymentKey) ?? [];
    controls.push(entry.control);
    paymentsByKey.set(paymentKey, controls);
  }
  for (const [paymentKey, controls] of paymentsByKey) {
    if (controls.length > 1) {
      issues.push({code: 'payment-duplicate', paymentKey, controls, message: '同一付款存在多份有效回执，需人工复核'});
    }
  }
  const complete = issues.length === 0;
  await archive.commit({records, exchanges: transport.exchanges, issues});
  return {records, complete, issues, evidenceCount: transport.exchanges.length};
}
