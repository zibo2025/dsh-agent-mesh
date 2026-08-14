# dsh-orchestrator

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的原生全互联智能体编排插件：
一个主智能体负责任务分解与分派，多个 worker 智能体负责实际执行，**任意智能体之间都能原生互发消息**
——主 → 子、子 → 主、子 ↔ 子——并支持为每个 worker 单独指定模型与思考强度。

没有文件信箱、没有提示词约定、没有轮询。消息直接走 harness 自带的智能体收件箱——智能体循环中唯一的
回合 FIFO 队列。

## 前置要求

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) —— 基于 `0.1.0-rc.6`
  插件接口线（当前技术预览线）构建。
- 仅 GitHub 安装方式需要 Node.js ≥ 20 与 pnpm ≥ 10；npm 方式无需任何额外环境。

## 与内置工具的关系

harness 自带 `subagent` / `subagent_fork`（派生子代理）与 `send_message`（仅限父级发给直接子级）。
本插件是它们的「网格形态超集」：

| 内置工具 | 本插件 | 区别 |
| --- | --- | --- |
| `subagent` | `agent_spawn` | 增加按 worker 指定 `provider` / `model` / `maxTokens` / `effort`；每次派生都加入网格 |
| `send_message` | `agent_send` | 任意方向——含 子 → 主 与 子 ↔ 子，而非只有父 → 子 |
| `list_agents` | `agent_list` | 带标签、父级与主智能体标记的网格花名册 |
| — | `agent_broadcast` | 一条消息到达网格内所有在线智能体 |

一条细规则：**网格花名册只包含通过 `agent_spawn` 派生的智能体**（外加根节点）。用内置 `subagent`
工具创建的子代理同样拥有网格工具，但它自成一颗树，在主智能体的 `agent_list` 里不可见——网格
worker 请一律用 `agent_spawn` 派生。

## 安装

有**两种安装方式**——npm 与 GitHub——以及两种生效范围——组合包（该 profile 的所有会话）或仅预设
（一个专门的编排预设）。先选一种方式，再选一种范围。下文的 `<name>` 是你的 profile 名，即
`$DSH_HOME/profiles/` 下的目录名（例如 `web`）。

**安装完成后请重启 `dsh`**（新预设则开一个新会话）：运行中的进程不会热加载新安装的包。

| | 方式一：npm（推荐） | 方式二：GitHub |
| --- | --- | --- |
| 命令 | `dsh plugin --profile <name> add dsh-orchestrator` | `dsh plugin --profile <name> add github:zibo2025/dsh-orchestrator#v0.1.3` |
| 拿到什么 | registry 上预构建好的 `lib/` | 源码检出，在你的机器上构建 |
| 前置条件 | 无 | pnpm 会运行本包自包含的 `prepare` 构建——pnpm ≥ 10 需要一次性 `allowBuilds` 授权（见下文） |
| 适合谁 | 所有人；零摩擦 | 没有 npm 账号的用户，或想审计、fork 源码的用户 |

### 方式一：npm（推荐）

npm 包自带预构建产物，无需构建授权、无需工具链：

```bash
dsh plugin --profile <name> add dsh-orchestrator
```

国内镜像提示：如果你的 npm 指向只读镜像（如 npmmirror）且包尚未同步，请用官方源安装：
`dsh plugin --profile <name> add dsh-orchestrator --registry=https://registry.npmjs.org`。

### 方式二：GitHub（无需 npm 账号）

Git 安装拉取的是**源码**而非构建产物，因此安装后 pnpm 会运行本包的 `prepare` 脚本（自包含的
`tsc`）——而 pnpm ≥ 10 在 profile 显式授权构建之前会拒绝执行它。请锁定标签或 commit，让后续
推送无法悄悄改变实际运行的内容。也请认真对待这项授权：它允许该包在安装时于你的机器上执行代码，
且不在任何智能体沙箱之内。

```bash
dsh plugin --profile <name> add github:zibo2025/dsh-orchestrator#v0.1.3
```

pnpm ≥ 10 下第一次 `add` 会故意失败；把它打印的确切包键复制进 profile 的 `pnpm-workspace.yaml`，
然后重跑同一条命令：

```yaml
# <profile>/pnpm-workspace.yaml
allowBuilds:
  dsh-orchestrator: true
```

### 生效范围：所有会话，或单个预设

上述两种方式安装的都是**组合包**，其 patch 层会全局插入网格行：**该 profile 的每一个会话**都会
获得网格工具。

若想将网格限制在一个专门的编排预设内（推荐配置：主/子协议只在你需要的地方生效），在预设的
`agent.cordis.yml` 中加入下面这行即可——无需任何其他配置：

```yaml
- id: orchestrator
  name: dsh-orchestrator
```

然后让启动该预设的 profile 能解析到这个包，但**不**激活组合包层：

```bash
cd "$DSH_HOME/profiles/<name>" && pnpm add dsh-orchestrator
```

GitHub 方式同样适用：`pnpm add github:zibo2025/dsh-orchestrator#v0.1.3`，同样需要 `allowBuilds` 授权。

## 快速开始

安装并重启后，开一个会话（选择仅预设方式则切到编排预设），直接提需求即可——网格协议会自动注入
提示词：

```
用 agent_spawn 创建两个 worker：
- 一个 label 为 researcher，effort 设为 high，调研「A 主题」并写结论；
- 一个 label 为 checker，用便宜的模型，独立复核 researcher 的结论；
让它们通过 agent_send 互发消息交换意见，最后把结论汇总给我。
```

验证工具是否生效：让智能体调用一次 `agent_list`——它应该看到自己是主智能体。若工具缺失，见下方
「常见问题」。

## 工具参考

### agent_spawn

创建一个常驻后台、可持续对话的 worker。

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `label` | 是 | worker 的简短展示标签。 |
| `prompt` | 是 | 完整、自包含的任务；网格简报会自动追加。 |
| `provider` | 否 | 仅该 worker 使用的 LLM provider 路由。 |
| `model` | 否 | 仅该 worker 使用的模型 id。 |
| `maxTokens` | 否 | 仅该 worker 每次请求的最大输出 token 数。 |
| `effort` | 否 | 仅该 worker 使用的思考强度。 |

返回 `{ childId, messageId }`。子代理 id 持久且跨激活稳定。

### agent_send

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `agent_id` | 是 | 目标智能体 id（childId、主智能体 id，或 `agent_list` 里的 id）。 |
| `message` | 是 | 消息内容。 |

返回 `{ delivered, reason? }`。当目标不在线（已结算/已销毁/未知）、不在你的网格内、或就是你自己时，
投递失败并附原因。此调用不返回对方的答复——接收方通过回发消息作答。

### agent_broadcast

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `message` | 是 | 发给每个网格智能体的消息内容。 |
| `exclude` | 否 | 要跳过的智能体 id（调用者总是被跳过）。 |

返回 `{ deliveries: [{ agentId, delivered }] }`。

### agent_list

无参数。返回 `{ agents: [{ agentId, label?, status, parent?, master, self }] }`。

## 思考强度

`effort` 是**适配器自有的标识符**，由所选 provider 适配器在调用时校验。DeepSeek 适配器的合法取值：

| 取值 | 含义 |
| --- | --- |
| `off` | 关闭思考。 |
| `high` | 开启思考，高强度。 |
| `max` | 开启思考，最高强度。 |

## 语义与限制

- **回合制，非实时。** 消息成为目标的*下一回合*，永远无法打断进行中的模型调用。
- **仅在线目标。** 已结算（完成）的 worker 会离开实时注册表；给它发消息会返回 `not online`。
  需要时重新派生一个新 worker。
- **网格 = 你的派生树。** 其他会话的智能体（哪怕同预设）对你的网格不可见。
- **思考强度按请求生效**，因此无法在飞行途中更改；需要新强度时派生新 worker。
- 每个挂载组合一个插件实例；状态天然按会话隔离。

## 常见问题

**装完了但工具没出现。**

重启 `dsh`（组合包方式），或在新会话里选择该预设（仅预设方式）。运行中的进程不会热加载新安装的包。

**`agent_send` 返回 `not online`。**

该 worker 已完成任务并离开实时注册表，属正常现象——需要时重新派生一个新 worker。

**传了非法的 `effort` 值会怎样？**

provider 适配器会以「不支持的思考强度」拒绝模型调用；请用合法值重新派生 worker。DeepSeek 合法
取值：`off` / `high` / `max`。

**镜像还没有最新版本。**

用官方源安装：`dsh plugin --profile <name> add dsh-orchestrator --registry=https://registry.npmjs.org`。

**worker 想回报时，主智能体的 id 在哪？**

每个智能体的提示词里都包含自己的 `{{mesh_self}}` 与网格根 `{{mesh_master}}`；worker 的派生简报里
也明确写有派生者的 id。

## 工作原理

*给想了解内核的读者——普通用户可跳过本节。*

harness 内核本身就内置了基于收件箱的消息系统：`Agent.followup()` 把消息插入目标的回合 FIFO 并唤醒
它。官方 `send_message` 工具只是 `ctx.subagents.followup()` 之上的一层薄适配器，额外强制了「直接
父级」授权。本插件有意绕过这层限制：网格工具通过宿主 `agents` 注册表（`ctx.agents.get(id)`）解析
在线目标，并经由原始收件箱投递——这正是子 ↔ 子通信得以实现的原因。

按 worker 指定**模型**走的是官方 `SubagentStartRequest.agentOptions` 路径（`resolveChildAgentOptions`：
显式指定者优先、父级路由回退、随子代理的持久化描述符留存）。而**思考强度**在 `AgentOptions` 中没有
对应字段，因此通过 `agent/request` 瀑布按请求施加——一个监听器即可覆盖主智能体与全部 worker：
子代理会绑定到父级的 standing 组合（`agentPresets.composeFrom`），scope 载体沿该链路由智能体事件。

**网格成员**即「以调用者根节点为根的派生树」。`agents` 注册表是进程全局的，因此无关会话的智能体
永远不会被列出、被发消息或被广播。

## 许可证

MIT
