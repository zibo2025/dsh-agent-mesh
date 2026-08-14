/**
 * dsh-orchestrator — native full-mesh agent orchestration for DeepSeek Harness.
 *
 * One plugin instance serves one mounted composition. The master (root) agent
 * joins the preset at mount; every worker created through `agent_spawn` binds
 * to the same standing composition (`agentPresets.composeFrom`), so the mesh
 * tools below and the `agent/request` waterfall cover the master and every
 * worker alike.
 *
 * Communication rides the harness's own agent inbox (`Agent.followup`), the
 * single turn FIFO of the agent loop: a message to a running agent queues for
 * its next turn, a message to an idle/waiting agent wakes it, and a message to
 * a settled agent reports "not online". No file mailbox, no prompt convention.
 *
 * Per-worker model comes from `SubagentStartRequest.agentOptions`
 * (`resolveChildAgentOptions`: the requested value wins, the parent's route is
 * the fallback). Reasoning effort has no AgentOptions field, so it is applied
 * per request through the `agent/request` waterfall against the spawn-time
 * assignment table.
 *
 * Mesh membership is the spawner tree rooted at the caller's root — the
 * `agents` registry is process-global, so agents of unrelated sessions are
 * never listed, messaged, or broadcast to.
 *
 * @module dsh-orchestrator
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'

export const name = 'orchestrator'
export const inject = ['tools', 'agents', 'subagents', 'systemPrompt']

export const Config = z.object({
  /** The `ctx.subagents` provider whose continuable backend establishes workers. */
  provider: z.string().default('spawn'),
  /** Absolute delegation-depth cap for workers spawned through `agent_spawn`. */
  maxDepth: z.number().step(1).min(0).default(2),
  /**
   * Optional override for the mesh-orientation prompt section this plugin
   * registers (order 180). It may reference `{{mesh_self}}` and
   * `{{mesh_master}}`. Omit to keep the built-in orchestration protocol.
   */
  orientation: z.string(),
})

/** Built-in mesh-orientation prompt section text. */
export const DEFAULT_ORIENTATION = [
  'You are in orchestration-mesh mode: {{mesh_self}} is your own agent id and {{mesh_master}} is the mesh root (master).',
  'Coordination tools: agent_spawn creates a worker (optionally with its own provider/model/maxTokens/effort), agent_send messages any live mesh agent, agent_broadcast reaches every mesh agent at once, and agent_list shows the live roster.',
  'Protocol:',
  '1. Decompose the task into workers before spawning; spawn independent workers in parallel rather than sequentially.',
  '2. A worker reports back by sending a message to its spawner with agent_send — never leave the master guessing, and never wait to be asked.',
  '3. Mesh messages are turn-based: a message becomes the receiver\'s next turn, so ask for what you need and expect the answer as a later message.',
  '4. The master aggregates worker results and owns the user-facing conclusion; workers do the hands-on work.',
].join('\n')

/** Spawn-time assignment recorded per worker id. */
interface MeshAssignment {
  label?: string
  effort?: string
  spawnedBy: string
}

/** Frame delivered mesh content so the receiver sees who sent it. */
function frame(sender: Agent, assignment: MeshAssignment | undefined, message: string): string {
  return `[orchestrator-mesh] message from agent ${sender.id}${assignment?.label ? ` ("${assignment.label}")` : ''}: ${message}`
}

/** The initial-prompt suffix every worker receives, so it knows the mesh it joined. */
function workerBrief(spawnerId: string, label: string, effort?: string): string {
  const lines = [
    '',
    '[orchestrator-mesh] You are a worker agent in an orchestration mesh.',
    `Your display label is "${label}". The agent that spawned you has id ${spawnerId} — reply to it with agent_send when your task is done or when you need input.`,
    'You can message ANY live mesh agent with agent_send (see agent_list for ids), and every message addressed to you arrives as your next turn.',
    'When your task is finished, send a final summary message to your spawner. Do not wait to be asked.',
  ]
  if (effort !== undefined) {
    lines.push(`Your reasoning effort is "${effort}".`)
  }
  return lines.join('\n')
}

export function apply(ctx: Context, config: { provider: string; maxDepth: number; orientation?: string }) {
  /** Per-mount assignment table: worker id → spawn-time mesh assignment. */
  const assignments = new Map<string, MeshAssignment>()

  /** Walk the spawner chain to the mesh root (an agent nobody spawned). */
  const rootOf = (id: string): string => {
    const seen = new Set<string>()
    let cursor = id
    for (;;) {
      if (seen.has(cursor)) return cursor // defensive: broken cycle
      seen.add(cursor)
      const assignment = assignments.get(cursor)
      if (assignment === undefined) return cursor
      cursor = assignment.spawnedBy
    }
  }

  /** Is `id` inside the mesh rooted at `root`? */
  const inMesh = (root: string, id: string): boolean => rootOf(id) === root

  // ── per-agent reasoning effort ──────────────────────────────────────────────
  // `agent/request` fires once per model step with the requesting agent in its
  // payload; the scope carrier delivers this listener to the master and to
  // every worker bound to this standing composition. No assignment → pass the
  // proposal through untouched.
  ctx.on('agent/request', (payload: { agent: Agent; turn: number; step: number; signal: AbortSignal }, next: () => Promise<LlmCallConfig>) => {
    return next().then((proposed) => {
      const assignment = assignments.get(payload.agent.id)
      if (assignment?.effort === undefined) return proposed
      return { ...proposed, reasoningEffort: ReasoningEffortId(assignment.effort) }
    })
  })

  // ── prompt variables (workers learn their own identity) ────────────────────
  ctx.systemPrompt.variable('mesh_self', (context) => context.agent?.id)
  ctx.systemPrompt.variable('mesh_master', (context) => (context.agent ? rootOf(context.agent.id) : undefined))

  // ── mesh-orientation section ────────────────────────────────────────────────
  ctx.systemPrompt.section({
    name: 'orchestrator-mesh',
    order: 180,
    text: config.orientation ?? DEFAULT_ORIENTATION,
  })

  // ── agent_spawn ─────────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'agent_spawn',
    description:
      'Create a new orchestration worker agent (a continuable background subagent) and assign it an initial task. ' +
      'The worker joins the same orchestration mesh: it can message any live mesh agent with agent_send and every message addressed to it arrives as its next turn. ' +
      'Optionally assign the worker its own LLM provider/model (falls back to the spawner\'s route) and a reasoning effort. ' +
      'Reasoning effort is an adapter-owned identifier — for the DeepSeek adapter the legal values are "off", "high", and "max". ' +
      'Returns the durable agent id; use it with agent_send, agent_list, or agent_broadcast.',
    parameters: {
      label: {
        type: 'string',
        required: true,
        description: 'Short display label for this worker, e.g. "researcher-a". It also names the worker in mesh messages.',
      },
      prompt: {
        type: 'string',
        required: true,
        description: 'The complete, self-contained task for the worker. It does not see the spawner\'s conversation, so include every fact it needs. The mesh briefing is appended automatically.',
      },
      provider: {
        type: 'string',
        description: 'Optional LLM provider route for this worker only. Omit to inherit the spawner\'s provider.',
      },
      model: {
        type: 'string',
        description: 'Optional model id for this worker only. Omit to inherit the spawner\'s model.',
      },
      maxTokens: {
        type: 'number',
        description: 'Optional maximum output tokens per model request for this worker only. Omit to inherit the spawner\'s value.',
      },
      effort: {
        type: 'string',
        description: 'Optional reasoning effort for this worker only. Adapter-owned identifier — for the DeepSeek adapter: "off", "high", or "max". Omit to inherit the default behavior.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          childId: { type: 'string', required: true },
          messageId: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `spawned orchestration worker ${value.childId}`,
      }],
    },
    async execute(args, exec) {
      const caller = exec.agent
      if (!caller) throw new Error('agent_spawn requires a calling agent (exec.agent was undefined)')
      const agentOptions: AgentOptions = {}
      if (args.provider !== undefined) agentOptions.provider = args.provider
      if (args.model !== undefined) agentOptions.model = args.model
      if (args.maxTokens !== undefined) agentOptions.maxTokens = args.maxTokens
      const result = await ctx.subagents.startContinuable({
        provider: config.provider,
        label: args.label,
        request: {
          parent: caller,
          prompt: [{
            type: 'text',
            text: args.prompt + workerBrief(caller.id, args.label, args.effort),
          }],
          ...(Object.keys(agentOptions).length > 0 ? { agentOptions } : {}),
          maxDepth: config.maxDepth,
        },
        signal: exec.signal,
      })
      assignments.set(result.childId, {
        label: args.label,
        ...(args.effort !== undefined && args.effort !== '' ? { effort: args.effort } : {}),
        spawnedBy: caller.id,
      })
      return result
    },
  }))

  // ── agent_send ──────────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'agent_send',
    description:
      'Send a message to any live mesh agent (the master or any worker) by agent id. ' +
      'The message becomes the target\'s next turn: if it is working, delivery waits for its current turn to finish; if it is idle, it wakes to process the message. ' +
      'This call returns no answer from the target — the receiver answers by sending a message back. ' +
      'Delivery fails with delivered: false when the target is not online (settled or unknown) or not part of your mesh.',
    parameters: {
      agent_id: {
        type: 'string',
        required: true,
        description: 'The agent id of the target (a childId from agent_spawn, the mesh master id from your mesh-orientation section, or an id from agent_list).',
      },
      message: {
        type: 'string',
        required: true,
        description: 'The message content to deliver.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          delivered: { type: 'boolean', required: true },
          reason: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.delivered ? `message queued as the next turn for agent ${_args.agent_id}` : `delivery failed: ${value.reason}`,
      }],
    },
    async execute(args, exec) {
      const caller = exec.agent
      if (!caller) throw new Error('agent_send requires a calling agent (exec.agent was undefined)')
      const targetId = SessionId(args.agent_id)
      if (targetId === caller.id) return { delivered: false, reason: 'cannot message yourself' }
      if (!inMesh(rootOf(caller.id), targetId)) return { delivered: false, reason: 'target is not part of your orchestration mesh' }
      const target = ctx.agents.get(targetId)
      if (target === undefined) return { delivered: false, reason: 'target is not online (settled, disposed, or unknown id)' }
      target.followup(createUserMessage({
        content: [{ type: 'text', text: frame(caller, assignments.get(caller.id), args.message) }],
        source: { kind: 'user' },
      }))
      return { delivered: true }
    },
  }))

  // ── agent_broadcast ─────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'agent_broadcast',
    description:
      'Broadcast a message to every live mesh agent except the caller and the listed exclusions. ' +
      'Each delivery behaves like agent_send: queued for the target\'s next turn, or waking an idle target. ' +
      'Use it for announcements, progress updates, or gathering status from every worker at once.',
    parameters: {
      message: {
        type: 'string',
        required: true,
        description: 'The message content to deliver to every mesh agent.',
      },
      exclude: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional agent ids to skip (in addition to the caller, which is always skipped).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          deliveries: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                agentId: { type: 'string', required: true },
                delivered: { type: 'boolean', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `broadcast delivered to ${value.deliveries.filter((d: { delivered: boolean }) => d.delivered).length} of ${value.deliveries.length} mesh agents`,
      }],
    },
    async execute(args, exec) {
      const caller = exec.agent
      if (!caller) throw new Error('agent_broadcast requires a calling agent (exec.agent was undefined)')
      const root = rootOf(caller.id)
      const excluded = new Set<string>([caller.id, ...(args.exclude ?? [])])
      const deliveries: { agentId: string; delivered: boolean }[] = []
      for (const agent of ctx.agents.list()) {
        if (excluded.has(agent.id) || !inMesh(root, agent.id)) continue
        agent.followup(createUserMessage({
          content: [{ type: 'text', text: frame(caller, assignments.get(caller.id), args.message) }],
          source: { kind: 'user' },
        }))
        deliveries.push({ agentId: agent.id, delivered: true })
      }
      return { deliveries }
    },
  }))

  // ── agent_list ──────────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'agent_list',
    description:
      'List every live agent in your orchestration mesh with its id, status, label, parent, and whether it is the mesh master. ' +
      'Use the ids for agent_send, agent_broadcast exclusions, or follow-ups.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          agents: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                agentId: { type: 'string', required: true },
                label: { type: 'string' },
                status: { type: 'string', required: true },
                parent: { type: 'string' },
                master: { type: 'boolean', required: true },
                self: { type: 'boolean', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `mesh has ${value.agents.length} live agent(s): ` + value.agents.map((a: { agentId: string; label?: string; status: string }) => `${a.agentId}${a.label ? ` (${a.label})` : ''}[${a.status}]`).join(', '),
      }],
    },
    async execute(_args, exec) {
      const caller = exec.agent
      if (!caller) throw new Error('agent_list requires a calling agent (exec.agent was undefined)')
      const root = rootOf(caller.id)
      const agents = ctx.agents.list()
        .filter((agent) => inMesh(root, agent.id))
        .map((agent) => {
          const assignment = assignments.get(agent.id)
          return {
            agentId: agent.id,
            ...(assignment?.label !== undefined ? { label: assignment.label } : {}),
            status: agent.status,
            ...(assignment !== undefined ? { parent: assignment.spawnedBy } : {}),
            master: agent.id === root,
            self: agent.id === caller.id,
          }
        })
      return { agents }
    },
  }))
}
