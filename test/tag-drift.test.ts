import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseTagList,
  editDistance,
  diffTagField,
  formatTagDrift,
  storedTagsFromProfile,
  checkTagDrift,
} from "../reporter/tag-drift";

describe("parseTagList", () => {
  it("splits, trims and drops blanks", () => {
    assert.deepEqual(parseTagList(" Cursor , CC ,, Warp "), ["Cursor", "CC", "Warp"]);
  });

  it("treats missing config as no tags", () => {
    assert.deepEqual(parseTagList(undefined), []);
    assert.deepEqual(parseTagList(""), []);
  });
});

describe("diffTagField", () => {
  it("reports nothing when the profile already has every configured tag", () => {
    const drift = diffTagField("tools", ["Cursor", "Warp"], ["Warp", "Cursor"]);
    assert.deepEqual(drift.newTags, []);
    assert.deepEqual(drift.nearDuplicates, []);
  });

  it("matches on case, mirroring the server's dedupe", () => {
    const drift = diffTagField("tools", ["cursor"], ["Cursor"]);
    assert.deepEqual(drift.newTags, []);
  });

  it("treats a differently spaced name as new, because the server does", () => {
    const drift = diffTagField("tools", ["Wispr Flow"], ["WisprFlow"]);
    assert.deepEqual(drift.newTags, ["Wispr Flow"]);
    assert.deepEqual(drift.nearDuplicates, [{ configured: "Wispr Flow", stored: "WisprFlow" }]);
  });

  it("flags the typo that actually happened", () => {
    // The stale .env listed both spellings; only the typo is new to the profile.
    const drift = diffTagField("tools", ["WisprFlow", "WhsprFlow"], ["WisprFlow"]);
    assert.deepEqual(drift.newTags, ["WhsprFlow"]);
    assert.deepEqual(drift.nearDuplicates, [{ configured: "WhsprFlow", stored: "WisprFlow" }]);
  });

  it("does not cry typo over short, genuinely different names", () => {
    const drift = diffTagField("tools", ["CC"], ["Warp", "Zight"]);
    assert.deepEqual(drift.newTags, ["CC"]);
    assert.deepEqual(drift.nearDuplicates, []);
  });

  it("keeps unrelated long names apart", () => {
    const drift = diffTagField("tools", ["Storytell.ai"], ["Superpowers"]);
    assert.deepEqual(drift.nearDuplicates, []);
  });
});

describe("editDistance", () => {
  it("counts single-character edits", () => {
    assert.equal(editDistance("wisprflow", "whsprflow"), 1);
    assert.equal(editDistance("abc", "abc"), 0);
    assert.equal(editDistance("", "abc"), 3);
  });
});

describe("formatTagDrift", () => {
  it("names every new badge, the resemblance and the way back", () => {
    const lines = formatTagDrift([
      diffTagField("tools", ["WhsprFlow", "Ghostty"], ["WisprFlow"]),
    ]);
    const text = lines.join("\n");
    assert.match(text, /will ADD 2 new badge/);
    assert.match(text, /\+ WhsprFlow/);
    assert.match(text, /\+ Ghostty/);
    assert.match(text, /"WhsprFlow" looks like "WisprFlow"/);
    assert.match(text, /npm run untag -- tools/);
  });

  it("says nothing when no field has new badges", () => {
    assert.deepEqual(formatTagDrift([diffTagField("tools", ["Cursor"], ["Cursor"])]), []);
  });
});

describe("storedTagsFromProfile", () => {
  it("reads all three additive fields", () => {
    const stored = storedTagsFromProfile(JSON.stringify({
      tools: "Cursor, Warp",
      projects: "Builder Index",
      communities: "",
    }));
    assert.deepEqual(stored.tools, ["Cursor", "Warp"]);
    assert.deepEqual(stored.projects, ["Builder Index"]);
    assert.deepEqual(stored.communities, []);
  });

  it("tolerates a profile missing the fields entirely", () => {
    const stored = storedTagsFromProfile(JSON.stringify({ username: "someone" }));
    assert.deepEqual(stored.tools, []);
  });
});

describe("checkTagDrift", () => {
  it("does not read the profile when nothing is configured", async () => {
    let called = false;
    const result = await checkTagDrift({ tools: "", projects: undefined }, async () => {
      called = true;
      return "{}";
    });
    assert.equal(called, false);
    assert.deepEqual(result.drifts, []);
  });

  it("reports drift per configured field", async () => {
    const result = await checkTagDrift(
      { tools: "Cursor,WhsprFlow", communities: "HN" },
      async () => JSON.stringify({ tools: "Cursor, WisprFlow", communities: "HN" }),
    );
    const tools = result.drifts.find((d) => d.field === "tools")!;
    assert.deepEqual(tools.newTags, ["WhsprFlow"]);
    const communities = result.drifts.find((d) => d.field === "communities")!;
    assert.deepEqual(communities.newTags, []);
  });

  it("says the check was skipped rather than throwing when the profile is unreadable", async () => {
    const result = await checkTagDrift({ tools: "Cursor" }, async () => {
      throw new Error("ETIMEDOUT");
    });
    assert.deepEqual(result.drifts, []);
    assert.match(result.skipped!, /could not read the stored profile.*ETIMEDOUT/);
  });

  it("says the check was skipped when the profile is not JSON", async () => {
    const result = await checkTagDrift({ tools: "Cursor" }, async () => "<html>proxy error</html>");
    assert.ok(result.skipped, "a non-JSON profile should skip, not throw");
  });
});
