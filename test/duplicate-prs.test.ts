import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clusterByFileOverlap,
  formatClusters,
  parseCliOptions,
  type PullRequest,
} from "../reporter/duplicate-prs";

function pr(
  number: number,
  files: string[],
  createdAt = "2026-09-01T00:00:00Z",
  title = `PR ${number}`,
): PullRequest {
  return {
    number,
    title,
    createdAt,
    files: files.map((path) => ({ path })),
  };
}

test("no pull requests yields no clusters", () => {
  assert.deepEqual(clusterByFileOverlap([]), []);
});

test("a lone pull request is not a cluster", () => {
  assert.deepEqual(clusterByFileOverlap([pr(1, ["a.ts"])]), []);
});

test("pull requests touching disjoint files are not clustered", () => {
  const clusters = clusterByFileOverlap([
    pr(1, ["a.ts", "b.ts"]),
    pr(2, ["c.ts", "d.ts"]),
  ]);
  assert.deepEqual(clusters, []);
});

test("pull requests over the overlap threshold cluster together", () => {
  const clusters = clusterByFileOverlap([
    pr(1, ["a.ts", "b.ts", "c.ts"]),
    pr(2, ["a.ts", "b.ts", "z.ts"]),
  ]);
  assert.equal(clusters.length, 1);
  assert.deepEqual(
    clusters[0].prs.map((p) => p.number),
    [1, 2],
  );
  assert.deepEqual(clusters[0].sharedFiles, ["a.ts", "b.ts"]);
});

// The real census found #83 (a two-file gitignore change) doing a job that
// #69 (a 22-file scaffolding change) already contained. Scoring overlap
// against the SMALLER file set is what catches a subsumed pull request;
// scoring against the union would score that pair at 2/23 and miss it.
test("a small pull request subsumed by a large one is clustered", () => {
  const clusters = clusterByFileOverlap([
    pr(1, ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"]),
    pr(2, ["a.ts", "b.ts"]),
  ]);
  assert.equal(clusters.length, 1);
  assert.deepEqual(
    clusters[0].prs.map((p) => p.number),
    [1, 2],
  );
});

// Single-linkage: A overlaps B and B overlaps C, but A and C share nothing.
// They are still one job in flight, so they belong in one cluster. A pairwise
// sweep that never merges groups reports two clusters here and understates
// the duplication.
test("overlap is transitive across the cluster", () => {
  // Each ADJACENT pair clears the threshold on its own (2 of 3 = 0.67), while
  // the two ends share no file at all.
  const clusters = clusterByFileOverlap([
    pr(1, ["a.ts", "b.ts", "c.ts"]),
    pr(2, ["b.ts", "c.ts", "d.ts", "e.ts"]),
    pr(3, ["d.ts", "e.ts", "f.ts"]),
  ]);
  assert.equal(clusters.length, 1);
  assert.deepEqual(
    clusters[0].prs.map((p) => p.number),
    [1, 2, 3],
  );
  // Nothing is shared by all three, and the report must not claim otherwise.
  assert.deepEqual(clusters[0].sharedFiles, []);
});

test("a pull request with no files never clusters", () => {
  const clusters = clusterByFileOverlap([pr(1, []), pr(2, [])]);
  assert.deepEqual(clusters, []);
});

test("clusters are ordered largest first", () => {
  const clusters = clusterByFileOverlap([
    pr(1, ["x.ts", "y.ts"]),
    pr(2, ["x.ts", "y.ts"]),
    pr(3, ["a.ts", "b.ts"]),
    pr(4, ["a.ts", "b.ts"]),
    pr(5, ["a.ts", "b.ts"]),
  ]);
  assert.deepEqual(
    clusters.map((c) => c.prs.length),
    [3, 2],
  );
});

test("within a cluster the oldest pull request comes first", () => {
  const clusters = clusterByFileOverlap([
    pr(9, ["a.ts", "b.ts"], "2026-09-01T00:00:00Z"),
    pr(2, ["a.ts", "b.ts"], "2026-08-17T00:00:00Z"),
  ]);
  assert.deepEqual(
    clusters[0].prs.map((p) => p.number),
    [2, 9],
  );
});

test("the threshold is configurable", () => {
  const prs = [pr(1, ["a.ts", "b.ts", "c.ts"]), pr(2, ["a.ts", "z.ts", "y.ts"])];
  assert.deepEqual(clusterByFileOverlap(prs, 0.6), []);
  assert.equal(clusterByFileOverlap(prs, 0.3).length, 1);
});

test("the report names the oldest pull request as the one to keep", () => {
  const clusters = clusterByFileOverlap([
    pr(9, ["a.ts", "b.ts"], "2026-09-01T00:00:00Z", "later twin"),
    pr(2, ["a.ts", "b.ts"], "2026-08-17T00:00:00Z", "original"),
  ]);
  const report = formatClusters(clusters, 2);
  assert.match(report, /#2/);
  assert.match(report, /#9/);
  assert.match(report, /oldest/i);
});

test("a clean slate reports no duplication rather than an empty list", () => {
  const report = formatClusters([], 3);
  assert.match(report, /no duplicate/i);
  assert.doesNotMatch(report, /#/);
});

// Live run caught this: `.gitignore` was touched by 13 of 21 open pull
// requests, so it acted as a hub and transitively welded three unrelated
// features (Ask-a-Builder, a worktree-marker fix, a bead filer) onto the beads
// scaffolding cluster. A file that nearly every branch touches says nothing
// about what job a branch is doing, so it must not score.
test("a file touched by most pull requests does not link them", () => {
  const others = Array.from({ length: 8 }, (_unused, index) =>
    pr(100 + index, [".gitignore", `unrelated-${index}.ts`]),
  );
  const clusters = clusterByFileOverlap([
    pr(1, [".gitignore", "alpha.ts"]),
    pr(2, [".gitignore", "beta.ts"]),
    ...others,
  ]);
  assert.deepEqual(clusters, []);
});

test("a hub file does not hide genuine duplication underneath it", () => {
  const others = Array.from({ length: 8 }, (_unused, index) =>
    pr(100 + index, [".gitignore", `unrelated-${index}.ts`]),
  );
  const clusters = clusterByFileOverlap([
    pr(1, [".gitignore", "alpha.ts", "beta.ts"]),
    pr(2, [".gitignore", "alpha.ts", "beta.ts"]),
    ...others,
  ]);
  assert.equal(clusters.length, 1);
  assert.deepEqual(
    clusters[0].prs.map((p) => p.number),
    [1, 2],
  );
  // The hub file is excluded from scoring, so it is not evidence and must not
  // be reported as the thing these two share.
  assert.deepEqual(clusters[0].sharedFiles, ["alpha.ts", "beta.ts"]);
});

test("two pull requests sharing one file still cluster on a small board", () => {
  // With only a handful of pull requests open, nothing is a hub yet — the
  // guard must not suppress real duplication on a quiet repository.
  const clusters = clusterByFileOverlap([
    pr(1, ["alpha.ts"]),
    pr(2, ["alpha.ts"]),
  ]);
  assert.equal(clusters.length, 1);
});

// Both reviews caught this: the hub filter went blind exactly where
// duplication is worst. With a floor of 2 and a `count > limit` test, a file
// present in EVERY pull request was dropped as soon as three were open, so
// three identical pull requests reported as no duplication at all — from a
// tool built because nine of twenty-one were one job.
test("three identical pull requests are not written off as hub files", () => {
  const clusters = clusterByFileOverlap([
    pr(1, ["alpha.ts", "beta.ts"]),
    pr(2, ["alpha.ts", "beta.ts"]),
    pr(3, ["alpha.ts", "beta.ts"]),
  ]);
  assert.equal(clusters.length, 1);
  assert.deepEqual(
    clusters[0].prs.map((p) => p.number),
    [1, 2, 3],
  );
});

test("four duplicates among six pull requests still cluster", () => {
  const clusters = clusterByFileOverlap([
    pr(1, ["alpha.ts", "beta.ts"]),
    pr(2, ["alpha.ts", "beta.ts"]),
    pr(3, ["alpha.ts", "beta.ts"]),
    pr(4, ["alpha.ts", "beta.ts"]),
    pr(5, ["gamma.ts", "delta.ts"]),
    pr(6, ["epsilon.ts", "zeta.ts"]),
  ]);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].prs.length, 4);
});

// The comment on Cluster.sharedFiles names this as the case the report must
// not misstate, so pin the branch rather than trusting the comment.
test("a transitive cluster says so instead of showing an empty shared list", () => {
  const clusters = clusterByFileOverlap([
    pr(1, ["a.ts", "b.ts", "c.ts"]),
    pr(2, ["b.ts", "c.ts", "d.ts", "e.ts"]),
    pr(3, ["d.ts", "e.ts", "f.ts"]),
  ]);
  assert.deepEqual(clusters[0].sharedFiles, []);
  assert.match(formatClusters(clusters, 3), /linked transitively/);
});

// A typo'd --threshold used to yield NaN, every `>= NaN` comparison was false,
// and the tool printed a confident "No duplicate work found" for a run that
// never scored anything. Failing loudly beats a clean bill of health nobody
// earned.
test("cli options default when the flags are absent", () => {
  const options = parseCliOptions([]);
  assert.equal(options.limit, 100);
  assert.equal(options.threshold, 0.6);
});

test("cli options read explicit flags", () => {
  const options = parseCliOptions(["--limit", "40", "--threshold", "0.8"]);
  assert.equal(options.limit, 40);
  assert.equal(options.threshold, 0.8);
});

test("a non-numeric threshold is rejected rather than scoring nothing", () => {
  assert.throws(() => parseCliOptions(["--threshold", "zero-point-six"]), /threshold/);
  assert.throws(() => parseCliOptions(["--threshold"]), /threshold/);
});

test("a threshold outside (0, 1] is rejected", () => {
  assert.throws(() => parseCliOptions(["--threshold", "0"]), /threshold/);
  assert.throws(() => parseCliOptions(["--threshold", "1.5"]), /threshold/);
  assert.doesNotThrow(() => parseCliOptions(["--threshold", "1"]));
});

test("a non-numeric limit is rejected", () => {
  assert.throws(() => parseCliOptions(["--limit", "lots"]), /limit/);
  assert.throws(() => parseCliOptions(["--limit", "0"]), /limit/);
});

// `--threshold=0.8` is the more common way to type it, and it used to miss
// `indexOf` entirely: the flag was ignored, the default was used, and the
// operator read a result they believed was computed at 0.8. That is the exact
// silent default this parser exists to prevent.
test("the equals form of a flag is honoured", () => {
  const options = parseCliOptions(["--limit=40", "--threshold=0.8"]);
  assert.equal(options.limit, 40);
  assert.equal(options.threshold, 0.8);
});

test("the equals form is validated like the spaced form", () => {
  assert.throws(() => parseCliOptions(["--threshold=zero"]), /threshold/);
  assert.throws(() => parseCliOptions(["--threshold="]), /threshold/);
});

// A misspelled flag is the same failure wearing a different hat: it parses as
// nothing, the default applies, and the run looks like it honoured the
// request.
test("an unknown flag is rejected rather than ignored", () => {
  assert.throws(() => parseCliOptions(["--treshold", "0.8"]), /--treshold/);
  assert.throws(() => parseCliOptions(["--verbose"]), /--verbose/);
});

test("a bare positional argument is rejected", () => {
  assert.throws(() => parseCliOptions(["40"]), /40/);
});
