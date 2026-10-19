/**
 * dsh-framework-doctor / lib/infer.js
 *
 * 端点探测 + 模型能力 / 思考档位 / 兼容性推导。
 *
 * 用户的原话是「我只需要告诉他这是哪家的调用网址，他就自动帮我配置好输入输出、
 * 思考深度之类的东西」。所以这个模块要做的是：
 *
 *   1. 去端点问一次 `/models`，把端点**真正公布**的元数据捞回来；
 *   2. 端点没说的部分，用模型家族知识补 —— 但补出来的必须标 `confidence: 'inferred'`；
 *   3. 推不出来就留空，绝不瞎填。配错的思考档位会让整个 provider 请求失败，
 *      配错的上下文上限会在长对话里静默截断，都比"留空"危险得多。
 *
 * 纯逻辑 + 网络，零第三方依赖，只用 `node:` 内置模块。
 * 无顶层副作用、无顶层 await —— 模块必须能被纯 import 加载。
 *
 * 导出：inferModel / inferProvider / readListing / probeEndpoint / FAMILIES /
 *       VISION_HINTS / REASONING_HINTS
 */

import { Buffer } from 'node:buffer'

/** 响应体上限：模型清单正常只有几十 KiB，超过 4 MiB 一定是返回了别的东西。 */
const MAX_LISTING_BYTES = 4 * 1024 * 1024

/** 单次探测超时。网关冷启动偶尔要几秒，15 秒是"能等但不至于卡死"的折中。 */
const PROBE_TIMEOUT_MS = 15_000

/** 只允许出现在 `input` 里的模态：dsh 的 schema 只认这两个。 */
const ALLOWED_MODALITIES = ['text', 'image']

/* ------------------------------------------------------------------ *
 * 通用小工具
 * ------------------------------------------------------------------ */

/**
 * 数字字段容错：只接受正整数。
 *
 * 端点返回的 `context_length` 可能是字符串 `"128000"`、可能是 `0`、
 * 也可能是 `null`。后两种都视为"没说"。
 *
 * @param {...unknown} values - 按优先级排列的候选值。
 * @returns {number|undefined} 第一个可用的正整数。
 */
function positiveInt(...values) {
  for (const value of values) {
    const num = typeof value === 'string' ? Number(value) : value
    if (typeof num === 'number' && Number.isFinite(num) && num > 0) return Math.round(num)
  }
  return undefined
}

/**
 * 把各家写法的模态字段归一成 dsh 认识的 `text` / `image`。
 *
 * audio / video / file 一律丢弃：dsh 的 schema 只认 text 与 image，
 * 多写一个字段会让整份配置校验失败。
 *
 * @param {unknown} values - 端点给的模态数组。
 * @returns {string[]} 归一后的模态；可能是空数组（= 端点等于什么都没说）。
 */
function normalizeModalities(values) {
  const out = []
  if (!Array.isArray(values)) return out
  for (const value of values) {
    if (typeof value !== 'string') continue
    const folded = value.trim().toLowerCase()
    if (ALLOWED_MODALITIES.includes(folded) && !out.includes(folded)) out.push(folded)
  }
  return out
}

/** 字符串字段容错：非空字符串才算有值。 */
function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/**
 * baseURL 是否指向本机回环。
 *
 * 判据与 dsh 保持一致：127.0.0.1 / localhost / [::1]。
 * 自托管的 vLLM、SGLang、llama.cpp 都在这里。
 *
 * @param {unknown} baseURL - 端点地址。
 * @returns {boolean} 是否本地回环。
 */
function isLoopback(baseURL) {
  return /^(https?:\/\/)?(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i.test(String(baseURL ?? ''))
}

/* ------------------------------------------------------------------ *
 * 视觉 / 推理线索
 * ------------------------------------------------------------------ */

/**
 * 模型名里的视觉线索。只用于"建议"，不当作已确认事实。
 *
 * 端点没说模态时，命中这里才补 `image`，并在 notes 里写明是按名称推测的。
 * 反过来不命中也不代表不支持看图 —— 只是我们不敢猜。
 */
export const VISION_HINTS = [
  /(^|[^a-z])vl([^a-z]|$)/i,
  /vision/i,
  /omni/i,
  /llava/i,
  /pixtral/i,
  /internvl/i,
  /glm-4v/i,
  /-4o\b/i,
  /gemini/i,
  /claude-3/i,
  /claude-sonnet-4/i,
  /claude-opus-4/i,
  /gpt-4\.1/i,
  /gpt-5/i,
  /qwen2?\.?5-vl/i,
  /image/i,
]

/**
 * 模型名里的推理线索。只用于提醒与冲突检测，不单独决定档位。
 *
 * 家族表判定不出来时，即使命中这里也不填 `reasoningEfforts` ——
 * 各家思考档位的线上拼写不一样，猜错就是请求失败。
 */
export const REASONING_HINTS = [
  /reason/i,
  /thinking/i,
  /(^|[-_/ ])r1([-_.]|$)/i,
  /qwq/i,
  /(^|[-_/ ])o[134]([-_.]|$)/i,
  /glm-z1/i,
  /magistral/i,
  /qwen3/i,
  /gpt-5/i,
  /gemini-2\.5/i,
]

/* ------------------------------------------------------------------ *
 * 思考档位预设
 *
 * 键固定为 off|minimal|low|medium|high|xhigh|max 的子集，
 * 值是该档在线上要发送的拼写（多数等于键本身）。
 * `off: null` 表示"关闭思考 = 不发送这个参数"。
 * ------------------------------------------------------------------ */

/** deepseek 系（deepseek-reasoner / r1 / v3.2 的 thinking 模式）。 */
const EFFORTS_DEEPSEEK = { off: null, low: 'low', medium: 'medium', high: 'high' }

/** qwen3 系（enable_thinking + 思考预算档）。 */
const EFFORTS_QWEN = { off: null, low: 'low', medium: 'medium', high: 'high' }

/** glm / zai 系（thinking: { type: ... } 的档位映射）。 */
const EFFORTS_ZAI = { off: null, low: 'low', medium: 'medium', high: 'high' }

/** OpenAI o 系 / gpt-5：多一档 minimal。 */
const EFFORTS_OPENAI = { off: null, minimal: 'minimal', low: 'low', medium: 'medium', high: 'high' }

/** claude thinking 系。 */
const EFFORTS_CLAUDE = { off: null, low: 'low', medium: 'medium', high: 'high' }

/** kimi thinking 系：只有中 / 高两档。 */
const EFFORTS_KIMI = { off: null, medium: 'medium', high: 'high' }

/* ------------------------------------------------------------------ *
 * 家族表
 *
 * 有序数组：先精确家族、后通用家族，遍历取第一个命中
 * （`deepseek-r1` 必须先于 `deepseek`，`openai-gpt5` 必须先于 `openai-gpt4`）。
 *
 * 为了让 B/C 既能遍历又能按 key 取值，数组元素同时以
 * `FAMILIES.deepseek` 这种非枚举属性的形式挂回数组本身 ——
 * `for (const f of FAMILIES)` 与 `FAMILIES[family].contextWindow` 都成立。
 * ------------------------------------------------------------------ */

/**
 * @typedef {object} Family
 * @property {string} key - 家族标识，同时是 `FAMILIES[key]` 的键。
 * @property {string} label - 展示用中文名。
 * @property {RegExp|null} match - 模型 id / name 的匹配正则；`null` 表示永不命中。
 * @property {number|undefined} contextWindow - 家族典型上下文上限（推不出来时留 undefined）。
 * @property {number|undefined} maxTokens - 家族典型输出上限。
 * @property {boolean} vision - 家族是否普遍支持看图。
 * @property {true|false|null} reasoning - 是否推理模型；`null` 表示不知道。
 * @property {string|null} thinkingFormat - 推理派发格式；非推理家族为 null。
 * @property {Record<string, string|null>|null} efforts - 思考档位预设。
 */

/** @type {Family[]} */
export const FAMILIES = [
  {
    key: 'deepseek-r1',
    label: 'DeepSeek 推理模型',
    match: /deepseek[-_. ]?(r1|reasoner|thinking)/i,
    contextWindow: 131072,
    maxTokens: 65536,
    vision: false,
    reasoning: true,
    thinkingFormat: 'deepseek',
    efforts: EFFORTS_DEEPSEEK,
  },
  {
    key: 'deepseek',
    label: 'DeepSeek',
    match: /deepseek/i,
    contextWindow: 131072,
    maxTokens: 8192,
    vision: false,
    reasoning: true,
    thinkingFormat: 'deepseek',
    efforts: EFFORTS_DEEPSEEK,
  },
  {
    key: 'qwen',
    label: '通义千问',
    match: /qwen|qwq|tongyi|dashscope/i,
    contextWindow: 131072,
    maxTokens: 16384,
    vision: false,
    reasoning: true,
    thinkingFormat: 'qwen-chat-template',
    efforts: EFFORTS_QWEN,
  },
  {
    key: 'glm',
    label: '智谱 GLM',
    match: /glm|chatglm|zhipu|z\.ai/i,
    contextWindow: 131072,
    maxTokens: 16384,
    vision: false,
    reasoning: true,
    thinkingFormat: 'zai',
    efforts: EFFORTS_ZAI,
  },
  {
    key: 'kimi',
    label: '月之暗面 Kimi',
    match: /kimi|moonshot/i,
    contextWindow: 131072,
    maxTokens: 16384,
    vision: false,
    reasoning: true,
    thinkingFormat: 'openai',
    efforts: EFFORTS_KIMI,
  },
  {
    key: 'openai-gpt5',
    label: 'OpenAI GPT-5',
    match: /gpt[-_. ]?5/i,
    contextWindow: 272000,
    maxTokens: 128000,
    vision: true,
    reasoning: true,
    thinkingFormat: 'openai',
    efforts: EFFORTS_OPENAI,
  },
  {
    key: 'openai-o',
    label: 'OpenAI o 系列',
    match: /(^|[-_/ ])o[134]([-_. ]|$)/i,
    contextWindow: 200000,
    maxTokens: 100000,
    vision: true,
    reasoning: true,
    thinkingFormat: 'openai',
    efforts: EFFORTS_OPENAI,
  },
  {
    key: 'openai-gpt4',
    label: 'OpenAI GPT-4',
    match: /gpt[-_. ]?4|chatgpt[-_. ]?4/i,
    contextWindow: 128000,
    maxTokens: 16384,
    vision: true,
    reasoning: false,
    thinkingFormat: null,
    efforts: null,
  },
  {
    key: 'claude',
    label: 'Anthropic Claude',
    match: /claude/i,
    contextWindow: 200000,
    maxTokens: 64000,
    vision: true,
    reasoning: true,
    thinkingFormat: 'openai',
    efforts: EFFORTS_CLAUDE,
  },
  {
    key: 'gemini',
    label: 'Google Gemini',
    match: /gemini/i,
    contextWindow: 1048576,
    maxTokens: 65536,
    vision: true,
    reasoning: true,
    thinkingFormat: 'openai',
    efforts: EFFORTS_OPENAI,
  },
  {
    key: 'llama',
    label: 'Meta Llama',
    match: /llama|meta-llama/i,
    contextWindow: 131072,
    maxTokens: 8192,
    vision: false,
    reasoning: false,
    thinkingFormat: null,
    efforts: null,
  },
  {
    key: 'mistral',
    label: 'Mistral',
    match: /mistral|mixtral|codestral|magistral|devstral/i,
    contextWindow: 131072,
    maxTokens: 8192,
    vision: false,
    reasoning: false,
    thinkingFormat: null,
    efforts: null,
  },
  {
    key: 'minimax',
    label: 'MiniMax',
    match: /minimax|abab/i,
    contextWindow: 204800,
    maxTokens: 8192,
    vision: false,
    reasoning: false,
    thinkingFormat: null,
    efforts: null,
  },
  {
    key: 'doubao',
    label: '字节豆包',
    match: /doubao|seed-oss|volcengine/i,
    contextWindow: 131072,
    maxTokens: 8192,
    vision: false,
    reasoning: false,
    thinkingFormat: null,
    efforts: null,
  },
  {
    key: 'ernie',
    label: '百度文心',
    match: /ernie|wenxin/i,
    contextWindow: 131072,
    maxTokens: 8192,
    vision: false,
    reasoning: false,
    thinkingFormat: null,
    efforts: null,
  },
  {
    key: 'hunyuan',
    label: '腾讯混元',
    match: /hunyuan/i,
    contextWindow: 262144,
    maxTokens: 8192,
    vision: false,
    reasoning: false,
    thinkingFormat: null,
    efforts: null,
  },
  {
    key: 'sensenova',
    label: '商汤日日新',
    match: /sensenova|sense[-_ ]?nova/i,
    contextWindow: 131072,
    maxTokens: 8192,
    vision: false,
    reasoning: false,
    thinkingFormat: null,
    efforts: null,
  },
  {
    key: 'unknown',
    label: '未知家族',
    match: null,
    contextWindow: undefined,
    maxTokens: undefined,
    vision: false,
    reasoning: null,
    thinkingFormat: null,
    efforts: null,
  },
]

/* 按 key 取值的快捷方式：非枚举，所以 `Object.keys(FAMILIES)` 仍只返回下标。 */
for (const family of FAMILIES) {
  Object.defineProperty(FAMILIES, family.key, { value: family, enumerable: false, writable: false })
}

/**
 * 按模型 id + name 匹配家族，取第一个命中。
 *
 * @param {string} id - 模型 id。
 * @param {string} name - 模型显示名。
 * @returns {Family} 命中的家族；都没命中返回 `unknown`。
 */
function resolveFamily(id, name) {
  const haystack = `${id ?? ''} ${name ?? ''}`
  for (const family of FAMILIES) {
    if (family.match !== null && family.match.test(haystack)) return family
  }
  return FAMILIES[FAMILIES.length - 1]
}

/**
 * 按 key 取家族（B/C 也可能用得上）。
 *
 * @param {string} key - 家族标识。
 * @returns {Family|undefined} 家族条目。
 */
function familyOf(key) {
  return FAMILIES.find((family) => family.key === key)
}

/* ------------------------------------------------------------------ *
 * readListing
 * ------------------------------------------------------------------ */

/**
 * 解析端点返回的模型清单。
 *
 * 兼容三种形态：
 *   - `{ data: [...] }`            OpenAI 标准
 *   - `{ models: { id: {...} } }`  部分网关（key 就是 id）
 *   - `[...]`                      裸数组
 *
 * 每条归一成 `RawModelRow = { id, name, raw }`，`id` 取
 * `id | model | slug | map 的 key`，跳过无 id 的条目。
 *
 * @param {unknown} body - 已解析的 JSON。
 * @returns {Array<{id: string, name: string, raw: object}>} 归一后的模型行。
 * @throws {Error} 形状不是模型清单时抛中文错误。
 */
export function readListing(body) {
  let listed
  if (Array.isArray(body)) {
    listed = body.map((raw) => ({ raw }))
  } else if (body && typeof body === 'object' && Array.isArray(body.data)) {
    listed = body.data.map((raw) => ({ raw }))
  } else if (body && typeof body === 'object' && body.models && typeof body.models === 'object' && !Array.isArray(body.models)) {
    listed = Object.entries(body.models).map(([key, raw]) => ({ key, raw }))
  } else {
    throw new Error('端点返回的不是模型清单（既没有 data 数组，也没有 models 对象）')
  }

  const rows = []
  for (const { key, raw } of listed) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const entry = raw
    const id = nonEmptyString(entry.id) ?? nonEmptyString(entry.model) ?? nonEmptyString(entry.slug) ?? nonEmptyString(key)
    if (id === undefined) continue
    const name = nonEmptyString(entry.name) ?? nonEmptyString(entry.display_name) ?? id
    rows.push({ id, name, raw: entry })
  }
  return rows
}

/* ------------------------------------------------------------------ *
 * inferModel
 * ------------------------------------------------------------------ */

/**
 * 读出一条模型记录声明的输入模态。
 *
 * 顺序按契约：architecture.input_modalities → input_modalities →
 * inputModalities → capabilities.input_modalities → modalities.input →
 * architecture.modality（`"text+image->text"`）→ capabilities.vision。
 *
 * @param {object} raw - 端点返回的单条模型记录。
 * @returns {{input: string[]|undefined, source: string}} `input` 为 undefined
 *   表示端点没说；`source` 记录读自哪个字段，便于排查。
 */
function extractModalities(raw) {
  const candidates = [
    ['architecture.input_modalities', raw?.architecture?.input_modalities],
    ['input_modalities', raw?.input_modalities],
    ['inputModalities', raw?.inputModalities],
    ['capabilities.input_modalities', raw?.capabilities?.input_modalities],
    ['modalities.input', raw?.modalities?.input],
  ]
  for (const [source, value] of candidates) {
    const input = normalizeModalities(value)
    if (input.length > 0) return { input, source }
  }
  /* OpenRouter 早期用 architecture.modality: "text+image->text" 这种单字符串。 */
  const modality = raw?.architecture?.modality
  if (typeof modality === 'string' && modality.includes('->')) {
    const input = normalizeModalities(modality.split('->')[0].split('+'))
    if (input.length > 0) return { input, source: 'architecture.modality' }
  }
  if (raw?.capabilities?.vision === true) {
    return { input: ['text', 'image'], source: 'capabilities.vision' }
  }
  return { input: undefined, source: '' }
}

/**
 * 选择思考派发格式。
 *
 * 契约规则：deepseek → deepseek；qwen → qwen-chat-template（本地自托管
 * vLLM/SGLang 则 chat-template）；glm/zai → zai；openrouter 中转 →
 * openrouter；其它 → openai。
 *
 * @param {Family} family - 命中的家族。
 * @param {{baseURL?: string, api?: string}} context - 路由上下文。
 * @returns {string} thinkingFormat 取值。
 */
function pickThinkingFormat(family, context) {
  const baseURL = String(context?.baseURL ?? '')
  if (/openrouter/i.test(baseURL)) return 'openrouter'
  if (family.key === 'qwen' && isLoopback(baseURL)) return 'chat-template'
  return family.thinkingFormat ?? 'openai'
}

/**
 * 推导单个模型的能力。
 *
 * 字段缺省表示"端点没说、也推不出来"，不要瞎填。
 *
 * @param {{id?: string, name?: string, raw?: object}|object} entry -
 *   `readListing()` 的 `RawModelRow`，或直接是端点原始记录。
 * @param {{baseURL?: string, api?: string}} [context] - 路由上下文。
 * @returns {{id: string, name: string, input?: string[], contextWindow?: number,
 *   maxTokens?: number, reasoningEfforts?: false|Record<string, string|null>,
 *   compat?: {thinkingFormat?: string, supportsReasoningEffort?: boolean},
 *   notes: string[], confidence: 'declared'|'inferred'|'unknown'}} 推导结果。
 */
export function inferModel(entry, context = {}) {
  const raw = entry && typeof entry === 'object' && entry.raw && typeof entry.raw === 'object'
    ? entry.raw
    : (entry && typeof entry === 'object' ? entry : {})
  const id = nonEmptyString(entry?.id) ?? nonEmptyString(raw.id) ?? nonEmptyString(raw.model) ?? nonEmptyString(raw.slug) ?? ''
  const name = nonEmptyString(entry?.name) ?? nonEmptyString(raw.name) ?? nonEmptyString(raw.display_name) ?? id
  const family = resolveFamily(id, name)
  const notes = []

  /* ---------------- 1) 输入模态 ---------------- */
  const declaredModalities = extractModalities(raw)
  let input
  let inputDeclared = false
  if (declaredModalities.input !== undefined) {
    inputDeclared = true
    input = [...declaredModalities.input]
    /* 端点只写了 image 时补上 text：纯图片输入的模型实际上不存在。 */
    if (input.includes('image') && !input.includes('text')) {
      input.unshift('text')
      notes.push('端点只声明了图片输入，已补上文本输入')
    }
  } else {
    const visionHint = VISION_HINTS.some((re) => re.test(id) || re.test(name))
    if (visionHint || family.vision === true) {
      input = ['text', 'image']
      notes.push(
        visionHint
          ? '端点未声明输入模态，按模型名称推测支持看图'
          : `端点未声明输入模态，按 ${family.label} 家族推测支持看图`,
      )
    } else {
      input = ['text']
      notes.push('端点未声明输入模态，按纯文本处理')
    }
  }

  /* ---------------- 2) 上下文 / 输出上限 ---------------- */
  const declaredContext = positiveInt(
    raw.contextWindow,
    raw.context_window,
    raw.context_length,
    raw.max_input_tokens,
    raw.limit?.context,
    raw.max_context_length,
  )
  const contextWindow = declaredContext ?? family.contextWindow
  const contextFromFamily = declaredContext === undefined && contextWindow !== undefined
  if (contextFromFamily) notes.push(`上下文上限按 ${family.label} 家族表推测为 ${contextWindow}`)

  const declaredMax = positiveInt(
    raw.maxOutputTokens,
    raw.max_output_tokens,
    raw.maxTokens,
    raw.max_tokens,
    raw.limit?.output,
    raw.top_provider?.max_completion_tokens,
  )
  const maxTokens = declaredMax ?? family.maxTokens
  const maxFromFamily = declaredMax === undefined && maxTokens !== undefined
  if (maxFromFamily) notes.push(`输出上限按 ${family.label} 家族表推测为 ${maxTokens}`)

  /* ---------------- 3) 思考档位 ---------------- */
  const declaredReasoning = typeof raw.reasoning === 'boolean'
    ? raw.reasoning
    : (typeof raw.capabilities?.reasoning === 'boolean' ? raw.capabilities.reasoning : undefined)

  let reasoning
  let reasoningEfforts
  if (declaredReasoning === false) {
    reasoning = false
    reasoningEfforts = false
    notes.push('端点声明该模型不支持思考，已关闭思考档位')
  } else if (declaredReasoning === true) {
    reasoning = true
    if (family.reasoning === false) {
      /* 端点与家族表冲突：端点是更直接的事实，但档位拼写只能按通用 OpenAI 拼写猜。 */
      reasoningEfforts = { ...EFFORTS_OPENAI }
      notes.push(`端点声明支持思考，但 ${family.label} 家族表判定为非推理模型，档位按通用拼写推测，请实机验证`)
    } else if (family.efforts) {
      reasoningEfforts = { ...family.efforts }
      notes.push(`思考档位按 ${family.label} 家族表给出`)
    } else {
      notes.push('端点声明支持思考，但未识别家族，无法确定档位拼写，已留空')
    }
  } else if (family.reasoning === true) {
    reasoning = true
    reasoningEfforts = { ...family.efforts }
    notes.push(`端点未声明思考能力，按 ${family.label} 家族表判定为推理模型`)
  } else if (family.reasoning === false) {
    reasoning = false
    reasoningEfforts = false
    notes.push(`端点未声明思考能力，按 ${family.label} 家族表判定为非推理模型`)
  } else {
    /* 家族未知、端点也没说：留空比猜错安全。 */
    notes.push('未识别是否支持思考档位，已留空')
  }

  /* ---------------- 4) compat.thinkingFormat ---------------- */
  let compat
  if (reasoning === true) {
    const api = typeof context?.api === 'string' ? context.api : ''
    if (api === 'anthropic-messages' || api === 'openai-responses') {
      /*
       * thinkingFormat 与 supportsReasoningEffort 都是 openai-completions 的
       * compat 字段。写到 anthropic / responses 路由上会被配置校验拒绝，
       * 整条 provider 直接失效 —— 所以这里宁可留空并说明。
       */
      notes.push(`${api} 协议不写 thinkingFormat（该协议不接受这个兼容字段），思考由模型自身控制`)
    } else {
      compat = {
        thinkingFormat: pickThinkingFormat(family, context ?? {}),
        supportsReasoningEffort: true,
      }
      notes.push(`思考派发格式按 ${compat.thinkingFormat} 处理`)
    }
  }

  /* ---------------- 5) 置信度 ---------------- */
  let confidence = 'declared'
  if (!inputDeclared || contextFromFamily || maxFromFamily) confidence = 'inferred'
  if (family.key === 'unknown' && !inputDeclared && declaredContext === undefined && declaredMax === undefined) {
    confidence = 'unknown'
  }

  /** @type {Record<string, unknown>} */
  const result = { id, name, input, notes, confidence }
  if (contextWindow !== undefined) result.contextWindow = contextWindow
  if (maxTokens !== undefined) result.maxTokens = maxTokens
  if (reasoningEfforts !== undefined) result.reasoningEfforts = reasoningEfforts
  if (compat !== undefined) result.compat = compat
  return result
}

/* ------------------------------------------------------------------ *
 * inferProvider
 * ------------------------------------------------------------------ */

/**
 * 按 baseURL 猜协议。
 *
 * @param {string} baseURL - 端点地址。
 * @returns {string} `anthropic-messages` 或 `openai-completions`。
 */
function guessApi(baseURL) {
  const value = String(baseURL ?? '')
  if (/anthropic/i.test(value)) return 'anthropic-messages'
  /* openai.com/v1、openrouter 与本地回环都是 OpenAI 兼容协议。 */
  return 'openai-completions'
}

/**
 * 从端点地址推一个能看的显示名。
 *
 * @param {string} baseURL - 端点地址。
 * @returns {string|undefined} hostname；解析不出来时 undefined。
 */
function deriveDisplayName(baseURL) {
  try {
    const parsed = new URL(String(baseURL ?? ''))
    return parsed.hostname || undefined
  } catch {
    return undefined
  }
}

/**
 * 推导整条提供方（route）的配置。
 *
 * @param {{baseURL?: string, api?: string, displayName?: string, models?: unknown[]}} input -
 *   用户填的接入信息与端点公布的模型行。
 * @returns {{api: string, baseURL: string, displayName: string,
 *   models: object[], notes: string[]}} 归一后的 route 描述。
 */
export function inferProvider({ baseURL, api, displayName, models } = {}) {
  const notes = []
  const url = nonEmptyString(baseURL) ?? ''
  const guessedApi = guessApi(url)
  const finalApi = nonEmptyString(api) ?? guessedApi
  if (nonEmptyString(api) === undefined) notes.push(`未指定协议，按地址猜测为 ${finalApi}`)

  const list = Array.isArray(models) ? models : []
  if (list.length === 0) notes.push('没有可推导的模型：请先探测端点或手动填写模型 id')

  const name = nonEmptyString(displayName) ?? deriveDisplayName(url) ?? '未命名提供方'
  if (isLoopback(url)) {
    notes.push('本地回环端点：本地服务通常不校验密钥，但仍需要一个占位密钥，否则请求会在构造阶段失败')
  }
  if (/openrouter/i.test(url)) notes.push('OpenRouter 中转：思考格式按 openrouter 处理，模型清单里的定价与模态字段最完整')

  const inferredModels = list.map((entry) => inferModel(entry, { baseURL: url, api: finalApi }))
  return { api: finalApi, baseURL: url, displayName: name, models: inferredModels, notes }
}

/* ------------------------------------------------------------------ *
 * probeEndpoint
 * ------------------------------------------------------------------ */

/**
 * 按协议拼出模型清单地址候选。
 *
 * @param {string} base - 已去掉尾部斜杠的 baseURL。
 * @param {string} api - 协议。
 * @returns {string[]} 依次尝试的地址。
 */
function listingCandidates(base, api) {
  if (api === 'anthropic-messages') {
    return [base.endsWith('/v1') ? `${base}/models?limit=1000` : `${base}/v1/models?limit=1000`]
  }
  return base.endsWith('/v1') ? [`${base}/models`] : [`${base}/models`, `${base}/v1/models`]
}

/**
 * 把 fetch 的异常翻译成人话。
 *
 * @param {unknown} error - fetch 抛出的错误。
 * @param {AbortSignal|undefined} outerSignal - 调用方的取消信号。
 * @returns {string} 中文原因。
 */
function describeFetchError(error, outerSignal) {
  if (outerSignal?.aborted) return '请求已取消'
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') return `请求超时（${PROBE_TIMEOUT_MS / 1000} 秒）`
    const cause = error.cause
    if (cause && typeof cause === 'object' && typeof cause.code === 'string') return `${error.message}（${cause.code}）`
    return error.message
  }
  return String(error)
}

/**
 * 去端点问一次模型清单，并把每条记录推导成 `InferredModel`。
 *
 * 出错抛 `Error`，message 用中文且能直接展示给用户（设置页会原样显示）。
 *
 * @param {{baseURL?: string, api?: string, apiKey?: string,
 *   headers?: Record<string, string>}} request - 接入信息。
 * @param {AbortSignal} [signal] - 外层取消信号。
 * @returns {Promise<{models: object[], endpoint: string, triedEndpoints: string[],
 *   hasKey: boolean, warnings: string[]}>} 探测结果。
 */
export async function probeEndpoint(request, signal) {
  const baseURL = nonEmptyString(request?.baseURL)
  if (baseURL === undefined) throw new Error('没有填写端点地址（baseURL），无法探测模型清单')

  let parsed
  try {
    parsed = new URL(baseURL)
  } catch {
    throw new Error(`端点地址不是合法网址：${baseURL}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('端点地址只能是 http 或 https')
  }

  const base = baseURL.replace(/\/+$/, '')
  const api = nonEmptyString(request?.api) ?? 'openai-completions'
  const apiMode = api === 'anthropic-messages' ? 'anthropic-messages' : 'openai-completions'
  const apiKey = nonEmptyString(request?.apiKey)
  const hasKey = apiKey !== undefined

  const candidates = listingCandidates(base, apiMode)
  const triedEndpoints = []
  const warnings = []
  if (!hasKey) warnings.push('没有提供密钥：部分端点会拒绝匿名查询模型清单')
  if (apiMode === 'anthropic-messages') warnings.push('Anthropic 协议用 x-api-key 鉴权，并需要 anthropic-version 头')

  /**
   * 记录一条候选地址的失败原因。
   *
   * 多个候选地址都会失败，但"哪个错误最值得告诉用户"不是看先后：
   * 端点明明回了 200 却给了非 JSON，比后面那个地址 404 更接近真相。
   * 所以按信息量排序，最后抛信息量最高的那条。
   *
   * @param {string} message - 中文原因。
   * @param {number} priority - 信息量，越大越值得上报。
   */
  let lastError
  let lastPriority = -1
  const recordError = (message, priority) => {
    warnings.push(message)
    if (priority > lastPriority) {
      lastPriority = priority
      lastError = new Error(message)
    }
  }

  for (const endpoint of candidates) {
    triedEndpoints.push(endpoint)

    /** @type {Record<string, string>} */
    const headers = { accept: 'application/json' }
    if (request?.headers && typeof request.headers === 'object') {
      for (const [headerName, headerValue] of Object.entries(request.headers)) {
        if (typeof headerValue === 'string' && headerName.length > 0) headers[headerName] = headerValue
      }
    }
    if (hasKey) {
      if (apiMode === 'anthropic-messages') {
        headers['anthropic-version'] = headers['anthropic-version'] ?? '2023-06-01'
        headers['x-api-key'] = headers['x-api-key'] ?? apiKey
      } else if (headers.authorization === undefined && headers.Authorization === undefined) {
        headers.authorization = `Bearer ${apiKey}`
      }
    }

    const signals = []
    if (signal !== undefined) signals.push(signal)
    signals.push(AbortSignal.timeout(PROBE_TIMEOUT_MS))

    let response
    try {
      response = await fetch(endpoint, {
        method: 'GET',
        headers,
        signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals),
      })
    } catch (error) {
      const reason = describeFetchError(error, signal)
      recordError(`连不上 ${endpoint}：${reason}`, 1)
      continue
    }

    if (!response.ok) {
      const status = response.status
      if (status === 401 || status === 403) {
        recordError(`${endpoint} 拒绝了这次查询（HTTP ${status}）：密钥无效或未配置`, 4)
      } else if (status === 404) {
        recordError(`${endpoint} 返回 404：这个端点没有 /models 接口`, 2)
      } else {
        recordError(`${endpoint} 返回 HTTP ${status}`, 3)
      }
      continue
    }

    const contentLength = Number(response.headers.get('content-length') ?? 0)
    if (Number.isFinite(contentLength) && contentLength > MAX_LISTING_BYTES) {
      throw new Error(`端点返回的模型清单超过 ${MAX_LISTING_BYTES} 字节上限，已拒绝解析`)
    }

    let text
    try {
      text = await response.text()
    } catch (error) {
      recordError(`读取 ${endpoint} 的响应失败：${describeFetchError(error, signal)}`, 3)
      continue
    }
    if (Buffer.byteLength(text, 'utf8') > MAX_LISTING_BYTES) {
      throw new Error(`端点返回的模型清单超过 ${MAX_LISTING_BYTES} 字节上限，已拒绝解析`)
    }

    let body
    try {
      body = JSON.parse(text)
    } catch {
      recordError(`${endpoint} 返回的不是 JSON（拿到了 ${text.slice(0, 40)}…）`, 5)
      continue
    }

    let rows
    try {
      rows = readListing(body)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      /* readListing 自己的错误里已经写明"不是模型清单"，这里只补上是哪个地址。 */
      recordError(`${endpoint}：${detail}`, 5)
      continue
    }
    if (rows.length === 0) {
      recordError(`${endpoint} 没有列出任何模型`, 0)
      continue
    }

    const models = rows.map((row) => inferModel(row, { baseURL: base, api: apiMode }))
    return { models, endpoint, triedEndpoints, hasKey, warnings }
  }

  if (lastError !== undefined) {
    throw new Error(`${lastError.message}（已尝试：${triedEndpoints.join('、')}）`)
  }
  throw new Error('没有可用的模型清单地址：该端点可能不是 OpenAI / Anthropic 兼容网关')
}

/* 供 B / C 只读引用的小工具（不改变契约要求的导出面）。 */
export { familyOf }
