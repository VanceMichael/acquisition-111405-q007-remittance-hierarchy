// 金额一律按币种 scale 解释为整数最小单位，原文十进制字符串原样保留。
// 只支持来源契约声明的本地币种；未声明的币种由业务层判定为未决。
export const SCALES = {CNY: 2, JPY: 0};

/**
 * 按 scale 解释十进制字符串。
 * 不接受数字类型、千分位、科学计数法、前导加号或空白；小数位超过 scale 视为来源精度冲突。
 * @returns {{ok: true, minor: number} | {ok: false, reason: string}}
 */
export function parseDecimal(text, scale) {
  if (typeof text !== 'string') return {ok: false, reason: 'NOT_STRING'};
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) return {ok: false, reason: 'MALFORMED'};
  const fraction = match[3] ?? '';
  if (fraction.length > scale) return {ok: false, reason: 'SCALE_EXCEEDED'};
  const base = 10n ** BigInt(scale);
  const whole = BigInt(match[2]);
  const fractional = BigInt((fraction || '').padEnd(scale, '0') || '0'.repeat(scale));
  let minor = whole * base + fractional;
  if (match[1] === '-') minor = -minor;
  const limit = BigInt(Number.MAX_SAFE_INTEGER);
  if (minor > limit || minor < -limit) return {ok: false, reason: 'OUT_OF_RANGE'};
  return {ok: true, minor: Number(minor)};
}

/** 最小单位整数还原为定长小数字符串，供差异定位展示，不替代来源原文。 */
export function formatMinor(minor, scale) {
  const negative = minor < 0;
  const absolute = String(Math.abs(minor));
  let body;
  if (scale === 0) {
    body = absolute;
  } else {
    const padded = absolute.padStart(scale + 1, '0');
    body = `${padded.slice(0, -scale)}.${padded.slice(-scale)}`;
  }
  return negative ? `-${body}` : body;
}

export function sumMinor(values) {
  return values.reduce((total, value) => total + value, 0);
}
