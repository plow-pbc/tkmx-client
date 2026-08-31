import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTagList, diffTags, formatTagDiff, parseProfileTags } from "../reporter/tag-diff";

// The badge lists are additive server-side, so anything this diff fails to flag
// becomes a permanent chip that only `npm run untag` can remove. The cases below
// are the real ones: thirteen duplicates reached one profile this way, and the
// .env that would mint the next batch carries both "WisprFlow" and the typo
// "WhsprFlow".

test("parseTagList trims, drops empties, and keeps interior spacing", () => {
  assert.deepEqual(parseTagList(" Cursor , Warp,,  Wispr Flow ,"), ["Cursor", "Warp", "Wispr Flow"]);
  assert.deepEqual(parseTagList(""), []);
  assert.deepEqual(parseTagList("   "), []);
});

test("a tag the server already holds is not an addition", () => {
  const diff = diffTags(["Cursor", "Warp"], ["Warp", "Cursor"]);
  assert.deepEqual(diff.additions, []);
  assert.deepEqual(diff.nearDuplicates, []);
});

test("case differences are not additions — the server dedupes on lowercase", () => {
  // If this were reported as an addition the reporter would warn on every run
  // about a chip that can never appear, which is how a useful warning gets
  // ignored.
  const diff = diffTags(["cursor", "WARP"], ["Cursor", "Warp"]);
  assert.deepEqual(diff.additions, []);
});

test("a genuinely new tag is reported as a plain addition, not a duplicate", () => {
  const diff = diffTags(["Cursor", "Ghostty"], ["Cursor"]);
  assert.deepEqual(diff.additions, ["Ghostty"]);
  assert.deepEqual(diff.nearDuplicates, []);
});

test("spacing-only variants ARE flagged — the server treats them as separate badges", () => {
  // The exact gap this exists to close: the server's dedupe is case-insensitive
  // but not whitespace-insensitive, so "WisprFlow" lands alongside "Wispr Flow"
  // as a second chip while a human reads them as one tool.
  const diff = diffTags(["WisprFlow"], ["Wispr Flow"]);
  assert.deepEqual(diff.additions, ["WisprFlow"]);
  assert.deepEqual(diff.nearDuplicates, [{ adding: "WisprFlow", existing: "Wispr Flow" }]);
});

test("punctuation-only variants are flagged too", () => {
  const diff = diffTags(["wispr-flow"], ["Wispr Flow"]);
  assert.deepEqual(diff.nearDuplicates, [{ adding: "wispr-flow", existing: "Wispr Flow" }]);
});

test("two collisions in one machine's own .env are caught before either lands", () => {
  // Neither is on the profile yet, so a diff against the server alone sees two
  // ordinary additions. This is the "latent landmine" shape: a repaired client
  // mints both at once.
  const diff = diffTags(["WisprFlow", "WhsprFlow"], []);
  assert.deepEqual(diff.additions, ["WisprFlow", "WhsprFlow"]);
  assert.deepEqual(diff.nearDuplicates, []);
  assert.deepEqual(diff.selfCollisions, []);
  // "WhsprFlow" is a typo, not a spacing variant, so it does NOT collapse to the
  // same loose key — the two are genuinely different strings and no automatic
  // rule can call that a duplicate without also flagging unrelated names.
});

test("a self-collision that IS a spacing variant is caught", () => {
  const diff = diffTags(["Wispr Flow", "WisprFlow"], []);
  assert.deepEqual(diff.additions, ["Wispr Flow", "WisprFlow"]);
  assert.deepEqual(diff.selfCollisions, [{ adding: "WisprFlow", existing: "Wispr Flow" }]);
});

test("accented names do not collide with their unaccented lookalikes", () => {
  // Stripping non-alphanumerics must not strip letters: "Café" and "Cafe" are
  // different products, and a false duplicate warning trains people to ignore
  // the real ones.
  const diff = diffTags(["Café.ai"], ["Cafe.ai"]);
  assert.deepEqual(diff.additions, ["Café.ai"]);
  assert.deepEqual(diff.nearDuplicates, []);
});

test("nothing to add renders no output at all", () => {
  const lines = formatTagDiff("tools", diffTags(["Cursor"], ["Cursor"]));
  assert.deepEqual(lines, [], "a machine already agreeing with its profile must stay silent");
});

test("a near-duplicate warning names both spellings and the way to undo it", () => {
  const lines = formatTagDiff("tools", diffTags(["WisprFlow"], ["Wispr Flow"]));
  const text = lines.join("\n");
  assert.match(text, /TOOLS/);
  assert.match(text, /"WisprFlow"/);
  assert.match(text, /"Wispr Flow"/);
  assert.match(text, /npm run untag -- tools/, "must say how to remove it, since blanking .env cannot");
  assert.match(text, /additive/i);
});

test("a plain addition is reported without the duplicate scolding", () => {
  const lines = formatTagDiff("tools", diffTags(["Ghostty"], ["Cursor"]));
  const text = lines.join("\n");
  assert.match(text, /adding "Ghostty"/);
  assert.doesNotMatch(text, /duplicate/i);
  assert.doesNotMatch(text, /untag/, "an intended addition should not be dressed up as a problem");
});

test("a near-duplicate is not also listed as a plain addition", () => {
  // Otherwise the same tag is reported twice in one run, in two different
  // registers, and the warning reads like a bug.
  const lines = formatTagDiff("tools", diffTags(["WisprFlow", "Ghostty"], ["Wispr Flow"]));
  const plain = lines.filter((l) => l.includes("adding "));
  assert.equal(plain.length, 1);
  assert.match(plain[0], /"Ghostty"/);
  assert.doesNotMatch(plain[0], /WisprFlow/);
});

test("parseProfileTags reads the server's comma-separated lists", () => {
  const body = JSON.stringify({ tools: "Cursor, Warp", projects: "tkmx", about: "ignored" });
  assert.deepEqual(parseProfileTags(body, ["tools", "projects", "communities"]), {
    tools: ["Cursor", "Warp"],
    projects: ["tkmx"],
    communities: [],
  });
});

test("an unparseable profile body reads as empty rather than throwing", () => {
  // A proxy error page instead of the API answering. Treating it as "nothing
  // known" is right: every local tag then reads as an addition, which is the
  // honest answer when the profile could not be read.
  assert.deepEqual(parseProfileTags("<html>502</html>", ["tools"]), { tools: [] });
});
