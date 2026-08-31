import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Imported at the top and typed, rather than require()d per test: the state
// literals below are then checked against ReportingState, so a field added to
// the interface fails here instead of being silently omitted by an `any`.
import {
  loadState,
  saveState,
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
  assert.deepEqual(state, { dev_stats_on: false, session_stats_on: false });
});

test("saveState and loadState roundtrip", () => {
  const filePath = tmpFile("tkmx-state-", "state.json");
  saveState(filePath, { dev_stats_on: true, session_stats_on: true });
  const loaded = loadState(filePath);
  assert.deepEqual(loaded, { dev_stats_on: true, session_stats_on: true });
});

test("computeTransitionMarkers: on→off emits clear signals", () => {
  const prior: ReportingState = { dev_stats_on: true, session_stats_on: true };
  const current: ReportingState = { dev_stats_on: false, session_stats_on: false };
  const markers = computeTransitionMarkers(prior, current);
  assert.equal(markers.clear_dev_stats, true);
  assert.strictEqual(markers.session_stats, null);  // explicit null = clear
});

test("computeTransitionMarkers: steady-state off → no markers", () => {
  const prior: ReportingState = { dev_stats_on: false, session_stats_on: false };
  const current: ReportingState = { dev_stats_on: false, session_stats_on: false };
  const markers = computeTransitionMarkers(prior, current);
  assert.equal(markers.clear_dev_stats, undefined);
  assert.equal("session_stats" in markers, false);
});

test("computeTransitionMarkers: steady-state on → no markers", () => {
  const prior: ReportingState = { dev_stats_on: true, session_stats_on: true };
  const current: ReportingState = { dev_stats_on: true, session_stats_on: true };
  const markers = computeTransitionMarkers(prior, current);
  assert.equal(Object.keys(markers).length, 0);
});

test("computeTransitionMarkers: only dev_stats toggled", () => {
  const prior: ReportingState = { dev_stats_on: true, session_stats_on: true };
  const current: ReportingState = { dev_stats_on: false, session_stats_on: true };
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
