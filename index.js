/**
 * `dsh-llm-keypool` — bundle root and **Host half of the rotation-pool panel**.
 *
 * This row exists for one reason: the Client module system attaches a bundle's
 * browser half to the Loader row whose specifier is exactly the package name.
 * It also owns the small loopback JSON API the panel talks to:
 *
 *  - `GET  /api/keypool/catalog`  every registered provider with its models
 *  - `GET  /api/keypool/config`   the GUI-managed pool file and the row fallback
 *  - `POST /api/keypool/config`   validate + atomically write the pool file
 *  - `GET  /api/keypool/status`   active route, cooling routes, recent switches
 *
 * Nothing here changes request behavior; behavior lives in the sibling rows
 * `dsh-llm-keypool/route-pool` and `dsh-llm-keypool/key-rotate`.
 *
 * @module dsh-llm-keypool
 */
import {
  configFilePath,
  readStoredConfig,
  statusSnapshot,
  storedConfigError,
  writeStoredConfig,
} from './lib/runtime.js'
import { readNonNegativeInt, readPositiveInt } from './lib/shared.js'

/** Cordis plugin name (matches the package name so the browser half attaches). */
export const name = 'dsh-llm-keypool'

/** The panel needs the web server (its API) and the live model catalog. */
export const inject = ['webServer', 'llm']

const PREFIX = '/api/keypool/'

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/** @returns {boolean} whether the request comes from this machine. */
function isLoopback(req) {
  const address = req.socket?.remoteAddress
  return typeof address === 'string' && LOOPBACK.has(address)
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 */
function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(payload)
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<string>}
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 1_000_000) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** Normalize one catalog model entry. */
const modelEntry = (model) => ({
  id: typeof model?.id === 'string' ? model.id : String(model),
  name: typeof model?.name === 'string' && model.name !== ''
    ? model.name
    : (typeof model?.id === 'string' ? model.id : String(model)),
})

/**
 * @param {any} ctx Cordis context.
 * @param {Record<string, unknown>} [config] this row's config (row fallback shown by the panel).
 */
export function apply(ctx, config = {}) {
  const rowFallback = {
    pools: Array.isArray(config.pools) ? config.pools : [],
    cooldownMs: readNonNegativeInt(config.cooldownMs, 10 * 60_000),
    maxSwitchesPerTurn: readPositiveInt(config.maxSwitchesPerTurn, 3),
  }

  /** @param {import('node:http').ServerResponse} res */
  const sendConfig = (res) => {
    const stored = readStoredConfig()
    sendJson(res, 200, {
      file: configFilePath(),
      stored: stored ?? null,
      storedError: stored === undefined ? (storedConfigError() ?? null) : null,
      row: rowFallback,
    })
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${PREFIX}catalog`,
    handler: (req, res) => {
      if (!isLoopback(req)) return sendJson(res, 403, { error: 'loopback only' })
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'GET only' })
      ;(async () => {
        const llm = ctx.get('llm')
        const providers = llm === undefined ? [] : llm.listProviders()
        const catalog = []
        for (const provider of providers) {
          let models = []
          try {
            if (llm !== undefined) models = await llm.listModels(provider.id)
          } catch {
            models = []
          }
          catalog.push({
            provider: provider.id,
            displayName: typeof provider.displayName === 'string' && provider.displayName !== ''
              ? provider.displayName
              : provider.id,
            models: Array.isArray(models) ? models.map(modelEntry) : [],
          })
        }
        sendJson(res, 200, { providers: catalog })
      })().catch((error) => sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) }))
    },
  }), 'llm-keypool: catalog route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${PREFIX}config`,
    handler: (req, res) => {
      if (!isLoopback(req)) return sendJson(res, 403, { error: 'loopback only' })
      if (req.method === 'GET') return sendConfig(res)
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'GET or POST only' })
      ;(async () => {
        const raw = await readBody(req)
        let parsed
        try {
          parsed = JSON.parse(raw)
        } catch {
          return sendJson(res, 400, { error: 'body is not valid JSON' })
        }
        try {
          const saved = writeStoredConfig(parsed)
          return sendJson(res, 200, { ok: true, saved, file: configFilePath() })
        } catch (error) {
          return sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      })().catch((error) => sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) }))
    },
  }), 'llm-keypool: config route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${PREFIX}status`,
    handler: (req, res) => {
      if (!isLoopback(req)) return sendJson(res, 403, { error: 'loopback only' })
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'GET only' })
      sendJson(res, 200, statusSnapshot())
    },
  }), 'llm-keypool: status route')
}
