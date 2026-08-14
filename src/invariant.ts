/**
 * Package-owned invariant companion for `dsh-orchestrator`.
 *
 * Every published DeepSeek Harness package carries an invariant companion that
 * reserves package ownership with the `invariants` registry. This package has
 * no independent lifecycle stream — delivery and activation relations are
 * owned by the host `subagents`/`agents` registries it calls — so the install
 * is a no-op that only reserves the name.
 *
 * @module dsh-orchestrator/invariant
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = 'dsh-orchestrator'

/** Cordis companion plugin name. */
export const name = 'orchestrator-invariant'

/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** No runtime invariant: the mesh owns no lifecycle stream of its own. */
const install = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export function apply(ctx: Context) {
  return Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
}
