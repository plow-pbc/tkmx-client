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
  // Two files in common, so the shared-file requirement is satisfied and the
  // threshold is the only thing deciding: 2 of 4 is 0.5.
  const prs = [
    pr(1, ["a.ts", "b.ts", "c.ts", "d.ts"]),
    pr(2, ["a.ts", "b.ts", "x.ts", "y.ts", "z.ts", "w.ts"]),
  ];
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
// requests and, because linkage is transitive, welded three unrelated features
// (Ask-a-Builder, a worktree-marker fix, a bead filer) onto the beads
// scaffolding cluster. One file in common is not evidence of a shared job.
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

test("a widely touched file does not hide genuine duplication underneath it", () => {
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
  // Every shared file is reported, the common one included — these two really
  // do both touch it. It simply was not enough on its own to link them.
  assert.deepEqual(clusters[0].sharedFiles, [".gitignore", "alpha.ts", "beta.ts"]);
});

// Both reviews caught this: the hub filter went blind exactly where
// duplication is worst. With a floor of 2 and a `count > limit` test, a file
// present in EVERY pull request was dropped as soon as three were open, so
// three identical pull requests reported as no duplication at all — from a
// tool built because nine of twenty-one were one job.
test("three identical pull requests are found", () => {
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

// THE INCIDENT THIS MODULE EXISTS FOR, and the hub-file rule went silent on it.
// Ten pull requests doing the beads scaffolding on a fourteen-pull-request
// board: every one of their shared files was present in 10 of 14, over any
// frequency cutoff, so all of those paths were discarded and the group
// dissolved into nothing. It survived on the live 21-PR board only by luck of
// where the cutoff landed. Frequency cannot tell "many branches touch this
// incidentally" from "many branches touch this BECAUSE they are the same job",
// so the tool no longer tries.
test("ten duplicates among fourteen pull requests are found", () => {
  const scaffolding = [
    "AGENTS.md",
    "CLAUDE.md",
    ".beads/metadata.json",
    ".beads/.gitignore",
    ".codex/config.toml",
  ];
  const board = [
    ...Array.from({ length: 10 }, (_unused, index) =>
      pr(index + 1, scaffolding),
    ),
    ...Array.from({ length: 4 }, (_unused, index) =>
      pr(100 + index, [`unrelated-${index}.ts`]),
    ),
  ];
  const clusters = clusterByFileOverlap(board);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].prs.length, 10);
});

// What actually separated the false links from the real ones on the live
// board: an unrelated pull request shared exactly ONE file with the
// scaffolding cluster (`.gitignore`), while every genuine member shared eight.
// Requiring more than a single file in common is what the frequency cutoff was
// reaching for, without a cutoff's blind spot.
test("one file in common is not enough to link two multi-file pull requests", () => {
  const clusters = clusterByFileOverlap([
    pr(1, [".gitignore", "feature.ts"]),
    pr(2, [".gitignore", "unrelated.ts"]),
  ]);
  assert.deepEqual(clusters, []);
});

test("a single-file pull request still clusters on its only file", () => {
  // Nothing more can be asked of a branch that touches one file, and two
  // branches touching the same single file is duplication by definition.
  const clusters = clusterByFileOverlap([pr(1, ["alpha.ts"]), pr(2, ["alpha.ts"])]);
  assert.equal(clusters.length, 1);
});

// The comment on `requiredSharedFiles` blames this exact shape for sinking the
// first attempt — a one-file branch touching only a common file scored 1.00
// against everything else that touched it and became the bridge that welded
// unrelated features together — but nothing exercised it.
test("a single-file branch does not bridge two unrelated ones", () => {
  const clusters = clusterByFileOverlap([
    pr(1, ["a.ts", ".gitignore"]),
    pr(2, [".gitignore"]),
    pr(3, ["c.ts", ".gitignore"]),
  ]);
  assert.deepEqual(clusters, []);
});

// THE BOUNDARY, written down so the next change to this file finds it here
// rather than on a live board. Every branch carrying the same two boilerplate
// files plus one of its own gives every pair shared = 2 and overlap = 2/3, so
// they all union and the report calls the whole board one cluster.
//
// This is left LOOSE deliberately, and the choice is the point: a visibly
// over-wide cluster is self-correcting because a human reads the list and can
// see it is wrong, whereas the silence it replaced looked exactly like a clean
// board. Tightening it means another frequency-shaped knob, and every previous
// turn of that knob traded one wrong answer for a quieter one. If this fires
// on a real board, change the THRESHOLD for that run before touching the rule.
test("shared boilerplate can pull an entire board into one cluster", () => {
  const board = Array.from({ length: 14 }, (_unused, index) =>
    pr(index + 1, ["AGENTS.md", "CLAUDE.md", `feature-${index}.ts`]),
  );
  const clusters = clusterByFileOverlap(board);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].prs.length, 14);
});

