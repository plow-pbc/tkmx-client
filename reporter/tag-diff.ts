// Diffs this machine's badge lists (TOOLS / PROJECTS / COMMUNITIES) against the
// ones the server already holds, so a report says what it is about to ADD
// instead of adding it silently.
//
// WHY THIS EXISTS. The badge lists are additive server-side: `/api/usage` unions
// what you post into what it already stored, so a name that appears in any
// machine's .env becomes a permanent chip on the profile. Nothing takes it back
// off again — shortening or blanking the line cannot, because a union has no way
// to express "remove"; that needs a separate `npm run untag` call. Adding is
// therefore a side effect of a report you were making anyway, while removing is
// a deliberate command, and that asymmetry is what makes a typo expensive.
//
// The failure this guards is not hypothetical. Thirteen duplicate chips reached
// one profile that way, and the .env that would mint the next batch lists both
// "WisprFlow" and the typo "WhsprFlow" — two chips, one tool, and nobody would
// see either until they landed. Adding the diff on the CLIENT is what makes it
// preventable: only the reporting machine knows what it is about to send, and it
// knows it a moment BEFORE the union happens.
//
// TWO NORMALIZATIONS, DELIBERATELY DIFFERENT. The server dedupes on a lowercased
// tag but not a whitespace-stripped one, so "WisprFlow" and "Wispr Flow" really
// are two badges and each needs its own removal. This module therefore compares
// twice:
//
//   exact (lowercase+trim)  — mirrors the server. A match here means the union
//                             is a no-op, so there is nothing to warn about.
//   loose (alphanumerics)   — does NOT mirror the server, on purpose. A match
//                             here is precisely the dangerous case: the server
//                             will treat it as a new badge while a human reads
//                             it as the one already there.

// One badge list, as it travels: a comma-separated string, both in .env and in
// the profile the server returns. Trimmed and emptied-out the same way the
// removal command parses it, so what this compares is what is really stored.
export function parseTagList(raw: string): string[] {
  return String(raw || "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

// The server's own dedupe key.
function exactKey(tag: string): string {
  return tag.trim().toLowerCase();
}

// Deliberately coarser than the server: drops every non-alphanumeric character,
// so spacing, punctuation and casing all collapse. "Wispr Flow", "WisprFlow" and
// "wispr-flow" share a key here and do not share one on the server — which is
// the whole point, because that gap is where duplicate chips come from.
//
// Unicode-aware: a name like "Café.ai" must not lose its accent and collide with
// an unrelated "Cafe" — \p{L}\p{N} keeps letters and digits from any script.
function looseKey(tag: string): string {
  return tag.trim().toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

export interface TagDiff {
  // Tags this machine would mint that the profile does not already carry.
  additions: string[];
  // The subset of additions that read as a duplicate of something already
  // there. `existing` is the live tag it collides with.
  nearDuplicates: Array<{ adding: string; existing: string }>;
  // Two entries in THIS machine's own list that collide with each other, e.g.
  // "WisprFlow" alongside the typo "WhsprFlow" — neither is on the profile yet,
  // so a diff against the server alone would miss them.
  selfCollisions: Array<{ adding: string; existing: string }>;
}

// `live` is what the server holds; `local` is what this machine would post.
// Order of `additions` follows the local list, so the warning reads in the same
// order as the .env line it is telling you to edit.
export function diffTags(local: readonly string[], live: readonly string[]): TagDiff {
  const liveExact = new Map<string, string>();
  const liveLoose = new Map<string, string>();
  for (const tag of live) {
    // First spelling wins on collision: it is the one already rendered on the
    // profile, so it is the one a human is being asked to compare against.
    if (!liveExact.has(exactKey(tag))) liveExact.set(exactKey(tag), tag);
    if (!liveLoose.has(looseKey(tag))) liveLoose.set(looseKey(tag), tag);
  }

  const additions: string[] = [];
  const nearDuplicates: TagDiff["nearDuplicates"] = [];
  const selfCollisions: TagDiff["selfCollisions"] = [];
  // Additions accumulate as they are found, so a second local tag can collide
  // with a first local tag that is itself not yet on the profile.
  const seenLoose = new Map<string, string>();

  for (const tag of local) {
    if (liveExact.has(exactKey(tag))) continue;  // server would dedupe it away

    additions.push(tag);

    const existing = liveLoose.get(looseKey(tag));
    if (existing) {
      nearDuplicates.push({ adding: tag, existing });
    } else {
      const earlier = seenLoose.get(looseKey(tag));
      if (earlier) selfCollisions.push({ adding: tag, existing: earlier });
    }
    if (!seenLoose.has(looseKey(tag))) seenLoose.set(looseKey(tag), tag);
  }

  return { additions, nearDuplicates, selfCollisions };
}

// Renders one field's diff. Returns [] when there is nothing to say, so the
// common steady state — every machine already agreeing with the profile — stays
// silent rather than printing a heading with nothing under it.
//
// The near-duplicate lines lead, and say what to do. A plain addition is usually
// what you intended, so it is reported as information rather than a problem;
// a near-duplicate almost never is, and it is permanent once it lands.
export function formatTagDiff(field: string, diff: TagDiff): string[] {
  if (diff.additions.length === 0) return [];

  const env = field.toUpperCase();
  const lines: string[] = [];

  for (const { adding, existing } of diff.nearDuplicates) {
    lines.push(
      `  ⚠️  ${env}: about to add "${adding}", which looks like a duplicate of "${existing}" already on your profile.`,
    );
  }
  for (const { adding, existing } of diff.selfCollisions) {
    lines.push(
      `  ⚠️  ${env}: "${adding}" and "${existing}" are both in this machine's .env and read as the same thing — both will become chips.`,
    );
  }
  if (diff.nearDuplicates.length > 0 || diff.selfCollisions.length > 0) {
    lines.push(
      `      Badge lists are additive: once added, a chip stays until you run \`npm run untag -- ${field} "<exact text>"\`.`,
    );
    lines.push(`      Fix the spelling in this machine's .env before the next report to avoid minting it.`);
  }

  const plain = diff.additions.filter(
    (t) =>
      !diff.nearDuplicates.some((d) => d.adding === t) &&
      !diff.selfCollisions.some((d) => d.adding === t),
  );
  if (plain.length > 0) {
    lines.push(`  ${env}: adding ${plain.map((t) => `"${t}"`).join(", ")} to your profile.`);
  }

  return lines;
}

// The profile read returns each list as a comma-separated string under its own
// key. Anything missing reads as an empty list, which is the right default: a
// profile with no tools yet and a body this client cannot parse both mean "we
// know of nothing already there", and in both cases every local tag is a genuine
// addition.
export function parseProfileTags(body: string, fields: readonly string[]): Record<string, string[]> {
  let profile: Record<string, unknown> = {};
  try {
    profile = JSON.parse(body) as Record<string, unknown>;
  } catch {
    // Not JSON — a proxy error page rather than the API answering.
  }
  const out: Record<string, string[]> = {};
  for (const field of fields) out[field] = parseTagList(String(profile[field] || ""));
  return out;
}
