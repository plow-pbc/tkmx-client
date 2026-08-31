import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { PINNED_NODE_MAJOR } from "../reporter/sqlite";

// better-sqlite3 is a native addon with prebuilds for one Node major at a
// time, so the supported major is a real constraint — but it used to live
// only in a comment in the CI workflow. Nothing a contributor's tooling reads
// (.nvmrc, package.json "engines") said it, and picking the wrong Node turned
// one unbuildable addon into a suite-wide failure. These cases keep the three
// declarations from drifting apart.
const ROOT = path.join(__dirname, "..", "..");

function majorOf(value: string): string {
  const m = value.trim().match(/(\d+)/);
  assert.ok(m, `expected a version major in ${JSON.stringify(value)}`);
  return m![1];
}

describe("pinned Node toolchain", () => {
  const nvmrc = fs.readFileSync(path.join(ROOT, ".nvmrc"), "utf-8");
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8")) as {
    engines?: { node?: string };
  };
  const ci = fs.readFileSync(path.join(ROOT, ".github", "workflows", "ci.yml"), "utf-8");

  it("declares a Node major in package.json engines", () => {
    assert.ok(pkg.engines?.node, 'package.json needs an "engines".node range');
  });

  it("agrees across .nvmrc, engines and the CI workflow", () => {
    const ciVersions = [...ci.matchAll(/node-version:\s*'?"?(\d+)/g)].map((m) => m[1]);
    assert.ok(ciVersions.length > 0, "CI workflow should set a node-version");

    const expected = majorOf(nvmrc);
    assert.equal(majorOf(pkg.engines!.node!), expected, "package.json engines disagrees with .nvmrc");
    for (const version of ciVersions) {
      assert.equal(version, expected, "CI node-version disagrees with .nvmrc");
    }
  });

  it("is the major the sqlite loader tells people to use", () => {
    assert.equal(PINNED_NODE_MAJOR, majorOf(nvmrc));
  });
});
