/**
 * 源白名单守卫：fail-closed。不在白名单 → 一个能力都不许启动。
 */

export const DEFAULT_ORIGIN_WHITELIST = ['https://chat.deepseek.com'];

export function normalizeOrigin(origin: string | undefined): string {
  if (!origin) return '';
  return origin.trim().toLowerCase();
}

export function isAllowedOrigin(
  locationOrigin: string | undefined,
  whitelist: readonly string[] = DEFAULT_ORIGIN_WHITELIST,
): boolean {
  const origin = normalizeOrigin(locationOrigin);
  if (!origin) return false;
  return whitelist.map(normalizeOrigin).includes(origin);
}
