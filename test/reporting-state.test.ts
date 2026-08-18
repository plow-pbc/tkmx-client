import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Imported at the top and typed, rather than require()d per test: the state
// literals below are then checked against ReportingState, so a field added to
// the interface (last_success_at was) fails here instead of being silently
// omitted by an `any`.
import {
  loadState,
  saveState,
  recordSuccess,
  computeTransitionMarkers,
  gateOnSnapshotHash,
  type ReportingState,
} from "../reporter/reporting-state";

function tmpFile(prefix: string, name: string): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), prefix)), name);
}

test("loadState returns defaults when file absent", () => {
  const filePath = tmpFile("tkmx-state-", "state.json");
  const state = loadState(filePath);
  assert.deepEqual(state, { dev_stats_on: false, session_stats_on: false, last_success_at: null });
});

test("saveState and loadState roundtrip", () => {
  const filePath = tmpFile("tkmx-state-", "state.json");
  saveState(filePath, { dev_stats_on: true, session_stats_on: true, last_success_at: null });
  const loaded = loadState(filePath);
  assert.deepEqual(loaded, { dev_stats_on: true, session_stats_on: true, last_success_at: null });
});

test("computeTransitionMarkers: on→off emits clear signals", () => {
  const prior: ReportingState = { dev_stats_on: true, session_stats_on: true, last_success_at: null };
  const current: ReportingState = { dev_stats_on: false, session_stats_on: false, last_success_at: null };
  const markers = computeTransitionMarkers(prior, current);
  assert.equal(markers.clear_dev_stats, true);
  assert.strictEqual(markers.session_stats, null);  // explicit null = clear
});

test("computeTransitionMarkers: steady-state off → no markers", () => {
  const prior: ReportingState = { dev_stats_on: false, session_stats_on: false, last_success_at: null };
  const current: ReportingState = { dev_stats_on: false, session_stats_on: false, last_success_at: null };
  const markers = computeTransitionMarkers(prior, current);
  assert.equal(markers.clear_dev_stats, undefined);
  assert.equal("session_stats" in markers, false);
});

test("computeTransitionMarkers: steady-state on → no markers", () => {
  const prior: ReportingState = { dev_stats_on: true, session_stats_on: true, last_success_at: null };
  const current: ReportingState = { dev_stats_on: true, session_stats_on: true, last_success_at: null };
  const markers = computeTransitionMarkers(prior, current);
  assert.equal(Object.keys(markers).length, 0);
});

test("computeTransitionMarkers: only dev_stats toggled", () => {
  const prior: ReportingState = { dev_stats_on: true, session_stats_on: true, last_success_at: null };
  const current: ReportingState = { dev_stats_on: false, session_stats_on: true, last_success_at: null };
  const markers = computeTransitionMarkers(prior, current);
  assert.equal(markers.clear_dev_stats, true);
  assert.equal("session_stats" in markers, false);
});

// The bug these pin is invisible by construction: a snapshot recorded as
// delivered before the request succeeded makes the next run omit it, so the
// server stays stale and nothing logs an error. Nothing else in the suite
// reaches this path — report-e2e sets REPORT_MACHINE_CONFIG=false precisely so
// the reporter never touches the hash file — so without these a refactor that
// moved the write back to collection time would go green.
test("gateOnSnapshotHash does not write the hash until commit is called", () => {
  const hashFile = tmpFile("tkmx-gate-", ".hash");

  const gate = gateOnSnapshotHash({ cpu: "M1" }, hashFile);
  assert.equal(fs.existsSync(hashFile), false, "hash written before delivery was confirmed");

  gate.commit();
  assert.equal(fs.existsSync(hashFile), true);
});

test("gateOnSnapshotHash re-offers an uncommitted snapshot on the next run", () => {
  const hashFile = tmpFile("tkmx-gate-", ".hash");

  // First run collects but delivery fails, so commit() never runs.
  assert.notEqual(gateOnSnapshotHash({ cpu: "M1" }, hashFile), null);
  // The next run must still see it as unsent, or the server never receives it.
  const second = gateOnSnapshotHash({ cpu: "M1" }, hashFile);
  assert.notEqual(second, null);
  second.commit();
});

test("gateOnSnapshotHash returns null once an unchanged snapshot is committed", () => {
  const hashFile = tmpFile("tkmx-gate-", ".hash");

  gateOnSnapshotHash({ cpu: "M1" }, hashFile).commit();
  assert.equal(gateOnSnapshotHash({ cpu: "M1" }, hashFile), null);
});

test("gateOnSnapshotHash offers again when the snapshot changes", () => {
  const hashFile = tmpFile("tkmx-gate-", ".hash");

  gateOnSnapshotHash({ skills: ["a"] }, hashFile).commit();
  assert.notEqual(gateOnSnapshotHash({ skills: ["a", "b"] }, hashFile), null);
});


// ---------------------------------------------------------------------------
// last_success_at — the only local evidence that the reporter is still alive.
// A daemon whose launchd/systemd unit stopped firing leaves no error anywhere,
// so "when did this last work" is what separates a broken collector from a
// builder who took the week off. See reporter/doctor.ts.
// ---------------------------------------------------------------------------

test("last_success_at defaults to null when the state file predates the field", () => {
  const filePath = tmpFile("tkmx-state-", "state.json");
  // Written by an older reporter: no last_success_at key at all.
  fs.writeFileSync(filePath, JSON.stringify({ dev_stats_on: true, session_stats_on: true }), "utf-8");

  const state = loadState(filePath);
  assert.equal(state.last_success_at, null);
  // The pre-existing fields must survive the upgrade untouched.
  assert.equal(state.dev_stats_on, true);
  assert.equal(state.session_stats_on, true);
});

test("saveState persists last_success_at rather than normalizing it away", () => {
  const filePath = tmpFile("tkmx-state-", "state.json");

  saveState(filePath, { dev_stats_on: false, session_stats_on: false, last_success_at: "2026-08-18T00:00:00.000Z" });
  assert.equal(loadState(filePath).last_success_at, "2026-08-18T00:00:00.000Z");
});

test("a non-string last_success_at reads as never, not as fresh", () => {
  const filePath = tmpFile("tkmx-state-", "state.json");
  // Coercing a number here would manufacture a bogus freshness and hide
  // exactly the staleness this field exists to expose.
  fs.writeFileSync(filePath, JSON.stringify({ last_success_at: 12345 }), "utf-8");

  assert.equal(loadState(filePath).last_success_at, null);
});

test("recordSuccess stamps the timestamp without disturbing the persisted toggles", () => {
  const filePath = tmpFile("tkmx-state-", "state.json");

  saveState(filePath, { dev_stats_on: true, session_stats_on: true, last_success_at: null });
  recordSuccess(filePath, "2026-08-18T12:00:00.000Z");

  const after = loadState(filePath);
  assert.equal(after.last_success_at, "2026-08-18T12:00:00.000Z");
  assert.equal(after.dev_stats_on, true);
  assert.equal(after.session_stats_on, true);
});

// report.ts calls recordSuccess on a path where the in-memory state has
// deliberately NOT been persisted: a frozen profile answers 200 without
// applying anything, so saveState is withheld to keep the one-shot transition
// markers unconsumed. recordSuccess must not become a back door that persists
// the toggles that gate was holding back.
test("recordSuccess does not persist toggles the caller never wrote", () => {
  const filePath = tmpFile("tkmx-state-", "state.json");

  saveState(filePath, { dev_stats_on: false, session_stats_on: false, last_success_at: null });
  recordSuccess(filePath, "2026-08-18T12:00:00.000Z");

  const after = loadState(filePath);
  assert.equal(after.dev_stats_on, false);
  assert.equal(after.session_stats_on, false);
});

test("recordSuccess overwrites an earlier success stamp", () => {
  const filePath = tmpFile("tkmx-state-", "state.json");

  saveState(filePath, { dev_stats_on: false, session_stats_on: false, last_success_at: "2026-08-01T00:00:00.000Z" });
  recordSuccess(filePath, "2026-08-18T12:00:00.000Z");

  assert.equal(loadState(filePath).last_success_at, "2026-08-18T12:00:00.000Z");
});
