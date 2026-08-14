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

### As an agent preset (recommended)

1. Copy a preset (e.g. the shipped `standard`) to a new id and add the row:

   ```yaml
   - id: orchestrator
     name: dsh-orchestrator
   ```

   The plugin publishes no service and only consumes host-plane registries
   (`tools`, `agents`, `subagents`, `systemPrompt`), so it needs **no isolate realm**:
   one instance per standing mount serves the whole agent tree.

2. Install the package into the profile that launches the preset so the row resolves:

   ```bash
   dsh plugin --profile <name> add dsh-orchestrator
   ```

### As a bundle in a profile

The package declares `dsh.bundle`, so installing it contributes its patch layer automatically:

```bash
dsh plugin --profile <name> add dsh-orchestrator
```

Every session on that profile then has the mesh tools available.

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
