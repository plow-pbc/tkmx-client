import * as fs from "node:fs";
import * as crypto from "node:crypto";

// Guards a snapshot that is only worth sending when it has changed, while
// keeping "changed" and "delivered" separate. The hash is the record of what
// the server holds, so writing it at collection time would make an undelivered
// snapshot look delivered: the next run would match the stored hash, omit the
// snapshot, and leave the server stale until some unrelated edit moved the hash
// again. Callers therefore get a commit() to invoke once delivery is confirmed.
export interface DeliveryGate {
  commit: () => void;
}

export function gateOnSnapshotHash(snapshot: unknown, hashFile: string): DeliveryGate | null {
  const hash = crypto.createHash("sha256").update(JSON.stringify(snapshot)).digest("hex").slice(0, 16);
  let lastHash = "";
  try { lastHash = fs.readFileSync(hashFile, "utf-8").trim(); } catch {}
  if (hash === lastHash) return null;
  return { commit: () => fs.writeFileSync(hashFile, hash, "utf-8") };
}

export interface ReportingState {
  dev_stats_on: boolean;
  session_stats_on: boolean;
}

export const DEFAULT_STATE: Readonly<ReportingState> = Object.freeze({
  dev_stats_on: false,
  session_stats_on: false,
});

export function loadState(filePath: string): ReportingState {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    return {
      dev_stats_on:     Boolean(parsed.dev_stats_on),
      session_stats_on: Boolean(parsed.session_stats_on),
    };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export function saveState(filePath: string, state: ReportingState): void {
  const normalized: ReportingState = {
    dev_stats_on:     Boolean(state.dev_stats_on),
    session_stats_on: Boolean(state.session_stats_on),
  };
  fs.writeFileSync(filePath, JSON.stringify(normalized), "utf-8");
}

export interface TransitionMarkers {
  clear_dev_stats?: true;
  session_stats?: null;
}

// computeTransitionMarkers returns the set of POST body fields that
// should be added to this report to signal the transition to tkmx-server.
// Only on→off transitions produce markers; on→on, off→on, and off→off
// do not.
export function computeTransitionMarkers(prior: ReportingState, current: ReportingState): TransitionMarkers {
  const markers: TransitionMarkers = {};
  if (prior.dev_stats_on && !current.dev_stats_on) {
    markers.clear_dev_stats = true;
  }
  if (prior.session_stats_on && !current.session_stats_on) {
    markers.session_stats = null;
  }
  return markers;
}
