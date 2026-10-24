/**
 * `llm-key-rotate` — a host plugin that rotates an API credential when the
 * provider reports an exhausted quota, so the retried step uses the next key.
 *
 * Why this works inside DSH: `dsh-llm-pi-ai` resolves a route's credential
 * reference on every request, so writing the next key into the route's
 * `apiKeyEnv` ref takes effect on the next request — and returning
 * `{ kind: 'retry' }` from the `agent/request-error` waterfall makes the agent
 * loop repeat the failed step in the same turn.
 *
 * Hard rules (see docs/spec.md):
 *  - never append session events (a new event type breaks Session reopen);
 *  - never throw into the waterfall — degrade to `next()`;
 *  - never log credential values, only ref names and slot numbers.
 *
 * @module dsh-llm-keypool/key-rotate
 */
import {
  compilePatterns,
  describeFailure,
  matchesFailure,
  readPositiveInt,
  readString,
  readStringArray,
  SwitchBudget,
} from './shared.js'

/** Cordis plugin name. */
export const name = 'llm-key-rotate'

/**
 * Without a credentials service there is nothing to rotate, so the plugin stays
 * inactive in profiles that disable the managed store (the shipped headless
 * profile does this by default).
 */
export const inject = ['credentials']

/**
 * Resolve one credential reference to its current non-empty value.
 * @param {any} credentials
 * @param {string} ref
 * @returns {Promise<string | undefined>}
 */
async function resolveValue(credentials, ref) {
  const hit = await credentials.resolve(ref)
  const value = hit !== null && typeof hit === 'object' ? hit.value : undefined
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Resolve the candidate refs into an ordered, value-deduplicated pool.
 * Duplicate values collapse to their first ref so a pool that aliases one key
 * twice can never "rotate" onto itself.
 * @param {any} credentials
 * @param {string[]} refs
 * @returns {Promise<Array<{ ref: string, value: string }>>}
 */
async function resolvePool(credentials, refs) {
  const pool = []
  const seen = new Set()
  for (const ref of refs) {
    const value = await resolveValue(credentials, ref)
    if (value === undefined || seen.has(value)) continue
    seen.add(value)
    pool.push({ ref, value })
  }
  return pool
}

/**
 * Remember which credential values a turn already burned, so an exhausted pool
 * is walked exactly once instead of cycling back onto a key that just failed.
 * Keyed by the agent object; a new turn starts a fresh set.
 */
class TriedValues {
  /** @type {WeakMap<object, { turn: unknown, values: Set<string> }>} */
  #states = new WeakMap()
  /** @type {{ turn: unknown, values: Set<string> }} */
  #anonymous = { turn: undefined, values: new Set() }

  #stateFor(agent, turn) {
    if (agent === null || typeof agent !== 'object') {
      if (this.#anonymous.turn !== turn) this.#anonymous = { turn, values: new Set() }
      return this.#anonymous
    }
    let state = this.#states.get(agent)
    if (state === undefined || state.turn !== turn) {
      state = { turn, values: new Set() }
      this.#states.set(agent, state)
    }
    return state
  }

  /** Mark one value as already attempted in this turn. */
  add(agent, turn, value) {
    if (typeof value !== 'string' || value === '') return
    this.#stateFor(agent, turn).values.add(value)
  }

  /** @returns {boolean} whether the value was already attempted in this turn. */
  has(agent, turn, value) {
    return this.#stateFor(agent, turn).values.has(value)
  }
}

/**
 * @param {any} ctx Cordis context.
 * @param {Record<string, unknown>} [config] row config from `cordis.patch.yml`.
 */
export function apply(ctx, config = {}) {
  const activeRef = readString(config.activeRef)
  const configuredRefs = readStringArray(config.refs) ?? []
  if (activeRef === undefined || configuredRefs.length === 0) {
    ctx.logger.warn('llm-key-rotate: disabled — config needs a non-empty "activeRef" and a non-empty "refs" list')
    return
  }

  // The active ref is always part of the pool: it names the slot the provider
  // reads today, so ordering must include it even when the user omits it.
  const refs = [activeRef]
  for (const ref of configuredRefs) if (!refs.includes(ref)) refs.push(ref)

  const regexes = compilePatterns(config.patterns)
  const codes = readStringArray(config.codes)
  const watchProviders = readStringArray(config.watchProviders)
  const maxSwitchesPerTurn = readPositiveInt(config.maxSwitchesPerTurn, 3)
  const dryRun = config.dryRun === true
  const budget = new SwitchBudget()

  /** @type {TriedValues} */
  const tried = new TriedValues()

  /**
   * @param {{ agent?: unknown, turn?: unknown, provider?: unknown, failure?: unknown }} payload
   * @param {() => Promise<unknown>} next
   */
  async function onRequestError(payload, next) {
    try {
      const failure = payload?.failure
      if (!matchesFailure(failure, { codes, regexes })) return next()
      if (watchProviders !== undefined && watchProviders.length > 0) {
        if (!watchProviders.includes(payload?.provider)) return next()
      }
      const credentials = ctx.get('credentials')
      if (credentials === undefined) return next()

      const agent = payload?.agent
      const turn = payload?.turn
      const current = await resolveValue(credentials, activeRef)
      const pool = await resolvePool(credentials, refs)
      if (pool.length < 2) return next()

      // The value that just failed is burned for this turn.
      if (current !== undefined) tried.add(agent, turn, current)

      const currentIndex = pool.findIndex((entry) => entry.value === current)
      /** @type {{ ref: string, value: string } | undefined} */
      let target
      if (currentIndex < 0) {
        target = pool.find((entry) => !tried.has(agent, turn, entry.value))
      } else {
        for (let step = 1; step < pool.length; step += 1) {
          const candidate = pool[(currentIndex + step) % pool.length]
          if (candidate.value === current) continue
          if (tried.has(agent, turn, candidate.value)) continue
          target = candidate
          break
        }
      }
      // Every value in the pool already failed during this turn.
      if (target === undefined) return next()
      if (!budget.take(agent, turn, maxSwitchesPerTurn)) return next()

      if (!dryRun) await credentials.set(activeRef, target.value)

      const slot = pool.indexOf(target) + 1
      ctx.logger.warn(
        `llm-key-rotate: provider "${String(payload?.provider)}" failed with ${describeFailure(failure)}; `
          + `rotated credential "${activeRef}" to slot ${slot}/${pool.length} (source ref "${target.ref}")${dryRun ? ' [dry run]' : ''}`,
      )
      return { kind: 'retry' }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      ctx.logger.warn(`llm-key-rotate: rotation skipped: ${message}`)
      return next()
    }
  }

  ctx.effect(() => ctx.on('agent/request-error', onRequestError))
}
