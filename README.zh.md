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
| `lib/trust.js` | 插件 HTTP 面的请求信任围栏 |

## 许可

MIT —— 见 [LICENSE](LICENSE)。