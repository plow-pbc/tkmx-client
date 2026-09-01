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

export type PullRequest = {
  number: number;
  title: string;
  headRefName: string;
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

// A file that nearly every open branch touches carries no information about
// what job a branch is doing. `.gitignore` is the worst offender here: on the
// live board it appeared in 13 of 21 open pull requests, and because linkage is
// transitive it welded three unrelated features onto the scaffolding cluster
// through that one file. Such hub files are dropped before scoring.
//
// The bar is deliberately high — a STRICT MAJORITY of open pull requests. Set
// lower, the rule eats the signal on a small board: with five pull requests
// open, three of them doing the same job is the duplication being hunted, and
// a quarter-of-the-board rule would write those three files off as hubs and
// report nothing. The floor of 2 covers the same failure at the smallest
// scale, where the one file two branches genuinely share is present in 100% of
// them. The cost of the high bar is that a moderately common file (a README in
// a third of the branches) still scores; that yields a loose cluster, which is
// a far cheaper error than silence.
export const HUB_FILE_FRACTION = 0.5;

export function findHubFiles(prs: PullRequest[]): Set<string> {
  const counts = new Map<string, number>();
  for (const pr of prs) {
    for (const path of pathsOf(pr)) {
      counts.set(path, (counts.get(path) ?? 0) + 1);
    }
  }

  const limit = Math.max(2, Math.ceil(HUB_FILE_FRACTION * prs.length));
  const hubs = new Set<string>();
  for (const [path, count] of counts) {
    if (count > limit) hubs.add(path);
  }
  return hubs;
}

export function clusterByFileOverlap(
  prs: PullRequest[],
  threshold: number = DEFAULT_OVERLAP_THRESHOLD,
): Cluster[] {
  const hubs = findHubFiles(prs);
  const paths = prs.map((pr) => {
    const kept = new Set<string>();
    for (const path of pathsOf(pr)) if (!hubs.has(path)) kept.add(path);
    return kept;
  });
  const groups = new DisjointSet(prs.length);

  for (let i = 0; i < prs.length; i += 1) {
    for (let j = i + 1; j < prs.length; j += 1) {
      if (overlap(paths[i], paths[j]) >= threshold) groups.union(i, j);
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
  const { stdout } = await execFileAsync("gh", [
    "pr",
    "list",
    "--state",
    "open",
    "--json",
    "number,title,headRefName,createdAt,files",
    "--limit",
    String(limit),
  ]);
  return JSON.parse(stdout) as PullRequest[];
}

async function main(): Promise<void> {
  const limitArg = process.argv.indexOf("--limit");
  const limit = limitArg === -1 ? 100 : Number(process.argv[limitArg + 1]);
  const thresholdArg = process.argv.indexOf("--threshold");
  const threshold =
    thresholdArg === -1
      ? DEFAULT_OVERLAP_THRESHOLD
      : Number(process.argv[thresholdArg + 1]);

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
