# ptah CLI Source Dive: Internals Analysis

This document details the implementation of specific commands and configurations within the `ptah-cli` based on a deep dive into the source code of `main.mjs`.

## 1. The `setup` command implementation

The `setup` command is implemented in the `Nk` function. It orchestrates a 5-phase workflow using a helper function `wl` for execution tracking and rollback management.

**Action Handler (`Nk`):**
```javascript
// Line 2246
async function Nk(o,e,t={}){
  // ... (setup context)
  try{
    return await n(e,{mode:"full"},async f=>{
      // ...
      let M=await wl("analyze",{kind:"sync",run:()=>Cl(f.transport,"wizard:deep-analyze",{})},{formatter:r});
      // ...
      let O=await wl("recommend",{kind:"sync",run:()=>Cl(f.transport,"wizard:recommend-agents",T)},{formatter:r});
      // ...
      let X=await wl("install_pack",{kind:"sync",run:async()=>{ ... }});
      // ...
      let Q=await wl("generate",{kind:"async-broadcast",run:()=>Cl(f.transport,"wizard:submit-selection", ... ),completionEvent:"setup-wizard:generation-complete", ... });
      // ...
      let V=await wl("apply_harness",{kind:"sync",run:async()=>{let U=await Cl(f.transport,"harness:apply", ... ) }});
      // ...
    })
  }
}
```

**Implementation Details:**
- **Phases:**
  1. `analyze`: Calls `wizard:deep-analyze`.
  2. `recommend`: Calls `wizard:recommend-agents`.
  3. `install_pack`: Calls `wizard:list-agent-packs` and `wizard:install-pack-agents`.
  4. `generate`: Calls `wizard:submit-selection` and waits for the `setup-wizard:generation-complete` broadcast event.
  5. `apply_harness`: Calls `harness:apply`.
- **JSON-RPC Methods:** `wizard:deep-analyze`, `wizard:recommend-agents`, `wizard:list-agent-packs`, `wizard:install-pack-agents`, `wizard:submit-selection`, `harness:apply`.
- **Events Emitted:** `setup.complete`, `setup.phase.error`. It also uses `setup.phase.start` and `setup.phase.complete` via the `wl` helper.
- **Input:** It is strictly fire-and-forget from the user's perspective (non-interactive end-to-end), though it waits internally for the generation phase.

---

## 2. The `harness analyze-intent` command

The `analyze-intent` command is implemented in the `XF` function.

**Action Handler (`XF`):**
```javascript
// Line 2162 / 2239
async function XF(o,e,t,r,s){
  if(!o.intent||o.intent.trim().length<10)return r.write(`ptah harness analyze-intent: --intent <text> is required (min 10 chars)\n`),v.UsageError;
  return s(e,{mode:"full"},async c=>{
    let d=await Nr(c.transport,"harness:analyze-intent",{intent:o.intent});
    return await t.writeNotification("harness.intent.analysis",{...d}),v.Success
  })
}
```

**Implementation Details:**
- **JSON-RPC Method:** `harness:analyze-intent`.
- **Events Emitted:** `harness.intent.analysis`.
- **Event Shape:** Forwards the result object from the RPC call (likely containing persona, suggested agents, skills, and MCP servers).

---

## 3. The `wizard submit-selection` command

The `submit-selection` command is implemented in the `XH` function.

**Action Handler (`XH`):**
```javascript
// Line 2240
async function XH(o,e,t,r,s,n){
  if(!o.file||o.file.trim().length===0)return r.write(`ptah wizard submit-selection: --file <path> is required\n`),v.UsageError;
  // ... (reads file and validates payload)
  return s(e,{mode:"full"},async a=>{
    let l=await Qf(a.transport,"wizard:submit-selection",i.payload);
    return await t.writeNotification("wizard.selection.submitted",{...l}),v.Success
  })
}
```

**Implementation Details:**
- **JSON Shape:** Validated by `sj` function (line 2246). Requires `selectedAgentIds` (non-empty `string[]`). Optional: `threshold` (number), `variableOverrides` (object), `analysisData` (object), `analysisDir` (string), `model` (string).
- **Correlation:** The command itself is fire-and-forget, but callers (like `ptah setup`) correlate the response by waiting for the `setup-wizard:generation-complete` broadcast event.

---

## 4. The `interact` command

The `interact` command is implemented in the `kk` function.

**Action Handler (`kk`):**
```javascript
// Line 2178
async function kk(o,e,t={}){
  // ...
  await s(e,{mode:"full"},async h=>{
    // ...
    let K=t.server??new xd,
    // ...
    let ne=new Nn(h.pushAdapter,X),W;
    W=new fl(h.pushAdapter,X,pe),W.attach();
    // ...
  })
}
```

**Implementation Details:**
- **JSON-RPC Methods (Stdin):**
  - Registered by `fl` (Approval Bridge): `permission.response` and `question.response`.
  - Registered by `Nn` (Chat Bridge): It notifies `agent.thought`, `agent.message`, `agent.tool_use`, `agent.tool_result`.
- **Schema:** JSON-RPC 2.0 (`jsonrpc: "2.0"`, `id`, `method`, `params`).
- **User Input Injection:**
  - `permission.response`: Allows responding to `permission:request` events (allow/deny).
  - `question.response`: Allows responding to `ask-user-question:request` events.

---

## 5. The `--profile` flag

The `--profile` flag is used across several commands to select agent presets.

**Implementation Details:**
- **`session start`**:
  ```javascript
  // Line 2265 range
  x=E.profile==="claude_code"||E.profile==="enhanced"?E.profile:void 0,
  se=await Ft({subcommand:"start",profile:x, ... })
  ```
  The CLI explicitly checks for `claude_code` or `enhanced`.
- **`harness chat`**:
  ```javascript
  // Line 2162 range
  function YF(o){return{task:o.task,profile:o.profile,session:o.session,autoApprove:o.autoApprove}}
  async function QF(o,e,t={}){return(t.executeSessionStart??Sl)({task:o.task,profile:o.profile,scope:"harness-skill",resumeId:o.session,cwd:e.cwd},e)}
  ```
  The profile is passed to `Sl`, which then validates it against the allowlist before starting the session.

---

## 6. Subagent loading

Subagent loading logic involves scanning specific directories for `.md` files containing frontmatter.

**Implementation Details:**
- **Global Path:** `~/.ptah/templates/agents/` (Resolved in `kl` class, line 2109).
- **Workspace Path:** `.claude/agents/` (Used in `Nk` and `getStatus`, line 2246/2240).
- **File Format:** Markdown files with YAML-like frontmatter.
- **Search terms:** The code scans `~/.ptah/templates/agents` for templates and `.claude/agents` for project-specific agents.

---

## 7. Config dir resolution

Config directory resolution is handled by the `Gn` (Settings Manager) and `kl` (Content Download) classes.

**Implementation Details:**
- **Default Resolution:** `join(homedir(), ".ptah")`.
- **Env Var:** Not explicitly used for the root dir in the searched sections, but `--config` CLI flag overrides the settings file path.
- **Scope:** Scopes settings (`settings.json`), plugins (`plugins/`), templates (`templates/agents/`), and analyses (`analyses/`).

---

## 8. The `--scope harness-skill` mode

The `scope` parameter is used in `session start`.

**Implementation Details:**
- `harness chat` is an alias that sets `--scope harness-skill`.
- This is forwarded to the `session:start` RPC call.
- Behavior change: In the backend, the `scope` likely triggers the loading of specialized tools or a different system prompt environment (e.g., enabling `harness:*` tools).
