/** Short affirmations mean Accept — never open another rework loop. */
export function isAffirmativeDeliveryFeedback(text: string): boolean {
  const normalized = text.trim().toLowerCase().replace(/[.!！。]+$/u, '');
  if (!normalized) return false;
  return [
    '可以了',
    '可以',
    '行',
    '好',
    '好的',
    '没问题',
    '通过',
    '验收',
    '接受',
    'ok',
    'okay',
    'lgtm',
    'ship it',
    'looks good',
    'approved',
    'accept',
  ].includes(normalized);
}
