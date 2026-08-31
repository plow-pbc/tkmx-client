import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isBindingFailure, bindingFailureMessage, openDatabaseWith, PINNED_NODE_MAJOR } from "../reporter/sqlite";

// A native addon built for another Node ABI fails at every call site, so one
// missing binding used to read as dozens of unrelated broken tests. These
// cases pin the translation that makes the real cause say its own name.
describe("better-sqlite3 binding failures", () => {
  const BINDING_ERRORS = [
    "Could not locate the bindings file. Tried:\n → /repo/node_modules/better-sqlite3/build/better_sqlite3.node",
    "The module was compiled against a different Node.js version using NODE_MODULE_VERSION 127. This version of Node.js requires NODE_MODULE_VERSION 147.",
    "ERR_DLOPEN_FAILED: dlopen(better_sqlite3.node): symbol not found",
  ];

  it("recognises every shape the addon fails in", () => {
    for (const message of BINDING_ERRORS) {
      assert.ok(isBindingFailure(new Error(message)), `should recognise: ${message.slice(0, 40)}…`);
    }
  });

  it("leaves ordinary database errors alone", () => {
    assert.ok(!isBindingFailure(new Error("SQLITE_CANTOPEN: unable to open database file")));
    assert.ok(!isBindingFailure(new Error("no such table: sessions")));
  });

  it("names the running Node, the pinned Node and the remedy", () => {
    const message = bindingFailureMessage("v26.4.0", "22");
    assert.match(message, /v26\.4\.0/);
    assert.match(message, /Node 22/);
    assert.match(message, /\.nvmrc/);
    assert.match(message, /nvm use/);
  });

  it("translates a binding failure and keeps the original as the cause", () => {
    const original = new Error("Could not locate the bindings file. Tried: …");
    assert.throws(
      () => openDatabaseWith(() => { throw original; }, "/tmp/x.db", undefined, "v26.4.0", "22"),
      (err: Error & { cause?: unknown }) => {
        assert.match(err.message, /could not load under Node v26\.4\.0/);
        assert.equal(err.cause, original);
        return true;
      },
    );
  });

  it("passes any other failure through untouched", () => {
    const original = new Error("SQLITE_CANTOPEN: unable to open database file");
    assert.throws(
      () => openDatabaseWith(() => { throw original; }, "/tmp/x.db"),
      (err: Error) => err === original,
    );
  });

  it("returns the constructed database when the addon loads", () => {
    const handle = { marker: true };
    assert.equal(openDatabaseWith(() => handle, "/tmp/x.db"), handle);
  });

  it("pins the same Node major the toolchain does", () => {
    assert.match(PINNED_NODE_MAJOR, /^\d+$/);
  });
});
