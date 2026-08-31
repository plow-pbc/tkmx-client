// Badge lists (TOOLS / PROJECTS / COMMUNITIES) are ADDITIVE on the server:
// /api/usage unions what a machine posts into what is already stored, so a
// name that is new to the profile becomes a permanent chip that only `npm run
// untag` can take off again. Nothing in a report says a tag is new, which is
// how thirteen duplicates reached one profile — a stale .env on a machine
// nobody was watching listed both "WisprFlow" and the typo "WhsprFlow", and
// each additional cycle would have minted both again.
//
// This module answers one question before the POST: which of the tags this
// machine is about to send are not already on the profile, and does any of
// them look like a misspelling of one that is. It only ever reports; the
// report still goes out. Blocking a two-hourly cron on a spelling question
// would trade a visible extra chip for an invisible missed cycle.
import { TAG_FIELDS } from "./untag";

export interface NearDuplicate {
  configured: string;
  stored: string;
}

export interface TagDrift {
  field: string;
  newTags: string[];
  nearDuplicates: NearDuplicate[];
}

export function parseTagList(raw: string | undefined | null): string[] {
  return String(raw || "").split(",").map((t) => t.trim()).filter(Boolean);
}

// The server dedupes on a lowercased tag but not a whitespace-stripped one, so
// "WisprFlow" and "Wispr Flow" are genuinely two badges. Identity here has to
// match that exactly, or the check would call a real new tag a duplicate and
// stay quiet about it.
function identity(tag: string): string {
  return tag.toLowerCase();
}

// Similarity is deliberately looser than identity: it exists to catch the two
// ways a near-duplicate actually shows up — the same name spaced differently,
// and a typo of one or two characters.
function normalize(tag: string): string {
  return tag.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        prev[j] + 1,
        row[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = row;
  }
  return prev[b.length];
}

// Short names are excluded from the typo rule on purpose: at four characters a
// distance of two is most of the word, so "CC" and "Warp" would flag against
// half the list. Spacing-only matches are reported at any length, since those
// are exact matches once the spaces come out.
const MIN_TYPO_LENGTH = 5;
const MAX_TYPO_DISTANCE = 2;

function looksLike(configured: string, stored: string): boolean {
  const a = normalize(configured);
  const b = normalize(stored);
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length < MIN_TYPO_LENGTH || b.length < MIN_TYPO_LENGTH) return false;
  return editDistance(a, b) <= MAX_TYPO_DISTANCE;
}

export function diffTagField(field: string, configured: string[], stored: string[]): TagDrift {
  const storedIds = new Set(stored.map(identity));
  const newTags = configured.filter((tag) => !storedIds.has(identity(tag)));
  const nearDuplicates: NearDuplicate[] = [];
  for (const tag of newTags) {
    for (const existing of stored) {
      if (looksLike(tag, existing)) nearDuplicates.push({ configured: tag, stored: existing });
    }
  }
  return { field, newTags, nearDuplicates };
}

export function hasDrift(drift: TagDrift): boolean {
  return drift.newTags.length > 0;
}

// Printed to stderr by the caller: a chip this machine invented is exactly the
// kind of thing that must not disappear into routine stdout.
export function formatTagDrift(drifts: TagDrift[]): string[] {
  const lines: string[] = [];
  for (const drift of drifts.filter(hasDrift)) {
    lines.push(
      `  ${drift.field}: this report will ADD ${drift.newTags.length} new badge(s) to the shared profile:`,
    );
    for (const tag of drift.newTags) lines.push(`    + ${tag}`);
    for (const dup of drift.nearDuplicates) {
      lines.push(
        `    ! "${dup.configured}" looks like "${dup.stored}", which the profile already has —` +
        ` badges match on case but not spacing, so both will exist`,
      );
    }
    lines.push(
      `    Badges are additive and only \`npm run untag -- ${drift.field} "<exact text>"\` removes one.`,
    );
  }
  return lines;
}

export type ProfileFetcher = (url: URL) => Promise<string>;

// Reads the stored badge lists. The profile GET is served from a cache that a
// plain request cannot bypass — only a varying URL does, which is why the
// caller passes a nonce — so a stale read here would compare against a profile
// from before the last change and invent drift that is not there.
export function storedTagsFromProfile(body: string): Record<string, string[]> {
  const profile = JSON.parse(body) as Record<string, unknown>;
  const out: Record<string, string[]> = {};
  for (const field of TAG_FIELDS) out[field] = parseTagList(String(profile[field] ?? ""));
  return out;
}

export interface TagDriftCheck {
  drifts: TagDrift[];
  skipped?: string;
}

// Never throws: a profile the check could not read is a reason to say the
// check did not run, not a reason to lose the usage report that was the point
// of the cycle.
export async function checkTagDrift(
  configuredByField: Record<string, string | undefined>,
  fetchProfile: () => Promise<string>,
): Promise<TagDriftCheck> {
  const configured = Object.entries(configuredByField)
    .map(([field, raw]) => [field, parseTagList(raw)] as const)
    .filter(([, tags]) => tags.length > 0);
  if (configured.length === 0) return { drifts: [] };

  let stored: Record<string, string[]>;
  try {
    stored = storedTagsFromProfile(await fetchProfile());
  } catch (err) {
    return {
      drifts: [],
      skipped: `could not read the stored profile (${err instanceof Error ? err.message : String(err)})`,
    };
  }
  return {
    drifts: configured.map(([field, tags]) => diffTagField(field, tags, stored[field] || [])),
  };
}
