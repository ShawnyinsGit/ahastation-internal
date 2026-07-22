// update-check.ts — pragmatic in-app version check (Phase 6b §3.5-5).
//
// Private-repo reality (measured 2026-07-21): this repo answers anonymous
// requests with 404 (repo root) / auth-required (API) — electron-updater's
// feed and even the releases HTML page are unreachable without a token the
// client must never hold. So instead of an updater feed we probe
//   https://github.com/ShawnyinsGit/AhaStation/releases/latest
// with redirects OFF and parse the tag from the Location header. While the
// repo is private (or offline, or no release exists) the probe simply
// no-ops; the day the repo goes public it starts working with NO client
// change. Result cached 24h in settings.json.

import { getSettings, updateSettings } from './store.js';

export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const RELEASES_LATEST_URL = 'https://github.com/ShawnyinsGit/AhaStation/releases/latest';
export const RELEASES_PAGE_URL = 'https://github.com/ShawnyinsGit/AhaStation/releases';

/** semver-ish comparison: returns >0 when a>b, <0 when a<b, 0 when equal.
 *  Accepts optional leading 'v'; compares numeric triples only (a missing
 *  component counts as 0). */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/i, '').split('.').map((x) => parseInt(x, 10) || 0);
  const pb = b.replace(/^v/i, '').split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Extract the version tag from a releases/latest redirect Location, e.g.
 *  '/ShawnyinsGit/AhaStation/releases/tag/v0.17.0' → 'v0.17.0'. */
export function parseLatestTag(location: string | null): string | null {
  if (!location) return null;
  const m = /\/releases\/tag\/([^/?#]+)/.exec(location);
  return m ? m[1] : null;
}

export interface UpdateCheckResult {
  available: boolean;
  latest?: string;
  url?: string;
}

type FetchLike = (url: string, init?: Record<string, unknown>) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
}>;

/** One probe. Private repo / offline / no release → { available: false }
 *  (silent by design). Injectable fetch for tests. */
export async function checkLatestRelease(
  currentVersion: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<UpdateCheckResult> {
  try {
    const res = await fetchImpl(RELEASES_LATEST_URL, { redirect: 'manual' });
    if (res.status !== 301 && res.status !== 302) {
      return { available: false };
    }
    const tag = parseLatestTag(res.headers.get('location'));
    if (!tag) return { available: false };
    return compareVersions(tag, currentVersion) > 0
      ? { available: true, latest: tag, url: RELEASES_PAGE_URL }
      : { available: false };
  } catch {
    return { available: false };
  }
}

/** Cached wrapper: at most one network probe per 24h (settings.json). */
export async function checkForUpdateCached(currentVersion: string): Promise<UpdateCheckResult> {
  const cached = getSettings().updateCheckCache;
  if (cached && Date.now() - cached.checkedAt < UPDATE_CHECK_INTERVAL_MS) {
    if (!cached.latest) return { available: false };
    return compareVersions(cached.latest, currentVersion) > 0
      ? { available: true, latest: cached.latest, url: RELEASES_PAGE_URL }
      : { available: false };
  }
  const result = await checkLatestRelease(currentVersion);
  try {
    await updateSettings({
      updateCheckCache: { checkedAt: Date.now(), latest: result.latest ?? null },
    });
  } catch {
    /* cache write failure must never break the check */
  }
  return result;
}
