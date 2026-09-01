# Agent Instructions

## Beads issue tracker

This project tracks work in **bd (beads)**. Run `bd prime` for the full command
reference and workflow — do not restate it here. Deeper guidance lives in the one
canonical surface, `.agents/skills/beads/SKILL.md`.

Use `bd` for all task tracking; do not keep markdown TODO lists. Use `bd remember`
for persistent project knowledge; do not create ad hoc memory files.

### Never sync beads data to this repository's remote

`origin` (`plow-pbc/tkmx-client`) is **public**. `bd dolt push` publishes the beads
database under `refs/dolt/data` on whichever remote it targets, which would disclose
every issue title, body, and comment — including anything pasted into a task.

- Do **not** run `bd dolt push` / `bd dolt pull` against `origin`.
- Cross-machine sync requires an approved **private** Dolt remote configured out of
  band. Until one is configured, beads stays local to the machine.

`.beads/config.yaml` is untracked for the same reason: `bd config set github.token`
and `bd config set linear.api_key` write secrets into it. Keep credentials in the
`GITHUB_TOKEN` / `LINEAR_API_KEY` environment variables instead.

## Non-interactive shell commands

**Always use non-interactive flags** with file operations. `cp`, `mv`, and `rm` may
be aliased to `-i` on some systems, which hangs an agent forever on a y/n prompt.

```bash
cp -f source dest           # NOT: cp source dest
mv -f source dest           # NOT: mv source dest
rm -f file                  # NOT: rm file
rm -rf directory            # NOT: rm -r directory
cp -rf source dest          # NOT: cp -r source dest
```

Others that may prompt: `scp` and `ssh` (use `-o BatchMode=yes`), `apt-get` (use
`-y`), `brew` (set `HOMEBREW_NO_AUTO_UPDATE=1`).
