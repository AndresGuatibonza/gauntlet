/** Shared by server and browser code: the URL is the source of truth for which scan is shown. */
const JOB_PATH = /^\/scans\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i;

/** "/scans/<uuid>" -> "<uuid>"; anything else -> null. */
export function jobIdFromPath(pathname: string | null): string | null {
  return pathname?.match(JOB_PATH)?.[1] ?? null;
}
