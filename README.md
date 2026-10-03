# Claude Code mods

Mods for Claude Code: bands, panes, status lines and hooks, each written as a plugin of function hooks. This folder is also a plugin **marketplace**, so other people can install straight from GitHub.

## Layout

```
claude-code-mods/
  .claude-plugin/marketplace.json   lists every mod (add an entry per new mod)
  <mod-name>/
    .claude-plugin/plugin.json
    hooks/hooks.json, hooks/register.tsx
    types/index.d.ts                 when the mod keeps $.state
    tests/                           claude plugin test
    README.md
```

| Mod | What it does |
| --- | --- |
| [cost-meter](cost-meter/README.md) | Band above the prompt: session cost, plus git, CI, pull and push |

## Try one locally

```bash
claude --plugin-dir cost-meter
```

## Install

In Claude Code:

```
/plugin marketplace add juulsverne/claude-code-mods
/plugin install cost-meter@playground-mods
```

`/plugin marketplace update playground-mods` picks up new versions.

## Before sharing a mod

- `claude plugin validate <mod>` passes, with an `author` in `plugin.json`.
- `claude plugin test <mod>` passes.
- No secrets, tokens or personal paths in the source.
- Bump `version` in `plugin.json` when you change a mod, so installs pick up the update.

## Known limitations

- The function-hooks plugin API is early access and changes between Claude Code releases. The mods here were built against 2.1.286; people on other versions may hit load errors.
