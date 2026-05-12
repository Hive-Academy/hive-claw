# Plugin install paths probe — TASK_2026_006 Batch 5b

Recorded: 2026-05-12. openclaw version: `2026.4.24`.

Probe script: `scripts/probe-plugin-install-paths.sh`. Tested install spec:
`@ollama/openclaw-web-search` (a real published openclaw plugin — the
slug used in the original amendment, `@openclaw/web-search`, does not
exist on the public npm registry).

## TL;DR

The amendment §9.1 volume layout is correct. User-installed plugins land
at `/home/agent/.openclaw/extensions/<plugin-id>/` exactly as planned.
**No changes to the compose volume targets are needed.**

## Where openclaw writes

| What | Path inside container | Covered by volume |
|---|---|---|
| Stock plugins (shipped with the openclaw npm package) | `/usr/lib/node_modules/openclaw/dist/extensions/` | image layer — no volume |
| User-installed plugins (npm/clawhub/marketplace) | `/home/agent/.openclaw/extensions/<plugin-id>/` | `openclaw-extensions` (and parent `openclaw-state`) |
| Plugin install metadata in main config | `/home/agent/.openclaw/openclaw.json` (`plugins.entries`, `plugins.installs`) | `openclaw-state` |
| Plugin runtime-deps cache (npm tarballs + cacache) | `/home/agent/.openclaw/plugin-runtime-deps/<version-hash>/` | `openclaw-state` |
| Config audit log | `/home/agent/.openclaw/logs/config-audit.jsonl` | `openclaw-state` |
| Config health snapshot | `/home/agent/.openclaw/logs/config-health.json` | `openclaw-state` |
| User-installed skills | not exercised by this probe (no skill-only install run) | `openclaw-skills` (mounted defensively per amendment §9.5) |

`openclaw plugins list` reports the source roots explicitly:

```
Source roots:
  stock:  /usr/lib/node_modules/openclaw/dist/extensions
  global: /home/agent/.openclaw/extensions
```

## Sample `openclaw plugins inspect` output for the installed plugin

```
Ollama Web Search
id: openclaw-web-search
Status: loaded
Source: ~/.openclaw/extensions/openclaw-web-search/index.ts
Origin: global
Version: 0.2.2
Install:
  Source: npm
  Spec: @ollama/openclaw-web-search
  Install path: ~/.openclaw/extensions/openclaw-web-search
  Recorded version: 0.2.2
  Installed at: 2026-05-12T18:23:32.651Z
```

## Sample `~/.openclaw/openclaw.json` fragment after install

```json
{
  "plugins": {
    "entries": {
      "openclaw-web-search": { "enabled": true }
    },
    "installs": {
      "openclaw-web-search": {
        "source": "npm",
        "spec": "@ollama/openclaw-web-search",
        "installPath": "/home/agent/.openclaw/extensions/openclaw-web-search",
        "version": "0.2.2",
        "resolvedSpec": "@ollama/openclaw-web-search@0.2.2",
        "integrity": "sha512-h0D3z36BH0ZDN2a9toAwO/1F2dLLpE0zkC3DgRHhA4kfO9d9eomXhmdmPKWtS612DasOX2Gla8hWWxScnfK1Ug==",
        "installedAt": "2026-05-12T18:23:32.651Z"
      }
    }
  }
}
```

## Diff of the home dir (excluding the runtime-deps npm cache)

```
/home/agent/.openclaw
/home/agent/.openclaw/extensions
/home/agent/.openclaw/extensions/openclaw-web-search
/home/agent/.openclaw/extensions/openclaw-web-search/README.md
/home/agent/.openclaw/extensions/openclaw-web-search/index.ts
/home/agent/.openclaw/extensions/openclaw-web-search/openclaw.plugin.json
/home/agent/.openclaw/extensions/openclaw-web-search/package.json
/home/agent/.openclaw/logs
/home/agent/.openclaw/logs/config-audit.jsonl
/home/agent/.openclaw/logs/config-health.json
/home/agent/.openclaw/openclaw.json
/home/agent/.openclaw/plugin-runtime-deps
/home/agent/.npm/_cacache/...     # npm side-effects (not openclaw-owned)
```

## Volume verdict

The compose file ships with these named volumes (per amendment §9.1):

```yaml
volumes:
  openclaw-state:        # /home/agent/.openclaw/     — config + logs + runtime-deps cache
  openclaw-extensions:   # /home/agent/.openclaw/extensions/ — user-installed plugins
  openclaw-skills:       # /home/agent/.openclaw/skills/    — user-installed skills
  openclaw-data:         # /data/                        — daemon SQLite
```

Both `openclaw-state` AND `openclaw-extensions` cover the `extensions/`
path because compose's "longest-prefix-wins" rule makes the nested
`openclaw-extensions` mount the authoritative one. The defensive nesting
is what amendment §9.5 calls "belt-and-braces" — if `openclaw-state`'s
mount is ever changed or removed, installed plugins still survive.

## Notes

- The original amendment used the slug `npm:@openclaw/web-search`. The
  installed CLI rejects `npm:` as a "protocol spec" and reports it as a
  not-found hook pack. The correct invocation is the bare npm spec, e.g.
  `openclaw plugins install @ollama/openclaw-web-search`. Updated the
  probe script and Batch 8b documentation to use the bare spec.
- The probe does **not** require the openclaw runtime to be running — it
  exercises the install path resolver against a fresh container. This is
  exactly the scenario the daemon's install pipeline (Batch 8b §16.5)
  needs to verify against.
- `plugin-runtime-deps/` is large (~5MB+ per install transaction).
  Backup operators should snapshot `openclaw-state` only if they want
  the cache to come along — or restore from `openclaw-extensions` plus
  rebuild the cache on next startup. Operationally either is fine.
