# Project Instructions for AI Agents

Agent guidance for this repository lives in [AGENTS.md](AGENTS.md) — read it first.
It covers the beads issue tracker (and why beads data must never be pushed to this
public remote) plus the non-interactive shell rules.

## Build & test

```bash
just test          # full suite
npm test           # same suite directly
npm run typecheck  # tsc --noEmit, src and tests
npm run build      # clean dist/ and compile
```
