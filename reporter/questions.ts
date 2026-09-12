// Ask-a-Builder: tell the builder they have questions waiting.
//
// This is a COURTESY LINE, not a feature of reporting. Answering happens on the
// web; all the reporter does is make sure a builder who never visits their
// profile still finds out someone asked them something. So every failure mode
// here — server down, wrong shape, no network — is swallowed and prints
// nothing. A usage report must never go red because a nicety could not load.

export interface PendingLineInput {
  pending: number;
  username: string;
  serverUrl: string;
}

// Returns null when there is nothing to say. Silence at zero is the point: this
// prints every two hours, forever, on machines whose owner may never be asked
// a question at all.
export function pendingLine({ pending, username, serverUrl }: PendingLineInput): string | null {
  if (!Number.isFinite(pending) || pending < 1) return null;
  const noun = pending === 1 ? "question" : "questions";
  const base = serverUrl.replace(/\/+$/, "");
  return `  You have ${pending} unanswered ${noun} — answer at ${base}/ask/${encodeURIComponent(username)}`;
}

type FetchLike = (url: string) => Promise<{ ok: boolean; json: () => Promise<any> }>;

// null means "we could not find out", which callers render as silence. It is
// deliberately NOT 0: the two are the same on screen but conflating them in the
// type is how a "0 questions" claim gets made from a failed request.
export async function fetchPendingCount(
  serverUrl: string,
  username: string,
  fetchImpl?: FetchLike,
): Promise<number | null> {
  const f = fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  if (!f || !username) return null;
  const base = serverUrl.replace(/\/+$/, "");
  try {
    const res = await f(`${base}/api/user/${encodeURIComponent(username)}/questions`);
    if (!res.ok) return null;
    const body = await res.json();
    const n = Number(body?.pending);
    return Number.isFinite(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}
