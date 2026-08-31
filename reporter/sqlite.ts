import type Database from "better-sqlite3";

// better-sqlite3 is a native addon: it loads only against the Node ABI it was
// built for. When the host Node is a different major than the one this project
// pins (.nvmrc / package.json engines), every call site dies with a message
// about a "bindings file" that names neither Node nor the remedy — and since
// most of the suite opens a database somewhere, one missing addon reads as
// dozens of unrelated broken tests.
//
// openDatabase translates exactly that failure into a sentence that says which
// Node is running, which one the project builds against, and what to do. Any
// other error (a corrupt file, a bad path) is passed through untouched.
const BINDING_FAILURE = /could not locate the bindings file|ERR_DLOPEN_FAILED|NODE_MODULE_VERSION|invalid ELF header|was compiled against a different Node/i;

export type DatabaseCtor = typeof Database;

export function isBindingFailure(err: unknown): boolean {
  const message = err instanceof Error ? `${err.message}` : String(err);
  return BINDING_FAILURE.test(message);
}

export function bindingFailureMessage(nodeVersion: string, pinnedMajor: string): string {
  return [
    `better-sqlite3's native addon could not load under Node ${nodeVersion}.`,
    `This project builds it against Node ${pinnedMajor} (see .nvmrc and package.json "engines").`,
    `Run \`nvm use\` (or install Node ${pinnedMajor}) and re-run \`npm ci\`;`,
    "`npm rebuild better-sqlite3` only helps if your Node major has a prebuild or a working node-gyp.",
  ].join(" ");
}

export function openDatabaseWith<T>(
  ctor: (dbPath: string, options?: Database.Options) => T,
  dbPath: string,
  options?: Database.Options,
  nodeVersion: string = process.version,
  pinnedMajor: string = PINNED_NODE_MAJOR,
): T {
  try {
    return ctor(dbPath, options);
  } catch (err) {
    if (!isBindingFailure(err)) throw err;
    const translated = new Error(bindingFailureMessage(nodeVersion, pinnedMajor));
    (translated as Error & { cause?: unknown }).cause = err;
    throw translated;
  }
}

// Kept in step with .nvmrc and package.json "engines" by test/toolchain.test.ts.
export const PINNED_NODE_MAJOR = "22";

export function openDatabase(dbPath: string, options?: Database.Options): Database.Database {
  const Ctor = require("better-sqlite3") as DatabaseCtor;
  return openDatabaseWith((p, o) => new Ctor(p, o), dbPath, options);
}
