# dsh-orchestrator

Native full-mesh agent orchestration for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness):
one master agent decomposes and dispatches, many worker agents do the hands-on work, and **any agent
can message any other agent natively** — master → worker, worker → master, worker ↔ worker —
with per-worker model and reasoning-effort assignment.

> 面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的原生全互联智能体编排插件：
> 一个主智能体负责分解与分派，多个 worker 智能体负责实际执行，**任意智能体之间都能原生互发消息**
> ——主 → 子、子 → 主、子 ↔ 子——并支持为每个 worker 单独指定模型与思考强度。

No file mailboxes, no prompt conventions, no polling. Messages ride the harness's own agent inbox,
the single turn FIFO of the agent loop.

> 没有文件信箱、没有提示词约定、没有轮询。消息直接走 harness 自带的智能体收件箱
> ——智能体循环中唯一的回合 FIFO 队列。

## Features · 功能特性

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

> - **`agent_spawn`** — 创建可持续运行的 worker 智能体，可选地为**该 worker 单独**指定
>   `provider` / `model` / `maxTokens` 与**思考强度 `effort`**；未指定的项回退到派生者的路由。
> - **`agent_send`** — 按 id 给网格中任意在线智能体发消息：目标正在运行则排入其下一回合，
>   目标空闲则被唤醒处理。
> - **`agent_broadcast`** — 一次广播到网格中所有在线智能体（可排除指定 id）。
> - **`agent_list`** — 实时花名册：id、标签、状态、父级、是否为主智能体。
> - **`{{mesh_self}}` / `{{mesh_master}}` 提示词变量** — 每个智能体都能获知自己的 id 与网格根节点，
>   worker 无需被告知就能给主智能体发消息。
> - **网格协作提示词段** — 内置编排协议（分解 → 并行分派 → worker 回报 → 主智能体汇总），
>   可通过行配置 `orientation` 覆盖。

## How it works · 工作原理

The harness core already ships an inbox-based message system: `Agent.followup()` inserts a message
into the target's turn FIFO and wakes it. The official `send_message` tool is a thin adapter over
`ctx.subagents.followup()` that additionally enforces *direct-parent* authorization. This plugin
sidesteps that restriction deliberately: mesh tools resolve the live target through the host
`agents` registry (`ctx.agents.get(id)`) and deliver through the raw inbox — which is exactly what
makes worker ↔ worker messaging possible.

> harness 内核本身就内置了基于收件箱的消息系统：`Agent.followup()` 把消息插入目标的回合 FIFO 并唤醒它。
> 官方 `send_message` 工具只是 `ctx.subagents.followup()` 之上的一层薄适配器，额外强制了「直接父级」授权。
> 本插件有意绕过这层限制：网格工具通过宿主 `agents` 注册表（`ctx.agents.get(id)`）解析在线目标，
> 并经由原始收件箱投递——这正是子 ↔ 子通信得以实现的原因。

Per-worker **model** rides the official `SubagentStartRequest.agentOptions`
(`resolveChildAgentOptions`: requested value wins, parent's route is the fallback, persisted in the
child's durable descriptor). Per-worker **reasoning effort** has no `AgentOptions` field, so it is
applied per request through the `agent/request` waterfall — one listener covers the master and
every worker, because children bind to the parent's standing composition
(`agentPresets.composeFrom`) and the scope carrier routes agent events up that chain.

> 按 worker 指定**模型**走的是官方 `SubagentStartRequest.agentOptions` 路径
> （`resolveChildAgentOptions`：显式指定者优先、父级路由回退、随子代理的持久化描述符留存）。
> 而**思考强度**在 `AgentOptions` 中没有对应字段，因此通过 `agent/request` waterfall 按请求施加——
> 一个监听器即可覆盖主智能体与全部 worker：子代理会绑定到父级的 standing 组合
> （`agentPresets.composeFrom`），scope carrier 沿该链路由智能体事件。

**Mesh membership** is the spawner tree rooted at the caller's root. The `agents` registry is
process-global, so agents of unrelated sessions are never listed, messaged, or broadcast to.

> **网格成员**即「以调用者根节点为根的派生树」。`agents` 注册表是进程全局的，
> 因此无关会话的智能体永远不会被列出、被发消息或被广播。

## Install · 安装

There are **two install methods** — npm and GitHub — and two activation scopes — bundle
(every session on the profile) or preset-only (one dedicated orchestration preset). Pick one
method, then one scope.

> 有**两种安装方式**——npm 与 GitHub——以及两种生效范围——bundle（该 profile 的所有会话）
> 或仅预设（一个专门的编排预设）。先选一种方式，再选一种范围。

| | Method 1: npm (recommended) | Method 2: GitHub |
| --- | --- | --- |
| Command | `dsh plugin --profile <name> add dsh-orchestrator` | `dsh plugin --profile <name> add github:zibo2025/dsh-agent-mesh#v0.1.0` |
| What you get | Pre-built `lib/` from the registry | Source checkout, built on your machine |
| Prerequisites | Nothing | pnpm runs this package's self-contained `prepare` build — pnpm ≥ 10 requires a one-time `allowBuilds` authorization (see below) |
| Best for | Everyone; zero friction | Users without an npm account, or who want to audit/fork the source |

> | | 方式一：npm（推荐） | 方式二：GitHub |
> | --- | --- | --- |
> | 命令 | `dsh plugin --profile <name> add dsh-orchestrator` | `dsh plugin --profile <name> add github:zibo2025/dsh-agent-mesh#v0.1.0` |
> | 拿到什么 | registry 上预构建好的 `lib/` | 源码检出，在你的机器上构建 |
> | 前置条件 | 无 | pnpm 会运行本包自包含的 `prepare` 构建——pnpm ≥ 10 需要一次性 `allowBuilds` 授权（见下文） |
> | 适合谁 | 所有人；零摩擦 | 没有 npm 账号的用户，或想审计/fork 源码的用户 |

### Method 1: npm (recommended) · 方式一：npm（推荐）

The published tarball ships pre-built `lib/`, so users need no build authorization and no
toolchain:

> 发布到 registry 的 tarball 自带预构建的 `lib/`，用户无需构建授权、无需工具链：

```bash
dsh plugin --profile <name> add dsh-orchestrator
```

> China mirror note: if your npm is configured against a read-only mirror (e.g. npmmirror) and the
> package is not synced yet, install with the official registry:
> `dsh plugin --profile <name> add dsh-orchestrator --registry=https://registry.npmjs.org`.
> Publishing always targets the official registry — the package pins
> `publishConfig.registry`, mirrors never accept publishes.

> > 国内镜像提示：如果你的 npm 指向只读镜像（如 npmmirror）且包尚未同步，请用官方源安装：
> > `dsh plugin --profile <name> add dsh-orchestrator --registry=https://registry.npmjs.org`。
> > 发布永远走官方源——包内已写死 `publishConfig.registry`，镜像从不接受发布。

### Method 2: GitHub (no npm account needed) · 方式二：GitHub（无需 npm 账号）

Git installs pull the **source**, not build artifacts, so pnpm runs this package's `prepare`
script (a self-contained `tsc`) after installing — and pnpm ≥ 10 refuses to run it until the
profile explicitly authorizes the build. Pin a tag or commit so later pushes cannot silently
change what runs:

> Git 安装拉取的是**源码**而非构建产物，因此安装后 pnpm 会运行本包的 `prepare` 脚本
> （自包含的 `tsc`）——而 pnpm ≥ 10 在 profile 显式授权构建之前会拒绝执行它。
> 请锁定标签或 commit，让后续推送无法悄悄改变实际运行的内容：

```bash
dsh plugin --profile <name> add github:zibo2025/dsh-agent-mesh#v0.1.0
```

On pnpm ≥ 10 the first `add` fails on purpose; copy the exact package key it prints into the
profile's `pnpm-workspace.yaml`, then run the same command again:

> pnpm ≥ 10 下第一次 `add` 会故意失败；把它打印的确切包键复制进 profile 的
> `pnpm-workspace.yaml`，然后重跑同一条命令：

```yaml
# <profile>/pnpm-workspace.yaml
allowBuilds:
  dsh-orchestrator: true
```

### Activation scope: every session, or one preset · 生效范围：所有会话，或单个预设

Both methods above install the **bundle**, whose patch layer inserts the mesh row globally:
**every session on that profile** gets the mesh tools.

> 上述两种方式安装的都是 **bundle**，其 patch 层会全局插入网格行：
> **该 profile 的每一个会话**都会获得网格工具。

To scope the mesh to a dedicated orchestration preset instead (recommended setup: the master/
worker protocol only applies where you want it):

> 若想将网格限制在一个专门的编排预设内（推荐配置：主/子协议只在你需要的地方生效）：

1. Copy a preset (e.g. the shipped `standard`) to a new id and add the row:

   > 复制一个预设（例如自带的 `standard`）到新 id，并加入下面这行：

   ```yaml
   - id: orchestrator
     name: dsh-orchestrator
   ```

   The plugin publishes no service and only consumes host-plane registries
   (`tools`, `agents`, `subagents`, `systemPrompt`), so it needs **no isolate realm**:
   one instance per standing mount serves the whole agent tree.

   > 该插件不发布任何服务，只消费宿主平面的注册表
   > （`tools`、`agents`、`subagents`、`systemPrompt`），因此**无需 isolate realm**：
   > 每个 standing mount 一个实例即可服务整棵智能体树。

2. Make the package resolvable by the profile that launches the preset, **without** activating
   the bundle layer:

   > 让启动该预设的 profile 能解析到这个包，但**不**激活 bundle 层：

   ```bash
   cd "$DSH_HOME/profiles/<name>" && pnpm add dsh-orchestrator
   ```

   (Works for the GitHub method too: `pnpm add github:zibo2025/dsh-agent-mesh#v0.1.0` with the
   same `allowBuilds` authorization.)

   > （GitHub 方式同样适用：`pnpm add github:zibo2025/dsh-agent-mesh#v0.1.0`，
   > 同样需要 `allowBuilds` 授权。）

## Tools · 工具

### agent_spawn

| Parameter | Required | Description |
| --- | --- | --- |
| `label` | yes | Short display label for the worker. |
| `prompt` | yes | Complete, self-contained task; the mesh briefing is appended automatically. |
| `provider` | no | LLM provider route for this worker only. |
| `model` | no | Model id for this worker only. |
| `maxTokens` | no | Max output tokens per request for this worker only. |
| `effort` | no | Reasoning effort for this worker only. |

> | 参数 | 必填 | 说明 |
> | --- | --- | --- |
> | `label` | 是 | worker 的简短展示标签。 |
> | `prompt` | 是 | 完整、自包含的任务；网格简报会自动追加。 |
> | `provider` | 否 | 仅该 worker 使用的 LLM provider 路由。 |
> | `model` | 否 | 仅该 worker 使用的模型 id。 |
> | `maxTokens` | 否 | 仅该 worker 每次请求的最大输出 token 数。 |
> | `effort` | 否 | 仅该 worker 使用的思考强度。 |

Returns `{ childId, messageId }`. The child id is durable and stable across activations.

> 返回 `{ childId, messageId }`。子代理 id 持久且跨激活稳定。

### agent_send

| Parameter | Required | Description |
| --- | --- | --- |
| `agent_id` | yes | Target agent id (childId, master id, or an id from `agent_list`). |
| `message` | yes | Message content. |

> | 参数 | 必填 | 说明 |
> | --- | --- | --- |
> | `agent_id` | 是 | 目标智能体 id（childId、主智能体 id，或 `agent_list` 里的 id）。 |
> | `message` | 是 | 消息内容。 |

Returns `{ delivered, reason? }`. Delivery fails with a reason when the target is not online
(settled/disposed/unknown), not in your mesh, or is yourself. No reply is returned — the receiver
answers by sending a message back.

> 返回 `{ delivered, reason? }`。当目标不在线（已结算/已销毁/未知）、不在你的网格内、或就是你自己时，
> 投递失败并附原因。此调用不返回对方的答复——接收方通过回发消息作答。

### agent_broadcast

| Parameter | Required | Description |
| --- | --- | --- |
| `message` | yes | Message content for every mesh agent. |
| `exclude` | no | Agent ids to skip (the caller is always skipped). |

> | 参数 | 必填 | 说明 |
> | --- | --- | --- |
> | `message` | 是 | 发给每个网格智能体的消息内容。 |
> | `exclude` | 否 | 要跳过的智能体 id（调用者总是被跳过）。 |

Returns `{ deliveries: [{ agentId, delivered }] }`.

> 返回 `{ deliveries: [{ agentId, delivered }] }`。

### agent_list

No parameters. Returns `{ agents: [{ agentId, label?, status, parent?, master, self }] }`.

> 无参数。返回 `{ agents: [{ agentId, label?, status, parent?, master, self }] }`。

## Reasoning effort · 思考强度

`effort` is an **adapter-owned identifier**, validated by the selected provider adapter at call
time. For the DeepSeek adapter the legal values are:

> `effort` 是**适配器自有的标识符**，由所选 provider 适配器在调用时校验。DeepSeek 适配器的合法取值：

| Value | Meaning |
| --- | --- |
| `off` | Thinking disabled. |
| `high` | Thinking enabled, high effort. |
| `max` | Thinking enabled, maximum effort. |

> | 取值 | 含义 |
> | --- | --- |
> | `off` | 关闭思考。 |
> | `high` | 开启思考，高强度。 |
> | `max` | 开启思考，最高强度。 |

## Semantics and limitations · 语义与限制

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

> - **回合制，非实时。** 消息成为目标的*下一回合*，永远无法打断进行中的模型调用。
>   内核中更深的 `steer`/`inject` 收件箱目标存在但有意不暴露。
> - **仅在线目标。** 已结算（完成）的 worker 会离开实时注册表；给它发消息会返回 `not online`。
>   需要时重新派生一个新 worker。
> - **网格 = 你的派生树。** 其他会话的智能体（哪怕同预设）对你的网格不可见。
> - **思考强度按请求生效**，因此无法在飞行途中更改；需要新强度时派生新 worker。
> - 每个挂载组合一个插件实例；状态天然按会话隔离。

## Development · 开发

```bash
npm install
npm run build        # tsc → lib/
```

Local preset development: reference the built entry from the preset row with a cache-busting
version query (the loader caches module URLs):

> 本地预设开发：在预设行里用带缓存破坏的版本查询串引用构建产物（loader 会缓存模块 URL）：

```yaml
- id: orchestrator
  name: '../../../path/to/dsh-agent-mesh/lib/index.js?v=1'
```

Bump `?v=` after every rebuild, then mount-validate the preset
(`agentPresets.standingKeyFor`). After publishing, switch the row to the bare package name
`dsh-orchestrator`.

> 每次重建后递增 `?v=`，然后挂载校验预设（`agentPresets.standingKeyFor`）。
> 发布后把行名换成裸包名 `dsh-orchestrator`。

## License · 许可证

MIT
