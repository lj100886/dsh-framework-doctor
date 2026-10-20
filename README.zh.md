<p align="center">
  <img src="icon.svg" width="72" alt="框架医生图标">
</p>

# dsh-framework-doctor（框架医生）

[English](README.md) | 中文

一个 DeepSeek Harness 插件：给一个调用网址就自动配好模型，体检框架健康度，
并把能自动修的问题修掉。全部发生在独立的设置页里，没有任何后台任务。

## 它做什么

插件只加一个页面：**设置 → 框架医生**，里面四个区。

### ① 接入模型

粘贴调用网址和密钥，点「探测端点」，插件会去问 `{baseURL}/models` 拿模型清单，
然后逐个推导能力：

| 推导出的字段 | 来源 |
|---|---|
| 输入模态（`text` / `image`） | 端点元数据，其次模型家族表 |
| 上下文窗口、输出上限 | 端点元数据，其次家族表 |
| 思考档位 | 家族表（非推理模型则明确为 `false`） |
| `compat.thinkingFormat` | 家族表（`deepseek`、`qwen-chat-template`、`zai`、`openrouter`、`openai`） |

端点没说、家族表也推不出来的，一律**留空而不是猜**——思考档位配错会让整条
provider 请求失败。表格里会标注每一行是端点声明的还是推导的，写入前你能分清。

**已配置的提供方也能探测补齐**：从下拉框选一个，表单自动回填（沿用已存凭据，
不用重输密钥）。这种模式下的写入是**合并**：你手写的模型保留，端点新公布的追加，
能力字段按端点补齐。

密钥通过 harness 凭据服务保存，配置里只留 `apiKeyEnv` 引用，不写明文。

### ② 框架体检

23 条检查，18 条针对 `llm-pi-ai` 的 provider 配置，5 条针对运行时事实
（插件加载相位、已注册的 provider、默认模型）。

覆盖的都是真实会发生的故障：手写 provider 没写 `baseURL`、凭据引用落不了地、
`headers` 里躺着明文密钥、推理模型没写档位、**非推理模型被塞了档位**（每次请求
都会 400）、模型 id 重复、默认模型指向不存在的 provider，等等。

由**其它插件注册**的 provider 会报成 `external-provider`（提示级），而不是当成
配置缺失——判断一个 provider 是否真实存在，看的是它有没有注册到模型服务，
而不只是它有没有出现在这份配置里。

### ③ 和框架医生对话

一个对话框。你说想要什么，助手会先去查框架的真实状态再回答。它能在对话里按需
索取数据，有六个只读工具：

| 工具 | 返回什么 |
|---|---|
| `state` | 每个 provider 的网址、协议、凭据状态，以及**每个模型的模态/上下文/输出上限/思考档位**；默认模型；已注册的 route |
| `diagnose` | 完整体检结果与严重度 |
| `plugins` | 插件清单：包名、是否启用、加载相位 |
| `tools` | 这个智能体现在能调用哪些工具 |
| `provider` | 某个 provider 的完整配置（密钥已脱敏） |
| `probe` | 实时访问端点 |

助手写 `TOOL: {"name":"...","args":{...}}`，宿主去执行并把结果回喂给它，最多 4 轮。
页面上会显示它查了哪些工具。

助手建议的**任何会改东西的操作**都渲染成按钮，要你按下才执行：重新体检、一键修复、
修复某条、探测端点、探测并写入配置。模型不会自己改配置。

### ④ 一键修复

可自动修的问题一键应用。修复以 `settings.mutate` 操作生成：**只生成 `set`，从不
生成 `unset`**，只有两个刻意的例外（删掉重复的模型 id；给不该有档位的模型把
`reasoningEfforts` 设为 `false`）。

### 会话故障转移

模型调用因为**可重试的错误**中断时——`RATE_LIMIT`（429）、`QUOTA`、`SERVER`、
`TIMEOUT`、`TRANSPORT`、`EMPTY_RESPONSE`——插件会去**已配置的其它渠道里找同一个
模型**接上去重试，让会话继续跑，而不是卡在那里。

它挂在两个 harness 事件上：

| 事件 | 作用 |
|---|---|
| `agent/request-error` | 决定要不要换渠道。返回 `{ kind: 'retry' }` 会让 agent loop 在**同一个 turn 和 step 内**重试。 |
| `agent/request` | 把这次重试的 provider/model 换成挑好的渠道。 |

挑选很保守：

1. 别的 provider 里有**完全同名的模型**，且那个 provider 有 `baseURL`、已注册到模型服务；
2. 退一步，**去掉 vendor 前缀后同名**（网关上的 `deepseek/deepseek-v3` 和别处的 `deepseek-v3`）；
3. 两者都没有，就让错误照常终止——**不会偷偷换成另一个模型**。

失败过的路由进入冷却，但**冷却时长由错误类型决定**，不是写死的：额度用尽等得远比限流久，
网关 5xx 或网络抖动能更快重试。端点自己给的 `Retry-After` 优先；如果它说"1 秒后再来"，
插件就就地重试，不折腾换渠道。同一渠道连续失败会让冷却翻倍，成功一次则清零。

每次失败还会记成一份**渠道健康档案**——错误类型、严重度、是不是额度/计费问题、连续失败
次数、剩余冷却。对话框可以通过 `channel-health` 工具读它，回答「哪个渠道坏了、坏到什么程度、
要不要充值、大概什么时候恢复」。**判断在对话里做**：重试路径本身绝不调模型（它在失败路径上，
调模型可能死锁、还会拖慢重试），所以换渠道决策是确定性且瞬时完成的，解释则由模型事后补上。

可以关掉或限制冷却上限：

```yaml
- id: framework-doctor
  config:
    failover: true
    failoverMaxCooldownMs: 3600000
```

### 框架医生用哪个模型

对话框不必和你的默认模型共用。配一条降级链，框架医生会按顺序往下走，一跳失败就换下一跳——
这样第一个渠道 429 的时候，不会得到一个「自己也不会诊断了」的医生：

```yaml
- id: framework-doctor
  config:
    model:
      chain:
        - provider: cheap-chan
          model: deepseek-v4.1-flash
        - provider: reliable-chan
          model: deepseek-v4.1-flash
      fallbackToDefaultModel: true   # 把会话默认模型作为最后的兜底
```

不写 `model.chain` 就是跟随默认模型，和以前一样。页面上会按顺序显示这条链，
正在冷却的那一跳会变暗。

### 额度问题

当失败看起来是额度或限流而不是端点坏了，页面会明确说出来，并给你一个按钮跳到真正管
余额的那一页。**它自己读不到余额**——原因见下一节。

## 为什么它读不到别家插件的余额

`dsh-our-free-model` 这类渠道插件把余额、积分、账号放在自己的界面里。我实际查过：

- 它的 stats 里只有用量（token 数、调用次数、失败数、延迟），**没有余额或积分字段**；
- 它的 HTTP 接口在浏览器凭据围栏后面。Host 端请求 `/api/our-free-model/summary` 得到
  **401**；而且它没有 `ctx.provide()` 任何服务供别的插件调用。

所以框架医生告诉你的是**问题的形状**（「这看着是额度用完了，重试没用，是这个渠道」），
并把你送到管账号的那一页。显示别家的余额只能靠猜，而这里的错数字比没有数字更糟。

## 安装

```sh
dsh plugin --profile <你的 profile> add dsh-framework-doctor
```

或从本地目录安装：

```sh
dsh plugin --profile <你的 profile> add /绝对路径/dsh-framework-doctor
```

页面没出现就重启 `dsh web`，然后打开 **设置 → 框架医生**。

## 它刻意不做的事

- **没有后台扫描。** 体检只在你点按钮时跑，没有定时器也没有轮询。
- **不会自动改配置。** 每一次写入都来自你在接入向导里点的那一下，或你按下助手
  建议的动作按钮。
- **不落明文密钥。** 密钥进凭据服务；`headers` 里出现明文密钥会被检查出来并报告。
- **不猜。** 无法验证的模型能力一律留空。

## 环境要求

- DeepSeek Harness `>=0.2.0`（`engines.dsh`，同时在 `dsh.compatibility` 里声明）
- Node.js `>=20.18`
- 仅「对话」区需要一个已配置的默认模型；其余功能不依赖它。

无运行时依赖，只用 Node 内置模块和注入的 harness 服务。

## 开发

```sh
node tests/run-all.mjs    # 或：npm test
```

三套测试，都不需要跑起 harness：

| 套件 | 检查什么 |
|---|---|
| `tests/framework-doctor-lib.mjs` | `lib/infer.js` 的能力推导、`lib/diagnose.js` 的规则、`lib/repair.js` 的计划，以及对着本地假 OpenAI 兼容端点的端到端探测 |
| `tests/framework-doctor-failover.mjs` | 可重试错误的分类、渠道挑选、冷却记账，以及"429 → 换渠道 → retry"的 Host 接线 |
| `tests/framework-doctor-host.mjs` | Host 路由、`/apply` 的校验与合并语义、`/chat` 的工具循环、信任围栏、缺服务时的降级 |
| `tests/framework-doctor-client.mjs` | 在桩出来的模块加载器和 React 下加载 `client.js`，渲染每个区，并检查主题 token 与边界约束 |

### 文件结构

| 文件 | 职责 |
|---|---|
| `index.js` | Host 入口：HTTP 路由、配置读写、对话的工具循环 |
| `client.js` | 设置页（纯 JS + `createElement`，无需构建） |
| `lib/infer.js` | 端点探测与能力推导 |
| `lib/diagnose.js` | 体检规则 |
| `lib/repair.js` | 把问题转成 `settings.mutate` 操作 |
| `lib/failover.js` | 可重试错误的分类与同模型渠道挑选 |
| `lib/trust.js` | 插件 HTTP 面的请求信任围栏 |

## 许可

MIT —— 见 [LICENSE](LICENSE)。