// Finds open pull requests that are doing the same job.
//
// WHY THIS EXISTS: an agent looking for work runs `bd ready`, and a bead stays
// OPEN until the pull request fixing it MERGES. So an unmerged fix keeps
// advertising itself as unclaimed work, and every fan-out mints another agent
// to re-solve it. On 2026-09-01 that had produced ten open pull requests doing
// one job (the beads scaffolding), six of them opened that same day. Titles do
// not catch this — those ten had ten different titles. Overlapping FILE SETS
// do, which is what this module clusters on.
//
// Run it before you open a pull request: `npm run duplicate-prs`.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// `gh pr list --json files` returns every path of every open pull request, and
// Node's default 1 MiB stdout buffer aborts the run with a message that reads
// like a `gh` failure. Same value and same reason as session-stats.ts, which
// was written after agentsview.ts hit exactly this.
const MAX_BUFFER_BYTES = 8 * 1024 * 1024;

export type PullRequest = {
  number: number;
  title: string;
  createdAt: string;
  files: { path: string }[];
};

export type Cluster = {
  prs: PullRequest[];
  // Files touched by EVERY pull request in the cluster. Often empty for a
  // cluster built by transitive linkage, where no single file spans the whole
  // group — that is a real result, not a bug, so the report must not present
  // an empty intersection as "these share nothing".
  sharedFiles: string[];
};

// Overlap is scored against the SMALLER of the two file sets, so a small pull
// request wholly contained in a large one scores 1.0. That containment is the
// most common shape of duplicated work here — a two-file `.gitignore` fix
// whose job a twenty-two-file scaffolding branch already does. Scoring against
// the union would rate that pair 2/23 and miss it.
export const DEFAULT_OVERLAP_THRESHOLD = 0.6;

function pathsOf(pr: PullRequest): Set<string> {
  return new Set(pr.files.map((file) => file.path));
}

function intersectionSize(a: Set<string>, b: Set<string>): number {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let count = 0;
  for (const value of small) if (large.has(value)) count += 1;
  return count;
}

function overlap(a: Set<string>, b: Set<string>): number {
  const smaller = Math.min(a.size, b.size);
  // A pull request that touches no files can neither duplicate nor be
  // duplicated, and dividing by its size would be a divide-by-zero.
  if (smaller === 0) return 0;
  return intersectionSize(a, b) / smaller;
}

// Single-linkage grouping via union-find. Linkage must be TRANSITIVE: if A
// overlaps B and B overlaps C, all three are one job in flight even when A and
// C share no file. A pairwise sweep that never merges existing groups reports
// two clusters there and understates the duplication.
class DisjointSet {
  private readonly parent: number[];

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_unused, index) => index);
  }

  find(index: number): number {
    let root = index;
    while (this.parent[root] !== root) root = this.parent[root];
    // Path compression, so repeated lookups over a large pull request list
    // stay flat.
    let cursor = index;
    while (this.parent[cursor] !== cursor) {
      const next = this.parent[cursor];
      this.parent[cursor] = root;
      cursor = next;
    }
    return root;
  }

  union(a: number, b: number): void {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA !== rootB) this.parent[rootB] = rootA;
  }
}

// Oldest first: the earliest pull request in a cluster is the one that has had
// review time and is the natural candidate to keep, so it should lead.
function byAge(a: PullRequest, b: PullRequest): number {
  const ageDiff = a.createdAt.localeCompare(b.createdAt);
  return ageDiff !== 0 ? ageDiff : a.number - b.number;
}

// One file in common is not evidence of a shared job. On the live board an
// unrelated pull request shared exactly ONE file with the scaffolding cluster
// (`.gitignore`) while every genuine member shared eight, and through that one
// file transitive linkage welded three unrelated features onto the cluster.
//
// This replaced a frequency cutoff that dropped "hub" files touched by most of
// the board. The cutoff worked on the day it was written and had a blind spot
// that swallowed the exact incident this module exists for: ten pull requests
// doing one job put their shared files in 10 of 14 branches, over any cutoff,
// so every one of those paths was discarded and the group dissolved into "no
// duplicate work found". Frequency cannot separate "many branches touch this
// incidentally" from "many branches touch this BECAUSE they are the same job"
// — the counts are identical — so the tool no longer asks it to.
const MIN_SHARED_FILES = 2;

// The requirement does NOT bend down for a small branch, and that is the whole
// point. Measured on the live board: a one-file pull request touching only
// `.gitignore` scored 1.00 against every branch that also touched it, and
// because linkage is transitive that single tiny branch was the BRIDGE that
// welded three unrelated features onto the scaffolding cluster. Letting a
// branch qualify on its only file is what builds those bridges.
//
// The one safe exception is two branches with IDENTICAL file sets: nothing
// more can be asked of them, they cannot bridge anything they are not already
// identical to, and two branches touching exactly the same single file are
// duplicates by definition.
function sameFiles(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const path of a) if (!b.has(path)) return false;
  return true;
}

function requiredSharedFiles(a: Set<string>, b: Set<string>): number {
  return sameFiles(a, b) ? 1 : MIN_SHARED_FILES;
}

export function clusterByFileOverlap(
  prs: PullRequest[],
  threshold: number = DEFAULT_OVERLAP_THRESHOLD,
): Cluster[] {
  const paths = prs.map(pathsOf);
  const groups = new DisjointSet(prs.length);

  for (let i = 0; i < prs.length; i += 1) {
    for (let j = i + 1; j < prs.length; j += 1) {
      const shared = intersectionSize(paths[i], paths[j]);
      if (
        shared >= requiredSharedFiles(paths[i], paths[j]) &&
        overlap(paths[i], paths[j]) >= threshold
      ) {
        groups.union(i, j);
      }
    }
  }

  const byRoot = new Map<number, number[]>();
  for (let i = 0; i < prs.length; i += 1) {
    const root = groups.find(i);
    const members = byRoot.get(root);
    if (members) members.push(i);
    else byRoot.set(root, [i]);
  }

  const clusters: Cluster[] = [];
  for (const members of byRoot.values()) {
    // A pull request on its own is not duplicated work.
    if (members.length < 2) continue;

    let shared: string[] = [...paths[members[0]]];
    for (const member of members.slice(1)) {
      shared = shared.filter((path) => paths[member].has(path));
    }

    clusters.push({
      prs: members.map((index) => prs[index]).sort(byAge),
      sharedFiles: shared.sort(),
    });
  }

  // Biggest pile of duplicated work first — that is where closing pull
  // requests buys the most.
  return clusters.sort(
    (a, b) => b.prs.length - a.prs.length || byAge(a.prs[0], b.prs[0]),
  );
}

export function formatClusters(clusters: Cluster[], totalOpen: number): string {
  if (clusters.length === 0) {
    return `No duplicate work found across ${totalOpen} open pull requests.`;
  }

  const lines: string[] = [];
  const duplicated = clusters.reduce(
    (sum, cluster) => sum + cluster.prs.length,
    0,
  );
  lines.push(
    `${duplicated} of ${totalOpen} open pull requests fall into ` +
      `${clusters.length} cluster(s) of overlapping work.`,
  );

  for (const cluster of clusters) {
    const [oldest, ...rest] = cluster.prs;
    lines.push("");
    lines.push(
      `Cluster of ${cluster.prs.length} — keep the oldest, #${oldest.number}:`,
    );
    lines.push(
      `  #${oldest.number}  ${oldest.createdAt.slice(0, 10)}  ${oldest.title}  [oldest]`,
    );
    for (const pr of rest) {
      lines.push(
        `  #${pr.number}  ${pr.createdAt.slice(0, 10)}  ${pr.title}`,
      );
    }
    if (cluster.sharedFiles.length > 0) {
      lines.push(`  shared by all: ${cluster.sharedFiles.join(", ")}`);
    } else {
      // Say so explicitly. An omitted line reads as "no overlap at all",
      // which is the opposite of what a transitive cluster means.
      lines.push(
        "  shared by all: none — linked transitively, in pairs rather than as a whole",
      );
    }
  }

  return lines.join("\n");
}

async function fetchOpenPullRequests(limit: number): Promise<PullRequest[]> {
  const { stdout } = await execFileAsync(
    "gh",
    [
      "pr",
      "list",
      "--state",
      "open",
      "--json",
      "number,title,createdAt,files",
      "--limit",
      String(limit),
    ],
    { maxBuffer: MAX_BUFFER_BYTES },
  );
  return JSON.parse(stdout) as PullRequest[];
}

type CliOptions = { limit: number; threshold: number };

const KNOWN_FLAGS = ["--limit", "--threshold"] as const;

// Reads `--flag value` and `--flag=value` into a map, and refuses anything it
// does not recognise.
//
// EVERY unrecognised shape is an error rather than a shrug, because the
// consequence of shrugging is uniform and bad: the flag is ignored, the
// default applies, and the operator reads a result they believe honoured their
// request. A misspelled `--treshold`, a trailing `--threshold` with nothing
// after it, and a stray positional all fail that same way. The `=` form
// matters most of all — it is the more common way to type it, and it does not
// appear in the argument list under its own name at all.
function readFlags(argv: string[]): Map<string, string> {
  const flags = new Map<string, string>();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      throw new Error(`unexpected argument ${token}; expected --limit or --threshold`);
    }

    const equals = token.indexOf("=");
    const name = equals === -1 ? token : token.slice(0, equals);
    if (!(KNOWN_FLAGS as readonly string[]).includes(name)) {
      throw new Error(`unknown flag ${name}; expected --limit or --threshold`);
    }

    if (equals !== -1) {
      // `--threshold=` with nothing after the sign is a typo, and the empty
      // string would coerce to 0 rather than failing.
      const value = token.slice(equals + 1);
      if (value === "") throw new Error(`${name} needs a value`);
      flags.set(name, value);
      continue;
    }

    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${name} needs a value`);
    }
    flags.set(name, value);
    index += 1;
  }

  return flags;
}

// Values are validated as well as read, because an unvalidated `--threshold`
// fails silently in the worst possible direction: `Number("zero")` is NaN,
// every `overlap >= NaN` comparison is false, nothing unions, and the tool
// prints a confident "No duplicate work found" for a run that never scored
// anything. A clean bill of health nobody earned is the worst output this tool
// can produce.
export function parseCliOptions(argv: string[]): CliOptions {
  const flags = readFlags(argv);

  const rawLimit = flags.get("--limit");
  let limit = 100;
  if (rawLimit !== undefined) {
    limit = Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(`--limit needs a positive whole number, got ${rawLimit}`);
    }
  }

  const rawThreshold = flags.get("--threshold");
  let threshold = DEFAULT_OVERLAP_THRESHOLD;
  if (rawThreshold !== undefined) {
    threshold = Number(rawThreshold);
    // Zero is rejected alongside NaN: it unions every pair on the board,
    // including pull requests that share nothing, and reports the whole thing
    // as one cluster.
    if (!(threshold > 0 && threshold <= 1)) {
      throw new Error(
        `--threshold needs a number greater than 0 and at most 1, got ${rawThreshold}`,
      );
    }
  }

  return { limit, threshold };
}

async function main(): Promise<void> {
  const { limit, threshold } = parseCliOptions(process.argv.slice(2));
  const prs = await fetchOpenPullRequests(limit);
  console.log(formatClusters(clusterByFileOverlap(prs, threshold), prs.length));
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(
      `duplicate-prs failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
