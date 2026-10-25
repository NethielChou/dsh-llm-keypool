import test from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../lib/key-rotate.js'
import { createFakeCredentials, createFakeCtx, requestErrorPayload } from './helpers/fake-ctx.mjs'

const BASE_CONFIG = {
  activeRef: 'LAB_ACTIVE_KEY',
  refs: ['LAB_KEY_A', 'LAB_KEY_B', 'LAB_KEY_C'],
  maxSwitchesPerTurn: 3,
}

function setup(overrides = {}, credentialsOverrides = {}) {
  const credentials = createFakeCredentials({
    LAB_ACTIVE_KEY: 'key-a',
    LAB_KEY_A: 'key-a',
    LAB_KEY_B: 'key-b',
    LAB_KEY_C: 'key-c',
    ...credentialsOverrides,
  })
  const { ctx, dispatch, disposeAll, logs } = createFakeCtx({ services: { credentials } })
  apply(ctx, { ...BASE_CONFIG, ...overrides })
  return { ctx, dispatch, disposeAll, logs, credentials }
}

const TERMINAL = Symbol('terminal')

test('rotates to the next key on a QUOTA failure and asks for a retry', async () => {
  const { dispatch, credentials, logs } = setup()
  const result = await dispatch(
    'agent/request-error',
    requestErrorPayload({ provider: 'lab-b', failure: { code: 'QUOTA', message: 'insufficient quota' } }),
    async () => TERMINAL,
  )
  assert.deepEqual(result, { kind: 'retry' })
  assert.deepEqual(credentials.writes, [{ ref: 'LAB_ACTIVE_KEY', value: 'key-b' }])
  const text = JSON.stringify(logs.map((entry) => entry.args))
  assert.ok(text.includes('LAB_ACTIVE_KEY'), 'log should name the rotated ref')
  assert.ok(!text.includes('key-a'), 'log must not contain the old key')
  assert.ok(!text.includes('key-b'), 'log must not contain the new key')
})

test('recognizes Chinese quota wording that the harness classifies as PI_AI_ERROR', async () => {
  const { dispatch, credentials } = setup()
  const result = await dispatch(
    'agent/request-error',
    requestErrorPayload({ provider: 'lab-b', failure: { code: 'PI_AI_ERROR', message: '今日额度已用尽，请充值' } }),
    async () => TERMINAL,
  )
  assert.deepEqual(result, { kind: 'retry' })
  assert.equal(credentials.writes.length, 1)
})

test('leaves transient non-quota failures alone', async () => {
  const { dispatch, credentials } = setup()
  const result = await dispatch(
    'agent/request-error',
    requestErrorPayload({ provider: 'lab-b', failure: { code: 'INVALID_REQUEST', message: 'bad tool schema' } }),
    async () => TERMINAL,
  )
  assert.equal(result, TERMINAL)
  assert.deepEqual(credentials.writes, [])
})

test('resets the switch budget on a new turn', async () => {
  const { dispatch, credentials } = setup({ maxSwitchesPerTurn: 2 })
  const failure = { code: 'QUOTA', message: 'insufficient quota' }
  const agent = { id: 'budget-agent' }
  for (let index = 0; index < 2; index += 1) {
    assert.deepEqual(
      await dispatch('agent/request-error', requestErrorPayload({ agent, turn: 1, failure }), async () => TERMINAL),
      { kind: 'retry' },
    )
  }
  assert.equal(credentials.writes.length, 2)
  // Budget exhausted inside turn 1.
  assert.equal(
    await dispatch('agent/request-error', requestErrorPayload({ agent, turn: 1, failure }), async () => TERMINAL),
    TERMINAL,
  )
  // A new turn starts from a fresh budget.
  assert.deepEqual(
    await dispatch('agent/request-error', requestErrorPayload({ agent, turn: 2, failure }), async () => TERMINAL),
    { kind: 'retry' },
  )
  assert.equal(credentials.writes.length, 3)
})

test('does nothing when the pool effectively holds one key', async () => {
  const { dispatch, credentials } = setup({}, { LAB_KEY_B: 'key-a', LAB_KEY_C: 'key-a' })
  const result = await dispatch(
    'agent/request-error',
    requestErrorPayload({ provider: 'lab-b', failure: { code: 'QUOTA', message: 'insufficient quota' } }),
    async () => TERMINAL,
  )
  assert.equal(result, TERMINAL)
  assert.deepEqual(credentials.writes, [])
})

test('dryRun reports a retry without writing the credential', async () => {
  const { dispatch, credentials } = setup({ dryRun: true })
  const result = await dispatch(
    'agent/request-error',
    requestErrorPayload({ provider: 'lab-b', failure: { code: 'QUOTA', message: 'insufficient quota' } }),
    async () => TERMINAL,
  )
  assert.deepEqual(result, { kind: 'retry' })
  assert.deepEqual(credentials.writes, [])
})

test('stops reacting after the plugin is disposed', async () => {
  const { dispatch, credentials, disposeAll } = setup()
  disposeAll()
  const result = await dispatch(
    'agent/request-error',
    requestErrorPayload({ provider: 'lab-b', failure: { code: 'QUOTA', message: 'insufficient quota' } }),
    async () => TERMINAL,
  )
  assert.equal(result, TERMINAL)
  assert.deepEqual(credentials.writes, [])
})

test('warns and stays inactive on incomplete config', async () => {
  const credentials = createFakeCredentials({ LAB_ACTIVE_KEY: 'key-a' })
  const { ctx, dispatch, logs } = createFakeCtx({ services: { credentials } })
  apply(ctx, { activeRef: '', refs: [] })
  assert.ok(logs.some((entry) => entry.level === 'warn' && String(entry.args[0]).includes('llm-key-rotate')))
  const result = await dispatch(
    'agent/request-error',
    requestErrorPayload({ failure: { code: 'QUOTA', message: 'insufficient quota' } }),
    async () => TERMINAL,
  )
  assert.equal(result, TERMINAL)
})

test('walks an exhausted pool exactly once instead of cycling back', async () => {
  const credentials = createFakeCredentials({
    LAB_ACTIVE_KEY: 'key-a',
    LAB_KEY_A: 'key-a',
    LAB_KEY_B: 'key-b',
    LAB_KEY_C: 'key-c',
  })
  const { ctx, dispatch } = createFakeCtx({ services: { credentials } })
  apply(ctx, { ...BASE_CONFIG, maxSwitchesPerTurn: 5 })
  const agent = { id: 'exhausted-agent' }
  const failure = { code: 'QUOTA', message: 'insufficient quota' }
  const results = []
  for (let index = 0; index < 4; index += 1) {
    results.push(await dispatch('agent/request-error', requestErrorPayload({ agent, turn: 7, failure }), async () => TERMINAL))
  }
  // a (initial) -> b -> c, then the pool is burned: no further rotation.
  assert.deepEqual(results, [{ kind: 'retry' }, { kind: 'retry' }, TERMINAL, TERMINAL])
  assert.deepEqual(credentials.writes.map((write) => write.value), ['key-b', 'key-c'])
})

test('honours watchProviders', async () => {
  const { dispatch, credentials } = setup({ watchProviders: ['other-provider'] })
  const result = await dispatch(
    'agent/request-error',
    requestErrorPayload({ provider: 'lab-b', failure: { code: 'QUOTA', message: 'insufficient quota' } }),
    async () => TERMINAL,
  )
  assert.equal(result, TERMINAL)
  assert.deepEqual(credentials.writes, [])
})
