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
  // ISO timestamp of the last report the server actually accepted, or null if
  // it has never accepted one. This is the only local evidence that the
  // reporter is alive: a daemon whose launchd/systemd unit has stopped firing
  // leaves no error anywhere, so "when did this last work" is what
  // distinguishes a broken collector from a builder who took the week off.
  last_success_at: string | null;
}

export const DEFAULT_STATE: Readonly<ReportingState> = Object.freeze({
  dev_stats_on: false,
  session_stats_on: false,
  last_success_at: null,
});

export function loadState(filePath: string): ReportingState {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    return {
      dev_stats_on:     Boolean(parsed.dev_stats_on),
      session_stats_on: Boolean(parsed.session_stats_on),
      // Anything that isn't a string — absent (a state file written before this
      // field existed), or a number from a hand-edited file — reads as "never
      // succeeded". Coercing instead would manufacture a bogus freshness.
      last_success_at:  typeof parsed.last_success_at === "string" ? parsed.last_success_at : null,
    };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export function saveState(filePath: string, state: ReportingState): void {
  const normalized: ReportingState = {
    dev_stats_on:     Boolean(state.dev_stats_on),
    session_stats_on: Boolean(state.session_stats_on),
    last_success_at:  typeof state.last_success_at === "string" ? state.last_success_at : null,
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

// Stamps "the server accepted a report just now" onto the persisted state,
// leaving every other field exactly as it is on disk.
//
// It reloads rather than taking a ReportingState because the one caller runs on
// a path where the in-memory state deliberately has NOT been persisted: a frozen
// profile answers 200 without applying anything, so report.ts withholds
// saveState to keep the one-shot transition markers unconsumed. Writing the
// caller's object here would persist behind that gate and consume them anyway.
export function recordSuccess(filePath: string, nowIso: string): void {
  saveState(filePath, { ...loadState(filePath), last_success_at: nowIso });
}
