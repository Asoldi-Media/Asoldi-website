import { createHash, timingSafeEqual } from 'crypto';

export function hashLocalBlogToken(token = '') {
  const value = String(token || '').trim();
  if (!value) return '';
  return createHash('sha256').update(value).digest('hex');
}

export function localBlogTokensMatch(storedHash = '', token = '') {
  const next = hashLocalBlogToken(token);
  const prev = String(storedHash || '').trim();
  if (!next || !prev || prev.length !== next.length) return false;
  return timingSafeEqual(Buffer.from(prev), Buffer.from(next));
}
