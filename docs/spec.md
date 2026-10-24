# dsh-llm-keypool — 实现规格（给并行开发者）

> 这是内部实现规格，不是用户文档。用户文档见 `README.md`。

## 0. 背景与已验证的内核事实

用户在 `cordis.patch.yml` 里配置了多个 provider（`ustc` / `ustc-techer` / `ustc-back`），
共用 `https://api.llm.ustc.edu.cn/`、同一批模型 id，但 `apiKeyEnv` 各自不同。
希望一把 key 额度用尽后自动换下一把，不手动改配置。

已从 `app.asar`（DSH 2.0.19-next / 内核 0.2.1-rc.2）核实的契约：

1. **`agent/request-error` waterfall**：payload 是
   `{ agent, turn, step, provider, failure, retryPolicy, signal }`。
   `failure = { code, message, providerRetryAfterMs? }`。
   `code` 可能是 `QUOTA` / `ACCOUNT_QUOTA` / `AUTH` / `RATE_LIMIT` / `PI_AI_ERROR` 等
   （DSH 用英文正则识别，中文报错常常落到 `PI_AI_ERROR`，所以插件必须自己看 `message`）。
   监听器若返回 `{ kind: 'retry' }`，agent loop 会在**同一轮、同一步**重跑失败步骤；
   若返回 `undefined`（或不返回），由下游/终态处理，轮次以该失败结束。
   **重试会重新走 `agent/request` waterfall，也会重新解析凭据**——这是两个插件能工作的根基。

2. **`agent/request` waterfall**：payload 只有 `{ turn, step, signal }`；
   `next()` 返回当次请求的配置 `{ provider, model, reasoningEffort?, maxTokens? }`。
   监听器可以返回改写后的配置。内核自己的 `installModelSelection`
   （`dsh-agent/lib/index.js`）就是用 `ctx.on('agent/request', ...)` 在 `next()` 之后
   覆盖 provider/model；它注册在 agent 作用域上。**全局插件要在它之后生效，
   必须用 `{ prepend: true }` 注册**（prepend 排在链首，先 `await next()` 再覆盖）。

3. **凭据热切换**：`dsh-llm-pi-ai` 的 `resolveApiKey()` 每次请求都调
   `credentials.resolve(ref)`（`lib/index.js:2886`），且 `credentials` 文档明确
   「轮换后的已存储密钥会作用于下一次请求，无需重启或修改配置」。
   所以换 key = `await ctx.get('credentials').set(activeRef, nextValue)` + `{kind:'retry'}`。

4. **禁止自造 session 事件**：`Session.append()` 不能设置 `ignorable: true`，
   写新 `type` 会让 Session 无法重新打开。两个插件都**只能写日志**
   （`ctx.logger.warn/info`），不得 append 任何 session 事件。

5. **不要抛异常打断宿主**：配置非法、服务缺失、写凭据失败 → `logger.warn` 后
   走 `next()`，绝不能把错误抛回 waterfall。

## 1. 文件与职责（并行边界）

| 文件 | 负责人 | 说明 |
|---|---|---|
| `lib/shared.js` | Lead（已完成） | 配额判断、预算、配置校验。**不要改** |
| `test/helpers/fake-ctx.mjs` | Lead（已完成） | 伪 Cordis ctx / 凭据服务 / payload 构造。**不要改** |
| `lib/key-rotate.js` | key-rotate-dev | 插件 B（凭据轮换） |
| `test/key-rotate.test.mjs` | key-rotate-dev | B 的单元测试 |
| `lib/route-pool.js` | route-pool-dev | 插件 C（路由池 fallback） |
| `test/route-pool.test.mjs` | route-pool-dev | C 的单元测试 |
| `package.json` / `cordis.patch.yml` / `docs/spec.md` | Lead | 不要改 |

测试命令（在项目根目录）：

```powershell
& node --test test/key-rotate.test.mjs
& node --test test/route-pool.test.mjs
```

`package.json` 是 `"type": "module"`；用 ESM + `node:test` + `node:assert/strict`。

## 2. 插件 B：`llm-key-rotate`（lib/key-rotate.js）

### 导出

```js
export const name = 'llm-key-rotate'
export const inject = ['credentials']   // 没有 credentials 服务的 profile 里保持未激活
export function apply(ctx, config)      // 同步；内部注册 waterfall 监听器
```

### 配置（`cordis.patch.yml` 的 row config）

```yaml
activeRef: PROVIDER_KEY_ACTIVE        # 必填：provider 当前 apiKeyEnv 指向的那个凭据 ref
refs: [PROVIDER_KEY_A, PROVIDER_KEY_B, PROVIDER_KEY_ACTIVE]  # 必填：候选 key 的 ref 列表（可包含 activeRef）
codes: [QUOTA, ACCOUNT_QUOTA]       # 可选：触发轮换的 failure.code；默认 DEFAULT_CODES
patterns: []                        # 可选：替换默认 message 正则列表；默认 DEFAULT_PATTERNS（含中文）
watchProviders: [vendor-a, vendor-b]   # 可选：只对这些 provider 生效；省略/空 = 全部
maxSwitchesPerTurn: 3               # 可选，默认 3
dryRun: false                       # 可选：true 时只打日志不写凭据（联调用）
```

配置校验失败时的行为（必须）：`logger.warn` 一条能定位问题的消息，`apply` 直接 return（不注册监听器），**不抛异常**。

### 运行时行为（监听 `agent/request-error`，非 prepend）

1. 取 `failure`，若 `matchesFailure(failure, { codes, patterns, regexes })` 为 false → `next()`。
   建议在 apply 时用 `compilePatterns(config.patterns)` 预编译一次。
2. 若配置了 `watchProviders` 且 payload.provider 不在其中 → `next()`。
3. `budget.take(payload.agent, payload.turn, maxSwitchesPerTurn)` 为 false → `next()`。
   （预算在真正切换前消耗；同 turn 内重置。）
4. 取 `credentials = ctx.get('credentials')`；缺失 → `next()`。
5. `current = (await credentials.resolve(activeRef))?.value`；resolve 抛错 → warn + `next()`。
6. 逐个 resolve `refs`（每项都 `await`；抛错或空值跳过），得到有序去重数组
   `pool = [{ ref, value }]`（按 value 去重，保留第一个 ref）。
7. `pool` 少于 2 项 → `next()`（只有一把 key，轮换没有意义）。
8. 找 `current` 在 `pool` 中的下标；找不到按下标 -1 处理 → 目标为 `pool[0]`；
   找到 → 目标为 `pool[(index + 1) % pool.length]`。
   若目标 value 与 current 相同（理论上已去重不会发生）→ 继续往后找，找不到则 `next()`。
9. `dryRun` 为 true：只 warn；否则 `await credentials.set(activeRef, target.value)`
   （写失败 → warn + `next()`）。
10. `logger.warn` 记录轮换：**只允许出现 ref 名、池大小、序号，不允许出现 key 值**。
11. `return { kind: 'retry' }`。

### 重要边界

- `agent/request-error` 的 payload 里 `agent` 可能缺失（测试构造也可能缺）；`SwitchBudget` 已处理。
- 不要监听 `agent/request`；不要改 provider/model；不要碰 session。
- 监听器用 `ctx.effect(() => { const off = ctx.on(...); return off })` 或直接 `ctx.on`（返回 disposer）注册。

### 测试要求（`test/key-rotate.test.mjs`，至少覆盖）

1. QUOTA 失败 + 3 把 key → 写到下一把，返回 `{kind:'retry'}`，日志不含 key 值。
2. 中文 message（如 `余额不足`、`额度已用尽`）+ `code: 'PI_AI_ERROR'` → 仍触发。
3. 非配额失败（`RATE_LIMIT` 且 message 无配额词）→ 原样 `next()`（返回值等于 terminal 的返回值，`credentials.writes` 为空）。
4. 同 turn 连续失败 3 次后第 4 次不再切换（预算耗尽，`writes.length === 3` 或按你的 max 配置）。
5. 换 turn 后预算重置。
6. 池里只有 1 把 key → 不切换。
7. `dryRun: true` → 不写凭据但仍返回 `{kind:'retry'}`。
8. 听器注册后再 `disposeAll()`，之后 dispatch 不再触发（清理生效）。
9. 配置缺失（`activeRef: ''` / `refs: []`）→ logger.warn 且不注册监听器（dispatch 直接走 terminal）。

## 3. 插件 C：`llm-route-pool`（lib/route-pool.js）

### 导出

```js
export const name = 'llm-route-pool'
export function apply(ctx, config)
```

### 配置

```yaml
pools:
  - model: deepseek-flash          # 该池覆盖的模型 id（与 resolved.model 精确匹配）
    routes:                        # 有序候选路由
      - provider: vendor-a
      - provider: vendor-b
      - provider: vendor-c
        model: deepseek-flash-2    # 可选：该路由要改写成的模型 id；省略 = 保持原模型
codes: [QUOTA, ACCOUNT_QUOTA]      # 可选
patterns: []                       # 可选
cooldownMs: 600000                 # 可选，路由失败后的冷却时长，默认 10 分钟
maxSwitchesPerTurn: 3              # 可选，默认 3
dryRun: false                      # 可选：true 时只打日志、不记录冷却（便于联调）
```

配置校验失败 → warn + return，不抛异常。至少要有 1 个 pool，且每个 pool 有 `model` 和非空 `routes`。

### 运行时行为

状态：`Map<provider, cooldownUntilMs>`（模块/闭包级，apply 每次重新初始化）。
`SwitchBudget` 用于按 agent+turn 限制切换次数。

1. **监听 `agent/request`，必须 `{ prepend: true }`**：
   ```
   const resolved = await next()
   const pool = poolFor(resolved)                      // 按 model 匹配，见下
   if (!pool) return resolved
   const currentIndex = pool.routes.findIndex(r => r.provider === resolved.provider)
   if (currentIndex < 0) return resolved               // 当前 provider 不在池里：不动
   if (!isCooling(resolved.provider)) return resolved  // 当前健康：保持当前路由
   const target = 从 currentIndex 之后按池顺序环形找第一个 !isCooling(route.provider) 的路由
   if (!target) return resolved                        // 全都在冷却：交给正常请求/失败
   logger.info(...)                                    // provider A -> B（不含敏感数据）
   return { ...resolved, provider: target.provider, ...(target.model ? { model: target.model } : {}) }
   ```
   - `poolFor(resolved)`：返回第一个 `pool.model === resolved.model` 的池。
   - 环形查找要能跨过当前位置；同一 poll 内不重复访问。
   - **不要**只在"当前 provider 冷却"时才换：当前健康就绝不折腾。
2. **监听 `agent/request-error`**（非 prepend）：
   - `failure` 不匹配（`matchesFailure`）→ `next()`。
   - `payload.provider` 不在任何池中 → `next()`。
   - 预算 `take()` 失败 → `next()`。
   - 计算"是否存在至少一个其他健康路由"（排除当前 provider）：
     - 没有 → `next()`（不标记冷却也无意义；可 warn 一次）。
     - 有 → 标记当前 provider 冷却到 `Date.now() + cooldownMs`（`dryRun` 时跳过），
       `logger.warn`，`return { kind: 'retry' }`。
3. 冷却判定 `isCooling(provider)`：`now < until`；过期即视为健康（惰性清除，不做定时器）。
4. 所有日志不得包含 key / 凭据值；provider/model 名可以出现。

### 测试要求（`test/route-pool.test.mjs`，至少覆盖）

1. 当前 provider 健康 → `agent/request` 原样返回（provider 不变）。
2. QUOTA 失败 → 标记冷却、返回 `{kind:'retry'}`；随后 `agent/request` 把 provider 换成池中下一个。
3. 连续失败两把 key → 第三次请求换到第三条路由；三把都冷却后 `agent/request` 原样返回。
4. `route.model` 覆盖生效（切换后 `model` 字段被替换；未配置时保持不变）。
5. 其他字段（`reasoningEffort`、`maxTokens`）在改写时保留。
6. 非配额失败不触发、不冷却。
7. 冷却到期（`cooldownMs: 20` + 等待 ~30ms）后原 provider 重新可用（`agent/request` 保持原 provider）。
8. `maxSwitchesPerTurn` 限制：预算用完后不再 `{kind:'retry'}`。
9. 不在池中的 provider 不受影响。
10. `{ prepend: true }` 生效：注册一个"后注册但模拟 model-selection 行为"的
    `agent/request` 监听器（在 `next()` 后覆盖 provider），验证最终返回值是插件改写后的 provider。
    （即：先 `apply`，再注册另一个非 prepend 的监听器，dispatch 时插件应仍能覆盖它。）

## 4. 交付标准

- 两个测试文件全绿（`node --test`）。
- 不留 `console.log`；只用 `ctx.logger.*`。
- 文件内 JSDoc 用英文（与 DSH 源码风格一致），测试名可用中文/英文。
- 完成后在回复里报告：改了哪些文件、测试命令与结果、设计上偏离本规格的地方及原因。
