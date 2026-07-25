/** Normalize a backend base URL before persistence or env injection. */
export function normalizeBackendBaseUrl(url: string | undefined): string | undefined {
  const trimmed = url?.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/\/+$/, '');
}
