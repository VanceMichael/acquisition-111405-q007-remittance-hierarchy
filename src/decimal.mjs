// 十进制原文的精确解释：仅用于对平计算，不改写来源字符串。
// 金额在记录中始终保留来源原文，这里把原文解析为 系数×10^-指数 参与求和与比较。

const DECIMAL_PATTERN = /^-?\d+(?:\.\d+)?$/;

export function parseDecimal(text) {
  if (typeof text !== 'string' || !DECIMAL_PATTERN.test(text)) return null;
  const negative = text.startsWith('-');
  const digits = negative ? text.slice(1) : text;
  const point = digits.indexOf('.');
  const integer = point === -1 ? digits : digits.slice(0, point);
  const fraction = point === -1 ? '' : digits.slice(point + 1);
  let coefficient = BigInt(integer + fraction);
  if (negative) coefficient = -coefficient;
  return {coefficient, exponent: fraction.length};
}

function align(value, exponent) {
  if (value.exponent === exponent) return value.coefficient;
  return value.coefficient * 10n ** BigInt(exponent - value.exponent);
}

export function negateDecimal(value) {
  return {coefficient: -value.coefficient, exponent: value.exponent};
}

export function sumDecimals(values) {
  let exponent = 0;
  for (const value of values) exponent = Math.max(exponent, value.exponent);
  let total = 0n;
  for (const value of values) total += align(value, exponent);
  return {coefficient: total, exponent};
}

export function decimalEquals(left, right) {
  const exponent = Math.max(left.exponent, right.exponent);
  return align(left, exponent) === align(right, exponent);
}
