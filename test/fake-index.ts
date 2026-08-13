import * as fs from "node:fs";
import * as path from "node:path";

// Minimal stand-in for the AgentsView index that discoverAgents() reads.
// Only the two columns discovery touches; the real sessions table is far
// wider, and depending on the rest of it would make these tests track
// AgentsView's schema for no added guarantee.
export function writeFakeIndex(dataDir: string, agents: string[]): void {
  fs.mkdirSync(dataDir, { recursive: true });
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Database = require("better-sqlite3");
  const db = new Database(path.join(dataDir, "sessions.db"));
  try {
    db.exec("CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, agent TEXT)");
    const insert = db.prepare("INSERT OR REPLACE INTO sessions (id, agent) VALUES (?, ?)");
    agents.forEach((agent, i) => insert.run(`s${i}`, agent));
  } finally {
    db.close();
  }
}
