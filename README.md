# dsh-llm-keypool

**DeepSeek Harness（DSH）的多 Key / 多模型轮换池**：侧边栏图形面板 + 两个后台兜底插件。
额度用完自动换下一条，不手动改配置、不重启。

> 背景：DSH 内核一个 provider 路由只能配一个 `apiKeyEnv`，`dsh-llm-retry` 只在同一条路由同一把 key 上重试，
> 额度类错误默认直接失败；社区市场也没有现成的多 key / 路由池插件。这个 bundle 补上这一块。

## 功能

| 部分 | row id | 作用 |
|---|---|---|
| 能力 | 行 id | 说明 |
|---|---|---|
| **轮换池面板**（图形界面） | `llm-keypool` | 从 DSH 里**已经配好**的供应商和模型里勾选、排序，存成轮换池；显示当前路由、冷却中的供应商、最近切换记录 |
| **路由池 fallback** | `llm-keypool` | 当前路由额度用尽 → 冷却它 → 同一步自动改用池里的下一条（可跨供应商、跨模型） |
| **凭据轮换**（可选，默认关闭） | `llm-keypool` | 同一个供应商有多把 key 时，额度用尽自动把下一把 key 写进当前凭据引用 |

> 一个包只挂**一行**（`llm-keypool`）：DSH 的浏览器模块系统按包名识别 bundle，一个包挂多个 Loader 入口会
> 触发 `duplicate factory registration`。面板和两个兜底行为都由这一行加载。

- 面板入口：侧边栏「**轮换池**」一行（与「用量/余额」同款样式；侧栏收起时是圆形图标）。
- 池子按**顺序兜底**：第一条优先，额度用完换第二条，依此类推；当前健康时绝不折腾。
- 保存即生效（写入 `$DSH_HOME/keypool/route-pool.json`，下一次请求读取），**不需要重启**。
- 只处理额度类失败；不写 session 事件、不改历史、不碰凭据值日志。

## 安装

要求：DSH 内核 `>= 0.2.1-rc.2`。

### 从 GitHub 安装（推荐）

```sh
dsh plugin --profile web add github:NethielChou/dsh-llm-keypool
```

或在 DSH 桌面客户端「设置 → 插件」里用本地目录 / 仓库地址安装，然后**重启 DSH**（客户端代码在启动时加载）。

### 从 npm 安装

```sh
dsh plugin --profile web add @nethiel/dsh-llm-keypool
```

### 本地开发 / 手动挂载

```sh
git clone https://github.com/NethielChou/dsh-llm-keypool.git
dsh plugin --profile web add link:$(pwd)/dsh-llm-keypool
```

手动方式等价于：把仓库目录链接进 `profiles/<name>/node_modules/`，并在该 profile 的 `cordis.patch.yml`
插入 `cordis.patch.yml` 里的三行（面板行、route-pool 行启用，key-rotate 行 disabled）。
空池时面板行与 route-pool 行**完全不影响请求**。

## 使用

1. 重启 DSH，点侧边栏「轮换池」；
2. 「从已配置的模型里添加」→ 选供应商、选模型 → 加入池子；
3. ↑ ↓ 调整顺序（顺序就是兜底顺序）；
4. 需要时勾上「认证失败（401/403）也切换」（key 被吊销/失效时也自动换下一条；默认只对额度类错误生效）；
5. 「保存」；
6. 在面板「状态」里查看当前路由 / 冷却中的供应商 / 最近切换记录。

额度用尽时的行为：当前路由冷却（默认 10 分钟）+ 同一轮自动切到下一条健康的 `供应商/模型` 重试；
全部冷却则这一步正常失败，不会死循环。

## 配置参考

面板写入的是 `$DSH_HOME/keypool/route-pool.json`：

```json
{
  "pools": [
    {
      "name": "我的轮换池",
      "routes": [
        { "provider": "vendor-a", "model": "model-1" },
        { "provider": "vendor-b", "model": "model-2" }
      ]
    }
  ],
  "cooldownMs": 600000,
  "maxSwitchesPerTurn": 3,
  "codes": ["QUOTA", "ACCOUNT_QUOTA"]
}
```

- `codes` 是**触发切换的失败类型**：默认 `QUOTA / ACCOUNT_QUOTA`（额度类）。面板里的
  「认证失败（401/403）也切换」勾选项就是往这里加 `AUTH`；也可以在文件里直接写成
  `["QUOTA", "ACCOUNT_QUOTA", "AUTH"]`。
- 除了 `codes`，默认还会按中英文报错文案（余额不足/额度用尽/quota exceeded 等）判断；文案特殊时在行配置里加 `patterns`。

也可以不用面板，直接在 profile 的 `cordis.patch.yml` 写行配置（面板文件优先）：

```yaml
- id: llm-keypool
  disabled: false
  config:
    routePool:
      pools:
        - name: 手写池
          routes:
            - provider: vendor-a
              model: model-1
            - provider: vendor-b
              model: model-2
      cooldownMs: 600000
      maxSwitchesPerTurn: 3
      # codes: [QUOTA, ACCOUNT_QUOTA, AUTH]   # 可选：额外把哪些失败当作额度类错误
      # patterns: ['额度\s*(?:不足|用尽)']      # 可选：自定义报错文案正则（默认已含中英文常见措辞）
    keyRotate:
      enabled: false
```

凭据轮换（同一供应商多把 key）：

```yaml
- id: llm-keypool
  config:
    keyRotate:
      enabled: true
      activeRef: PROVIDER_KEY_ACTIVE        # provider 的 apiKeyEnv 指向的凭据引用
      refs: [PROVIDER_KEY_ACTIVE, PROVIDER_KEY_B, PROVIDER_KEY_C]
      maxSwitchesPerTurn: 3
```

> 也兼容 0.1.0 的扁平写法（`pools` / `codes` / `activeRef` / `refs` 直接写在行 config 顶层），
> 升级不会让旧配置失效。

> **为什么只有一个行？** DSH 的浏览器模块系统按**包名**识别 bundle，一个包同时挂多个 Loader 入口会被当成
> 组合错误（实测报 `duplicate factory registration`）。所以这个包只挂一行 `llm-keypool`，
> 路由池/凭据轮换两个行为由同一行在进程内应用。

> 内置的额度文案识别（可被 `patterns` 覆盖）：`insufficient quota/balance/credits`、`quota|usage limit exceeded`、
> `余额不足`、`额度用尽/耗尽/超限`、`配额不足`、`欠费`。如果供应商文案特殊，把实际文本加进 `patterns`。

## 工作原理

1. **凭据热切换**：`dsh-llm-pi-ai` 的 `resolveApiKey()` 每次请求都重新解析凭据引用，凭据服务文档也明确
   「轮换后的已存储密钥作用于下一次请求」——所以换 key 只需要改一个凭据值。
2. **同一步重试**：监听 `agent/request-error` 返回 `{ kind: 'retry' }`，agent loop 会在同一轮同一步重跑失败步骤；
   重试会重新走 `agent/request` waterfall 并重新解析凭据/路由。
3. **路由改写**：`agent/request` 监听器用 `{ prepend: true }` 注册——DSH 自己的会话模型选择也在该 waterfall 上，
   并且在 `next()` 之后覆盖 provider/model；不 prepend 就会被改回去。
4. **失败归因**：`agent/request-error` 只带 provider 不带 model，因此用「最近一次命中的池路由」归因，
   回退到「provider 在池中唯一」的匹配；只有 `provider + model` 同时命中池子才改写。

插件只写 `ctx.logger`，不 append 任何 session 事件（自造事件类型会让 Session 无法重新打开），
也不向 waterfall 抛异常。

## 验证

- 单元测试：`node --test test/*.mjs`，**45/45 通过**（配置解析/预算/中文文案/prepend 顺序/冷却恢复/
  面板三个回环端点/浏览器半区加载/闲时无副作用）。
- 端到端（真实 DSH headless + 本地 mock OpenAI 网关）：
  - 跨供应商跨模型兜底：`A/flash` 402 → 自动切 `B/chat`，`pong`、exit 0；
  - 全池耗尽：每条路由只试一次后正常失败，不死循环；BOM 配置、非法配置、只读降级均有覆盖。
- 真实网关验证（LiteLLM 兼容网关）：无效 key 返回 `401 AUTH` → 自动切换有效的 key → 同一步成功返回。
- 面板后端：`/api/keypool/catalog|config|status` 单元测试覆盖 200/400/403/405 与写入后即时生效。

## 已知限制

1. 供应商报错文案需要能被识别（默认覆盖中英文常见措辞；特殊文案加 `patterns`）。
2. 同一账号下的多把 key 可能共享额度，轮换前请确认额度独立。
3. 换 key / 换模型会让供应商侧前缀缓存失效，切换后的第一轮输入 token 重新计费（成本略增）。
4. 冷却状态在内存中，重启后清空（首个失败会重新标记，不影响正确性）。
5. 只覆盖 agent loop 的模型请求（`agent/request-error`）；`ctx.llm.stream()` 直连调用不受影响。
6. 面板依赖宿主 `sidebar.footer.action` 槽位与 `webServer` 回环端点（DSH Desktop / web profile 均满足）。

## 文件

```
index.js               bundle 根 + 面板 Host 半区（/api/keypool/* 三个回环端点）
lib/client.js          浏览器半区（侧边栏入口 + 轮换池面板）
lib/route-pool.js      路由池兜底
lib/key-rotate.js      凭据轮换
lib/runtime.js         配置文件读写 + 当前路由/冷却/切换记录
lib/shared.js          配额判断 / 预算 / 池子规范化
cordis.patch.yml       bundle patch（面板+route-pool 启用、key-rotate disabled）
test/                  单元测试（node:test，零依赖）
docs/spec.md           实现规格（内核契约、行为步骤）
```

## 卸载 / 回退

- 面板在「设置 → 插件」或 `dsh plugin --profile <name> remove @nethiel/dsh-llm-keypool`，重启即卸载；
- 只想停用：把对应行改 `disabled: true`，重启；
- 面板保存过的池子文件在 `$DSH_HOME/keypool/route-pool.json`，可随时删除。
- 卸载不会修改你的凭据文件。

## License

MIT © NethielChou
