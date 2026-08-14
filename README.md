# dsh-orchestrator

Native full-mesh agent orchestration for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness):
one master agent decomposes and dispatches, many worker agents do the hands-on work, and **any agent
can message any other agent natively** — master → worker, worker → master, worker ↔ worker —
with per-worker model and reasoning-effort assignment.

No file mailboxes, no prompt conventions, no polling. Messages ride the harness's own agent inbox,
the single turn FIFO of the agent loop.

## Features

- **`agent_spawn`** — create a continuable worker agent with an optional **per-worker
  `provider` / `model` / `maxTokens`** and a per-worker **`effort`** (reasoning effort). Falls back
  to the spawner's route for anything you omit.
- **`agent_send`** — message any live mesh agent by id. A running target queues the message for its
  next turn; an idle target wakes to process it.
- **`agent_broadcast`** — reach every live mesh agent at once (minus exclusions).
- **`agent_list`** — the live roster: id, label, status, parent, master flag.
- **`{{mesh_self}}` / `{{mesh_master}}` prompt variables** — every agent learns its own id and its
  mesh root, so workers can address the master without being told.
- **Mesh-orientation prompt section** — a built-in orchestration protocol (decompose → parallel
  dispatch → workers report back → master aggregates), overridable per row through `orientation`.

## How it works

The harness core already ships an inbox-based message system: `Agent.followup()` inserts a message
into the target's turn FIFO and wakes it. The official `send_message` tool is a thin adapter over
`ctx.subagents.followup()` that additionally enforces *direct-parent* authorization. This plugin
sidesteps that restriction deliberately: mesh tools resolve the live target through the host
`agents` registry (`ctx.agents.get(id)`) and deliver through the raw inbox — which is exactly what
makes worker ↔ worker messaging possible.

Per-worker **model** rides the official `SubagentStartRequest.agentOptions`
(`resolveChildAgentOptions`: requested value wins, parent's route is the fallback, persisted in the
child's durable descriptor). Per-worker **reasoning effort** has no `AgentOptions` field, so it is
applied per request through the `agent/request` waterfall — one listener covers the master and
every worker, because children bind to the parent's standing composition
(`agentPresets.composeFrom`) and the scope carrier routes agent events up that chain.

**Mesh membership** is the spawner tree rooted at the caller's root. The `agents` registry is
process-global, so agents of unrelated sessions are never listed, messaged, or broadcast to.

## Install

There are **two install methods** — npm and GitHub — and two activation scopes — bundle
(every session on the profile) or preset-only (one dedicated orchestration preset). Pick one
method, then one scope.

| | Method 1: npm (recommended) | Method 2: GitHub |
| --- | --- | --- |
| Command | `dsh plugin --profile <name> add dsh-orchestrator` | `dsh plugin --profile <name> add github:zibo2025/dsh-agent-mesh#v0.1.0` |
| What you get | Pre-built `lib/` from the registry | Source checkout, built on your machine |
| Prerequisites | Nothing | pnpm runs this package's self-contained `prepare` build — pnpm ≥ 10 requires a one-time `allowBuilds` authorization (see below) |
| Best for | Everyone; zero friction | Users without an npm account, or who want to audit/fork the source |

### Method 1: npm (recommended)

The published tarball ships pre-built `lib/`, so users need no build authorization and no
toolchain:

```bash
dsh plugin --profile <name> add dsh-orchestrator
```

> China mirror note: if your npm is configured against a read-only mirror (e.g. npmmirror) and the
> package is not synced yet, install with the official registry:
> `dsh plugin --profile <name> add dsh-orchestrator --registry=https://registry.npmjs.org`.
> Publishing always targets the official registry — the package pins
> `publishConfig.registry`, mirrors never accept publishes.

### Method 2: GitHub (no npm account needed)

Git installs pull the **source**, not build artifacts, so pnpm runs this package's `prepare`
script (a self-contained `tsc`) after installing — and pnpm ≥ 10 refuses to run it until the
profile explicitly authorizes the build. Pin a tag or commit so later pushes cannot silently
change what runs:

```bash
dsh plugin --profile <name> add github:zibo2025/dsh-agent-mesh#v0.1.0
```

On pnpm ≥ 10 the first `add` fails on purpose; copy the exact package key it prints into the
profile's `pnpm-workspace.yaml`, then run the same command again:

```yaml
# <profile>/pnpm-workspace.yaml
allowBuilds:
  dsh-orchestrator: true
```

### Activation scope: every session, or one preset

Both methods above install the **bundle**, whose patch layer inserts the mesh row globally:
**every session on that profile** gets the mesh tools.

To scope the mesh to a dedicated orchestration preset instead (recommended setup: the master/
worker protocol only applies where you want it):

1. Copy a preset (e.g. the shipped `standard`) to a new id and add the row:

   ```yaml
   - id: orchestrator
     name: dsh-orchestrator
   ```

   The plugin publishes no service and only consumes host-plane registries
   (`tools`, `agents`, `subagents`, `systemPrompt`), so it needs **no isolate realm**:
   one instance per standing mount serves the whole agent tree.

2. Make the package resolvable by the profile that launches the preset, **without** activating
   the bundle layer:

   ```bash
   cd "$DSH_HOME/profiles/<name>" && pnpm add dsh-orchestrator
   ```

   (Works for the GitHub method too: `pnpm add github:zibo2025/dsh-agent-mesh#v0.1.0` with the
   same `allowBuilds` authorization.)

## Tools

### agent_spawn

| Parameter | Required | Description |
| --- | --- | --- |
| `label` | yes | Short display label for the worker. |
| `prompt` | yes | Complete, self-contained task; the mesh briefing is appended automatically. |
| `provider` | no | LLM provider route for this worker only. |
| `model` | no | Model id for this worker only. |
| `maxTokens` | no | Max output tokens per request for this worker only. |
| `effort` | no | Reasoning effort for this worker only. |

Returns `{ childId, messageId }`. The child id is durable and stable across activations.

### agent_send

| Parameter | Required | Description |
| --- | --- | --- |
| `agent_id` | yes | Target agent id (childId, master id, or an id from `agent_list`). |
| `message` | yes | Message content. |

Returns `{ delivered, reason? }`. Delivery fails with a reason when the target is not online
(settled/disposed/unknown), not in your mesh, or is yourself. No reply is returned — the receiver
answers by sending a message back.

### agent_broadcast

| Parameter | Required | Description |
| --- | --- | --- |
| `message` | yes | Message content for every mesh agent. |
| `exclude` | no | Agent ids to skip (the caller is always skipped). |

Returns `{ deliveries: [{ agentId, delivered }] }`.

### agent_list

No parameters. Returns `{ agents: [{ agentId, label?, status, parent?, master, self }] }`.

## Reasoning effort

`effort` is an **adapter-owned identifier**, validated by the selected provider adapter at call
time. For the DeepSeek adapter the legal values are:

| Value | Meaning |
| --- | --- |
| `off` | Thinking disabled. |
| `high` | Thinking enabled, high effort. |
| `max` | Thinking enabled, maximum effort. |

## Semantics and limitations

- **Turn-based, not real-time.** A message becomes the target's *next turn*; it can never
  interrupt a model call in flight. The deeper `steer`/`inject` inbox targets exist in the core but
  are intentionally not exposed.
- **Online targets only.** A settled (finished) worker leaves the live registry; messaging it
  reports `not online`. Re-spawn a fresh worker when you need it again.
- **Mesh = your spawner tree.** Agents of other sessions (even on the same preset) are invisible
  to your mesh.
- **Effort applies per request**, so changing it mid-flight is not possible through the tool; spawn
  a new worker with the new effort.
- One plugin instance per mounting composition; state is per-session by construction.

## Development

```bash
npm install
npm run build        # tsc → lib/
```

Local preset development: reference the built entry from the preset row with a cache-busting
version query (the loader caches module URLs):

```yaml
- id: orchestrator
  name: '../../../path/to/dsh-agent-mesh/lib/index.js?v=1'
```

Bump `?v=` after every rebuild, then mount-validate the preset
(`agentPresets.standingKeyFor`). After publishing, switch the row to the bare package name
`dsh-orchestrator`.

## License

MIT
