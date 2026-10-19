/**
 * dsh-framework-doctor — 框架体检规则（纯函数）
 *
 * 这里只回答一个问题：**这份配置/这个运行时，会不会让模型请求根本发不出去，
 * 或者发得出去但很可能出问题？** 不做网络探测（那是 lib/infer.js 的事），
 * 也不猜模型的真实能力 —— 只报「配置与已知失败模式冲突」。
 *
 * 设计约束（CONTRACT.md「B. lib/diagnose.js」）：
 *   - 纯函数、零 I/O、零网络、零第三方依赖、ESM
 *   - 无顶层副作用，可被 `import()` 直接加载
 *   - 不 import ./infer.js（并行施工中）；家族判定在本文件内联一份最小实现
 *   - Finding.id 稳定可复现：`规则名/route[/modelId]`，同输入每次同 id
 *
 * severity 的判定依据：
 *   fatal = 这个 provider / 模型**根本发不出请求**（缺 baseURL、缺凭据、模型清单为空…）
 *   warn  = 请求能发出去，但很可能出问题（凭据未落地、上下文/输出上限缺失、档位配错…）
 *   info  = 只是没显式声明，有默认值兜底（输入模态、输出上限）
 */

/** 三级严重度。冻结，避免调用方误改。 */
export const SEVERITY = Object.freeze({
  FATAL: 'fatal',
  WARN: 'warn',
  INFO: 'info',
});

const { FATAL, WARN, INFO } = SEVERITY;

/**
 * pi-ai 目录内建的 route：这些 route 的 baseURL / api / 模型清单由
 * `@earendil-works/pi-ai` 的目录提供，配置里可以只写 `apiKeyEnv`，
 * 因此不能因为「没写 baseURL / models」就判它们致命。
 *
 * 名单按 pi-ai 0.2 目录整理；漏掉一个的后果只是多报一条 no-base-url，
 * 所以这里宁可按「目录内建」处理得更宽一些。
 */
const CATALOG_ROUTES = new Set([
  'amazon-bedrock',
  'ant-ling',
  'anthropic',
  'azure',
  'baseten',
  'cerebras',
  'cloudflare-ai-gateway',
  'cloudflare-workers-ai',
  'deepseek',
  'fireworks',
  'github-copilot',
  'google',
  'google-vertex',
  'groq',
  'huggingface',
  'kimi-coding',
  'meta',
  'minimax',
  'minimax-cn',
  'mistral',
  'moonshotai',
  'moonshotai-cn',
  'nvidia',
  'openai',
  'openai-codex',
  'opencode',
  'opencode-go',
  'openrouter',
  'qwen-token-plan',
  'qwen-token-plan-cn',
  'qwen-token-plan-individual',
  'radius',
  'together',
  'typesafe',
  'vercel-ai-gateway',
  'xai',
]);

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

/** 小写化取 header，兼容 Authorization / authorization 两种写法。 */
function headerValue(headers, wanted) {
  if (!headers || typeof headers !== 'object') return undefined;
  const target = wanted.toLowerCase();
  const key = Object.keys(headers).find((name) => name.toLowerCase() === target);
  return key === undefined ? undefined : headers[key];
}

/** 回环地址判定：本地 llama.cpp / vLLM / Ollama 等。 */
function isLoopback(baseURL) {
  if (typeof baseURL !== 'string' || baseURL.length === 0) return false;
  return /^(?:https?:\/\/)?(?:127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])(?::\d+)?(?:[/?#]|$)/i.test(
    baseURL,
  );
}

/** 归一成去掉首尾空白的字符串；非字符串一律空串。 */
function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** 是否为正整数。 */
function isPositiveInt(value) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/** 档位对象（`{ off: null, low: 'low' }`）判定；`false` 不算。 */
function isLadder(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 由 route 名推导一个凭据引用名（环境变量风格）。 */
function deriveEnvName(route) {
  const base = String(route)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return `${base || 'ROUTE'}_API_KEY`;
}

/**
 * 内联的最小家族判定（不依赖 lib/infer.js）。
 *
 * 顺序很重要：先判推理，再判非推理。`deepseek-v3.2` 必须先命中推理，
 * 否则会被 `deepseek-v3` 的普通模型正则吃掉。判不出来就返回 'unknown'，
 * 此时**不报**第 11/12 条规则 —— 宁可少报，不要报错。
 */
const REASONING_PATTERNS = [
  /(?:^|[^a-z0-9])(?:r1|reasoner|reasoning)(?:[^a-z0-9]|$)/i,
  /deepseek[^a-z0-9]*(?:v?3\.2|v?3-2|v4|r1|reasoner)/i,
  /qwen[-_]?3/i,
  /(?:^|[^a-z0-9])(?:glm|zai)[^a-z0-9]*(?:4\.[5-9]|z1)/i,
  /(?:^|[^a-z0-9])o[134](?:[-_](?:mini|pro))?(?:[^a-z0-9]|$)/i,
  /gpt[-_]?5/i,
  /kimi[^a-z0-9]*k(?:2|3)/i,
  /thinking/i,
];

const PLAIN_PATTERNS = [
  /deepseek[^a-z0-9]*chat/i,
  /deepseek[^a-z0-9]*v?3(?:\.\d)?(?![.\d])/i,
  /gpt[-_]?4o/i,
  /gpt[-_]?4\.1/i,
  /gpt[-_]?4[-_]?turbo/i,
  /gpt[-_]?3\.5/i,
  /claude[^a-z0-9]*3(?:[^a-z0-9]*5)?[^a-z0-9]*(?:sonnet|haiku|opus)/i,
  /gemini[^a-z0-9]*(?:1\.5|2\.0)/i,
  /(?:^|[^a-z0-9])(?:llama|mistral|mixtral|qwen2(?:\.5)?|phi|gemma)/i,
];

/** @returns {'reasoning'|'plain'|'unknown'} */
function classifyByName(modelId, modelName) {
  const haystack = `${text(modelId)} ${text(modelName)}`.trim();
  if (haystack.length === 0) return 'unknown';
  if (REASONING_PATTERNS.some((pattern) => pattern.test(haystack))) return 'reasoning';
  if (PLAIN_PATTERNS.some((pattern) => pattern.test(haystack))) return 'plain';
  return 'unknown';
}

/**
 * 结合「模型自己的声明」与「名字」给出家族结论。
 * 显式声明永远压过名字推测：`reasoningEfforts: false` 就是非推理。
 */
function classifyModel(model, modelId) {
  if (model && model.reasoningEfforts === false) return 'plain';
  if (model && isLadder(model.reasoningEfforts)) return 'reasoning';
  return classifyByName(modelId, model?.name);
}

/** 取默认选择里的推理档位；空串/undefined/null 都算「没选」。 */
function effortOf(selection) {
  const value = selection?.reasoningEffort;
  if (value === undefined || value === null) return '';
  return typeof value === 'string' ? value.trim() : String(value);
}

/** 从模型的档位对象里挑一个建议档位：优先 medium，否则第一个非 off 档。 */
function suggestEffort(model) {
  if (!isLadder(model?.reasoningEfforts)) return 'medium';
  const levels = Object.keys(model.reasoningEfforts).filter((key) => key !== 'off');
  if (levels.length === 0) return 'medium';
  if (levels.includes('medium')) return 'medium';
  return levels[0];
}

/** 统一构造 Finding，保证字段齐全、id 由调用方给定（稳定）。 */
function finding(id, severity, scope, fields) {
  const out = { id, severity, scope };
  if (fields.route !== undefined) out.route = fields.route;
  if (fields.modelId !== undefined) out.modelId = fields.modelId;
  out.title = fields.title;
  out.detail = fields.detail;
  if (fields.repair !== undefined) out.repair = fields.repair;
  return out;
}

/* ------------------------------------------------------------------ *
 * 配置体检（17 条规则）
 * ------------------------------------------------------------------ */

/**
 * 静态体检：只看配置本身能判断的事实。
 *
 * @param {object} input
 * @param {Record<string, object>} [input.providers]  llm-pi-ai 的有效 providers 字典
 * @param {{provider?: string, model?: string, reasoningEffort?: string}} [input.defaultSelection]
 * @param {Record<string, {configured?: boolean, source?: string}>} [input.credentialState]
 * @param {Array<{id: string, name?: string}>} [input.llmProviders]  ctx.llm.listProviders()
 * @returns {object[]} Finding[]
 */
export function diagnoseConfig(input) {
  const source = input && typeof input === 'object' ? input : {};
  const providers =
    source.providers && typeof source.providers === 'object' ? source.providers : {};
  const credentialState =
    source.credentialState && typeof source.credentialState === 'object'
      ? source.credentialState
      : undefined;
  const defaultSelection =
    source.defaultSelection && typeof source.defaultSelection === 'object'
      ? source.defaultSelection
      : undefined;
  const llmProviders = Array.isArray(source.llmProviders) ? source.llmProviders : undefined;

  /** 已注册的 route id 集合（兼容 `[{id,name}]` 与 `['id']` 两种返回）。 */
  const registered = llmProviders
    ? new Set(
        llmProviders
          .map((row) => (typeof row === 'string' ? row : row && row.id))
          .filter((id) => typeof id === 'string' && id.length > 0),
      )
    : undefined;

  const findings = [];

  // route 名排序后再遍历，保证同样的输入产出同样的顺序与 id 序列。
  const routes = Object.keys(providers).sort();

  for (const route of routes) {
    const profile = providers[route];
    if (!profile || typeof profile !== 'object') continue;

    const display = text(profile.displayName) || route;
    const baseURL = text(profile.baseURL);
    const local = isLoopback(baseURL);
    const models = Array.isArray(profile.models) ? profile.models : [];
    const hasHeaderAuth = Boolean(headerValue(profile.headers, 'authorization'));
    const apiKeyEnv = text(profile.apiKeyEnv);
    const hasKeyRef = apiKeyEnv.length > 0;
    const catalog = CATALOG_ROUTES.has(route);

    /* 1) no-base-url（fatal）：手写 route 没有 baseURL，请求在构造阶段就失败。 */
    if (!catalog && baseURL.length === 0) {
      findings.push(
        finding(`no-base-url/${route}`, FATAL, 'provider', {
          route,
          title: `${display} 缺少端点地址（baseURL）`,
          detail:
            `route "${route}" 不在 pi-ai 内置目录里，属于手写提供方，但没有写 baseURL。` +
            `pi-ai 推不出该往哪发请求，任何一次调用都会在构造请求阶段直接失败。` +
            `修法：填上端点根地址（OpenAI 兼容网关通常以 /v1 结尾，例如 https://api.example.com/v1），保存后重新体检。`,
          repair: { kind: 'set-base-url', payload: { route, displayName: display } },
        }),
      );
    }

    /* 2) no-credential（fatal）：既无 apiKeyEnv 也无 headers.Authorization。 */
    // 回环地址由第 17 条 local-keyless 报，避免同一条问题报两遍。
    if (!hasHeaderAuth && !hasKeyRef && !local) {
      findings.push(
        finding(`no-credential/${route}`, FATAL, 'credential', {
          route,
          title: `${display} 没有配置任何凭据`,
          detail:
            `route "${route}" 既没有 apiKeyEnv 引用，也没有 headers.Authorization。` +
            `pi-ai 会在发请求前抛 "No API key for provider ${route}"，整条 route 用不了。` +
            `修法：填一个 apiKeyEnv 名字（如 ${deriveEnvName(route)}），再到凭据服务里把密钥存进这个名字下。`,
          repair: {
            kind: 'set-credential-ref',
            payload: { route, apiKeyEnv: deriveEnvName(route), displayName: display },
          },
        }),
      );
    }

    /* 3) credential-unresolved（fatal）：声明了 apiKeyEnv，但凭据服务里没有值。 */
    if (hasKeyRef && credentialState) {
      const state = credentialState[apiKeyEnv];
      if (state && typeof state === 'object' && state.configured === false) {
        findings.push(
          finding(`credential-unresolved/${route}`, FATAL, 'credential', {
            route,
            title: `${display} 的凭据引用没有落地`,
            detail:
              `route "${route}" 声明了 apiKeyEnv: ${apiKeyEnv}，但凭据服务里这个引用没有配置值。` +
              `请求会在鉴权阶段失败（401/403 或 "no credential"），和密钥写错是同一个结果。` +
              `修法：到「设置 → 模型」或凭据服务里给 ${apiKeyEnv} 存入真实密钥，或改成已经存在的引用名。`,
            repair: {
              kind: 'open-credential',
              payload: {
                route,
                apiKeyEnv,
                guide: `请在凭据服务里为 ${apiKeyEnv} 存入密钥（或改用一个已存在的 apiKeyEnv 引用），保存后重新体检。`,
              },
            },
          }),
        );
      }
    }

    /* 4) plaintext-secret（warn）：headers 里躺着明文密钥。 */
    const headerNames = Object.keys(profile.headers || {}).sort();
    for (const headerName of headerNames) {
      const value = profile.headers[headerName];
      if (typeof value !== 'string' || value.length === 0) continue;
      const looksLikeKey = /^(?:sk-|Bearer\s+sk-)/i.test(value);
      const longOpaque = !hasHeaderAuth && value.length > 60;
      if (!looksLikeKey && !longOpaque) continue;
      findings.push(
        finding(`plaintext-secret/${route}/${headerName}`, WARN, 'credential', {
          route,
          title: `${display} 的 headers.${headerName} 像是明文密钥`,
          detail:
            `route "${route}" 的 headers.${headerName} 看起来是明文密钥。` +
            `它会被写进配置文件、进入版本控制与备份，泄露风险很高；` +
            `而且换密钥时必须改配置、重启宿主。` +
            `修法：把值移到凭据服务，配置里只留 apiKeyEnv 引用（headers 里不要出现密钥本身）。`,
          repair: {
            kind: 'move-secret-to-ref',
            payload: {
              route,
              header: headerName,
              guide:
                `把 headers.${headerName} 的值存进凭据服务，然后删掉这个 header、改用 apiKeyEnv: ${deriveEnvName(route)} 引用。` +
                `本插件不会替你搬运密钥（那需要读写凭据存储）。`,
            },
          },
        }),
      );
    }

    /* 5) missing-models（fatal）：手写 route 但模型清单为空，无从选择。 */
    if (!catalog && models.length === 0) {
      findings.push(
        finding(`missing-models/${route}`, FATAL, 'provider', {
          route,
          title: `${display} 没有声明任何模型`,
          detail:
            `route "${route}" 是手写提供方，pi-ai 目录里没有它的模型清单，而配置里的 models 是空的。` +
            `结果是模型选择器里看不到任何模型，默认模型也指不到它，等于这条 route 不存在。` +
            `修法：探测一次端点（GET {baseURL}/models）把模型清单写进来。`,
          repair: {
            kind: 'probe-models',
            payload: { route, baseURL, api: text(profile.api) || undefined },
          },
        }),
      );
    }

    /* 6) empty-model-id（fatal）：id 为空或含空格，pi-ai 的 schema 直接拒收。 */
    /* 7) model-file-path（warn）：id 是文件路径或 .gguf。 */
    for (let index = 0; index < models.length; index += 1) {
      const model = models[index];
      if (!model || typeof model !== 'object') continue;
      const rawId = model.id;
      const id = typeof rawId === 'string' ? rawId : '';
      const shown = text(model.name) || id || `#${index}`;
      const idForFinding = id.length > 0 ? id : `#${index}`;

      if (id.length === 0 || /\s/.test(id)) {
        findings.push(
          finding(`empty-model-id/${route}/${index}`, FATAL, 'model', {
            route,
            modelId: idForFinding,
            title: `${display} / ${shown} 的模型 id 不合法`,
            detail:
              `route "${route}" 第 ${index + 1} 个模型的 id 是 ${id.length === 0 ? '空的' : `"${id}"（含空格）`}。` +
              `pi-ai 的模型 schema 要求 id 是非空字符串，且会被原样发给端点：空 id 或带空格的 id 会让整条 route 校验失败，` +
              `连带其他模型一起不可用。` +
              `修法：改成端点真实接受的模型名（通常是小写、连字符，如 deepseek-v4.1-flash）。`,
            repair: {
              kind: 'fix-model-id',
              payload: {
                route,
                index,
                id,
                // 空 id 清不出东西时，用名字兜底再清一次；仍然清不出来就让修复步骤走人工指引。
                suggestedId: sanitizeModelId(id) || sanitizeModelId(model.name),
              },
            },
          }),
        );
      }

      const looksLikePath =
        id.includes('\\') ||
        /^[a-zA-Z]:[\\/]/.test(id) ||
        /^(?:\.{1,2})?[\\/]/.test(id) ||
        /\.(?:gguf|safetensors|bin)$/i.test(id);
      if (looksLikePath) {
        findings.push(
          finding(`model-file-path/${route}/${idForFinding}`, WARN, 'model', {
            route,
            modelId: idForFinding,
            title: `${display} / ${shown} 的模型 id 是文件路径`,
            detail:
              `模型 id "${id}" 看起来是本地权重文件路径（或 .gguf 文件名）。` +
              `端点不会用这个字符串当模型名，请求会返回 "model not found"；` +
              `即使能跑，模型选择器里也会显示一整条路径。` +
              `修法：给服务端加 --alias <小写连字符名>，再把这里的 id 改成同一个别名。`,
            repair: {
              kind: 'set-model-alias',
              payload: {
                route,
                index,
                id,
                suggestedId: suggestAlias(id),
                guide:
                  `先给本地服务加 --alias ${suggestAlias(id)}（或等价的模型别名配置），` +
                  `再把该模型的 id 改成 ${suggestAlias(id)}；两边必须完全一致。`,
              },
            },
          }),
        );
      }

      /* 8) missing-input（info）：没声明输入模态，也没有 route 级默认值。 */
      if (!Array.isArray(model.input) && profile.defaultInput === undefined) {
        findings.push(
          finding(`missing-input/${route}/${idForFinding}`, INFO, 'model', {
            route,
            modelId: idForFinding,
            title: `${display} / ${shown} 没有声明输入模态`,
            detail:
              `模型没有写 input，route 也没有 defaultInput，pi-ai 会回退到默认的纯文本处理。` +
              `模型其实支持看图的话，图片会在本地就被拒绝，而不是报端点错误 —— 排查起来很费劲。` +
              `修法：确认能力后显式写 input: [text, image]，或按探测结果自动补全。`,
            repair: { kind: 'infer-input', payload: { route, modelId: idForFinding } },
          }),
        );
      }

      /* 9) missing-context（warn）：模型与 route 都没给上下文窗口。 */
      if (!isPositiveInt(model.contextWindow) && !isPositiveInt(profile.defaultContextWindow)) {
        findings.push(
          finding(`missing-context/${route}/${idForFinding}`, WARN, 'model', {
            route,
            modelId: idForFinding,
            title: `${display} / ${shown} 没有上下文窗口`,
            detail:
              `模型和 route 都没有写 contextWindow，pi-ai 会套用内置默认值（262144）。` +
              `默认值比真实上限大时，长对话会被端点直接 400 拒绝（context length exceeded）；` +
              `比真实上限小时，可用上下文又被白白浪费。` +
              `修法：按端点文档或 /models 返回的上下文长度补上 contextWindow。`,
            repair: { kind: 'infer-context', payload: { route, modelId: idForFinding } },
          }),
        );
      }

      /* 10) missing-max-tokens（info）：模型与 route 都没给输出上限。 */
      if (!isPositiveInt(model.maxTokens) && !isPositiveInt(profile.defaultMaxTokens)) {
        findings.push(
          finding(`missing-max-tokens/${route}/${idForFinding}`, INFO, 'model', {
            route,
            modelId: idForFinding,
            title: `${display} / ${shown} 没有声明输出上限`,
            detail:
              `模型和 route 都没有写 maxTokens，会回退到内置默认值。` +
              `推理模型「先想再答」，输出上限太小会在思考中途被截断成空回复，看起来像模型挂了。` +
              `修法：按端点文档补上 maxTokens（推理模型建议 ≥ 8192）。`,
            repair: { kind: 'infer-max-tokens', payload: { route, modelId: idForFinding } },
          }),
        );
      }

      /* 11) reasoning-missing-efforts（warn）：推理模型没写档位梯子。 */
      const family = classifyModel(model, id);
      // 规则 12 要判的是「按名字看是不是普通模型」，不能用 classifyModel ——
      // 它一看到 reasoningEfforts 是档位对象就返回 'reasoning'，会让规则 12 永远不命中。
      const nameFamily = classifyByName(id, model?.name);
      if (model.reasoningEfforts === undefined && family === 'reasoning') {
        findings.push(
          finding(`reasoning-missing-efforts/${route}/${idForFinding}`, WARN, 'model', {
            route,
            modelId: idForFinding,
            title: `${display} / ${shown} 是推理模型但没有思考档位`,
            detail:
              `按模型名判断这是推理模型，但没写 reasoningEfforts。` +
              `pi-ai 因此不知道该怎么把 off/low/medium/high 翻译成线上拼写，` +
              `要么不发思考参数（模型默认一直深思，慢且贵），要么在严格端点上直接报参数错误。` +
              `修法：补上该家族的档位对象，例如 { off: null, low: "low", medium: "medium", high: "high" }。`,
            repair: { kind: 'infer-reasoning', payload: { route, modelId: idForFinding } },
          }),
        );
      }

      /* 12) reasoning-on-plain-model（warn）：非推理模型被塞了档位。 */
      if (isLadder(model.reasoningEfforts) && nameFamily === 'plain') {
        findings.push(
          finding(`reasoning-on-plain-model/${route}/${idForFinding}`, WARN, 'model', {
            route,
            modelId: idForFinding,
            title: `${display} / ${shown} 不是推理模型却声明了思考档位`,
            detail:
              `这个模型按名字判断是普通对话模型，但配置里给了 reasoningEfforts 档位表。` +
              `请求里带上思考参数会被端点当成未知字段：轻则忽略（设置页里显示的档位全是假的），` +
              `重则直接 400 拒绝整次调用。` +
              `修法：把该模型的 reasoningEfforts 显式设为 false，表示「确定不支持思考档位」。`,
            repair: { kind: 'drop-reasoning', payload: { route, modelId: idForFinding } },
          }),
        );
      }
    }

    /* 13) duplicate-model（warn）：同 route 内 id 重复，pi-ai 会整条 route 校验失败。 */
    const seenIds = new Map();
    for (let index = 0; index < models.length; index += 1) {
      const model = models[index];
      const id = typeof model?.id === 'string' ? model.id : '';
      if (id.length === 0) continue;
      if (!seenIds.has(id)) {
        seenIds.set(id, index);
        continue;
      }
      findings.push(
        finding(`duplicate-model/${route}/${id}/${index}`, WARN, 'model', {
          route,
          modelId: id,
          title: `${display} 里模型 "${id}" 出现了多次`,
          detail:
            `route "${route}" 的 models 里 "${id}" 重复（第 ${seenIds.get(id) + 1} 条与第 ${index + 1} 条）。` +
            `pi-ai 解析时会报 "lists model ... more than once" 并拒绝整条 route，` +
            `所以这不是显示问题，是整条 route 都发不出请求。` +
            `修法：保留第一条，删掉后面的重复项（自动修复只会删重复的 id，不会动其它模型）。`,
          repair: {
            kind: 'drop-duplicate',
            payload: { route, modelId: id, index, keepIndex: seenIds.get(id) },
          },
        }),
      );
    }

    /* 14) route-unregistered（fatal）：配置里有，但 llm 服务没注册。 */
    if (registered && registered.size > 0 && !registered.has(route)) {
      findings.push(
        finding(`route-unregistered/${route}`, FATAL, 'provider', {
          route,
          title: `${display} 没有注册到模型服务`,
          detail:
            `配置里存在 route "${route}"，但 ctx.llm.listProviders() 里没有它。` +
            `模型选择器里看不到它，默认模型指向它会直接失败；常见原因是 provider 配置校验没过（字段不合法），` +
            `整条 route 被 pi-ai 静默丢弃，或者插件还没重载。` +
            `修法：先修掉这条 route 的其它致命问题（缺 baseURL / 缺凭据 / 模型 id 非法），再重载插件。`,
          repair: {
            kind: 'fix-route',
            payload: {
              route,
              guide:
                `先修正 route "${route}" 的其余致命问题（baseURL / 凭据 / 模型 id / 重复模型），然后在插件页重载 llm-pi-ai，再重新体检。`,
            },
          },
        }),
      );
    }
  }

  /* 15a) external-provider（info）：已注册到模型服务、但不由 llm-pi-ai 配置管理。
     这类 route 由其它插件动态提供（如 our-free-model），不是配置缺失，不该误报。 */
  if (registered && registered.size > 0) {
    for (const id of [...registered].sort()) {
      if (id in providers) continue;
      findings.push(
        finding(`external-provider/${id}`, INFO, 'provider', {
          route: id,
          title: `${id} 由其它插件提供`,
          detail:
            `provider "${id}" 已经注册到模型服务（ctx.llm.listProviders()），但不在 llm-pi-ai 的配置里。` +
            `它由别的插件动态提供（例如 our-free-model 的免费通道），模型清单也不归本页面管理。` +
            `这不是错误：默认模型指向它时可以正常使用；体检不会尝试修改它。`,
          repair: undefined,
        }),
      );
    }
  }

  /* 15) default-model-missing（fatal）：默认模型指向不存在的 provider/model。 */
  const selection = defaultSelection;
  if (selection && text(selection.provider).length > 0) {
    const provider = text(selection.provider);
    const model = text(selection.model);
    const profile = providers[provider];
    const models = profile && Array.isArray(profile.models) ? profile.models : [];
    // provider 是否"真实存在"要看模型服务，而不是只看 llm-pi-ai 配置：
    // 别的插件（如 our-free-model）可能动态注册 provider 到 ctx.llm，
    // 配置里没有它不代表它不存在。
    const providerRegistered = registered
      ? registered.has(provider)
      : false;
    const providerKnown = Boolean(profile && typeof profile === 'object') || providerRegistered;
    const modelKnown =
      model.length === 0
        ? false
        : models.some((entry) => entry && String(entry.id) === model) ||
          // 目录内建 route 的 models 可以为空（由 pi-ai 目录提供），此时无法校验具体模型。
          (models.length === 0 && CATALOG_ROUTES.has(provider)) ||
          // 已注册但不在 llm-pi-ai 配置里的 provider：模型由外部插件提供，
          // 无法从这份配置校验具体模型，视为存在（交给运行时规则 18 做真校验）。
          (providerRegistered && models.length === 0);

    if (!providerKnown || !modelKnown) {
      const reason = !providerKnown
        ? `模型服务里也没有 route "${provider}"（既不在 llm-pi-ai 配置，也没注册到 ctx.llm）`
        : `route "${provider}" 的模型清单里没有 "${model}"`;
      findings.push(
        finding(`default-model-missing/${provider}/${model || '#'}`, FATAL, 'default-model', {
          route: provider,
          modelId: model || undefined,
          title: `默认模型指向了不存在的 ${provider} / ${model || '(未填)'}`,
          detail:
            `agent-default-model 配的是 provider "${provider}"、model "${model || '(未填)'}"，` +
            `但${reason}。` +
            `每一轮对话都会在选择模型时失败，整个智能体不可用（这是最容易让用户觉得「框架坏了」的一条）。` +
            `修法：把默认模型改成真实存在、且已经注册到模型服务的 provider/model。`,
          repair: {
            kind: 'set-default-model',
            payload: { provider, model, candidates: listCandidates(providers, registered) },
          },
        }),
      );
    }
  }

  /* 16) default-model-unreasoned（warn）：默认推理模型没选思考档位。 */
  if (selection && text(selection.provider).length > 0 && text(selection.model).length > 0) {
    const provider = text(selection.provider);
    const model = text(selection.model);
    const profile = providers[provider];
    const models = profile && Array.isArray(profile.models) ? profile.models : [];
    const entry = models.find((row) => row && String(row.id) === model);
    const family = entry ? classifyModel(entry, model) : classifyByName(model, model);
    const routeHasReasoningLevel = text(profile?.reasoning).length > 0;
    if (family === 'reasoning' && !routeHasReasoningLevel && effortOf(selection).length === 0) {
      const suggested = suggestEffort(entry);
      findings.push(
        finding(`default-model-unreasoned/${provider}/${model}`, WARN, 'default-model', {
          route: provider,
          modelId: model,
          title: `默认推理模型没有指定思考档位`,
          detail:
            `默认模型 ${provider} / ${model} 是推理模型，但 agent-default-model 里没有 reasoningEffort。` +
            `结果每次启动都走端点默认档：可能是 off（推理模型退化成普通模型），也可能是 high（又慢又贵），` +
            `而且不可控、无法复现。` +
            `修法：显式选一个档位（建议 medium），需要更深的推理时再临时调高。`,
          repair: {
            kind: 'set-reasoning-effort',
            payload: {
              provider,
              model,
              reasoningEffort: suggested,
              selection: { provider, model, reasoningEffort: suggested },
            },
          },
        }),
      );
    }
  }

  /* 17) local-keyless（fatal）：回环地址但没有任何凭据。 */
  for (const route of routes) {
    const profile = providers[route];
    if (!profile || typeof profile !== 'object') continue;
    const baseURL = text(profile.baseURL);
    if (!isLoopback(baseURL)) continue;
    const hasHeaderAuth = Boolean(headerValue(profile.headers, 'authorization'));
    const hasKeyRef = text(profile.apiKeyEnv).length > 0;
    if (hasHeaderAuth || hasKeyRef) continue;
    const display = text(profile.displayName) || route;
    findings.push(
      finding(`local-keyless/${route}`, FATAL, 'credential', {
        route,
        title: `${display}（本地端点）没有占位凭据`,
        detail:
          `route "${route}" 指向回环地址 ${baseURL}，但既没有 apiKeyEnv 也没有 Authorization 头。` +
          `很多人以为本地服务不需要鉴权 —— pi-ai 不这么认为：它会在构造请求时直接抛 ` +
          `"No API key for provider ${route}"，请求根本发不出去。本地服务通常不校验这个值，随便填即可。` +
          `修法：加一个 Authorization 头（值可以是任意占位串，如 Bearer local），或补一个 apiKeyEnv 引用。`,
        repair: {
          kind: 'set-placeholder-key',
          payload: {
            route,
            header: 'Authorization',
            value: 'Bearer local',
            apiKeyEnv: deriveEnvName(route),
          },
        },
      }),
    );
  }

  return dedupeById(findings);
}

/**
 * 按 id 去重，保留第一次出现（顺序不变）。
 *
 * 为什么需要：per-model 规则的 id 只带 modelId（`missing-input/route/dup-id`），
 * 而同一 route 里可能有两个同 id 的模型（那本身由 duplicate-model 规则报）。
 * 去重后「一条规则对一个 route 的某个模型只出一条」，id 才能稳定可复现。
 */
function dedupeById(findings) {
  const seen = new Set();
  const out = [];
  for (const finding of findings) {
    if (seen.has(finding.id)) continue;
    seen.add(finding.id);
    out.push(finding);
  }
  return out;
}

/** 把不合法的模型 id 清理成合法形态；清不出东西时返回空串。 */
function sanitizeModelId(id) {
  const cleaned = String(id ?? '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^A-Za-z0-9._:/-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned;
}

/** 由文件路径推导一个像样的模型别名。 */
function suggestAlias(id) {
  const raw = String(id ?? '');
  const base = raw.split(/[\\/]/).pop() || raw;
  const cleaned = sanitizeModelId(base.replace(/\.(?:gguf|safetensors|bin)$/i, ''));
  return cleaned.length > 0 ? cleaned.toLowerCase() : 'local-model';
}

/** 给 set-default-model 的人话建议：列出可用的 provider/model 组合。 */
function listCandidates(providers, registered) {
  const out = [];
  const pushRoute = (route, models) => {
    const list = Array.isArray(models) ? models : [];
    for (const model of list) {
      const id = typeof model?.id === 'string' ? model.id : '';
      if (id.length > 0) out.push({ provider: route, model: id });
    }
    if (list.length === 0) out.push({ provider: route, model: '' });
  };
  for (const route of Object.keys(providers).sort()) {
    const profile = providers[route];
    if (!profile || typeof profile !== 'object') continue;
    pushRoute(route, profile.models);
  }
  // 已注册到模型服务但不在 llm-pi-ai 配置里的 provider（外部插件提供）也列进候选，
  // 免得"默认模型已指向它"时修复建议反而把唯一可用的选择排除掉。
  if (registered && registered.size > 0) {
    for (const id of [...registered].sort()) {
      if (id in providers) continue;
      pushRoute(id, []);
    }
  }
  return out.slice(0, 24);
}

/* ------------------------------------------------------------------ *
 * 运行时体检（5 条规则）
 * ------------------------------------------------------------------ */

/**
 * 运行时体检：只看已经发生的状态（插件 fiber 相位、已注册的 provider、默认模型）。
 *
 * @param {object} input
 * @param {Array<object>} [input.plugins]   pluginManager.listPlugins() 的结果
 * @param {Array<{id: string, name?: string}>} [input.llmProviders]
 * @param {{provider?: string, model?: string}} [input.defaultSelection]
 * @param {Record<string, object>} [input.providers]
 * @returns {object[]} Finding[]
 */
export function diagnoseRuntime(input) {
  const source = input && typeof input === 'object' ? input : {};
  const plugins = Array.isArray(source.plugins) ? source.plugins : [];
  const llmProviders = Array.isArray(source.llmProviders) ? source.llmProviders : undefined;
  const defaultSelection =
    source.defaultSelection && typeof source.defaultSelection === 'object'
      ? source.defaultSelection
      : undefined;
  const providers =
    source.providers && typeof source.providers === 'object' ? source.providers : {};

  const findings = [];

  /** 插件行的稳定标识：优先 id，其次 name，最后退化成序号。 */
  const pluginIdOf = (row, index) => {
    const id = text(row?.id) || text(row?.name);
    return id.length > 0 ? id : `#${index}`;
  };
  const pluginNameOf = (row, index) => {
    const name = text(row?.name) || text(row?.id);
    return name.length > 0 ? name : `插件 #${index + 1}`;
  };

  /* plugin-row-failed（fatal）：插件加载失败，它的服务/工具全部缺席。 */
  for (let index = 0; index < plugins.length; index += 1) {
    const row = plugins[index];
    if (!row || typeof row !== 'object') continue;
    const pluginId = pluginIdOf(row, index);
    const display = pluginNameOf(row, index);
    const phase = text(row.fiberPhase);

    if (phase === 'failed') {
      const reason = text(row.error) || text(row.message) || '';
      findings.push(
        finding(`plugin-row-failed/${pluginId}`, FATAL, 'framework', {
          title: `插件 ${display} 加载失败`,
          detail:
            `插件 ${display}（${pluginId}）的 fiber 相位是 failed：它注册的服务、工具、设置页都不存在。` +
            `依赖它的功能会连带失效，而且通常是静默的 —— 看起来像「功能没做」，其实是没有加载。` +
            (reason ? `失败原因：${reason}。` : '') +
            `修法：看宿主日志里这条插件的报错，修掉后重载插件；依赖缺失或版本不匹配是最常见的原因。`,
          repair: {
            kind: 'reload-plugin',
            payload: {
              pluginId,
              pluginName: display,
              guide: `修复插件 ${display} 的加载错误后，在插件页重载它（本插件不能替你重载宿主插件）。`,
            },
          },
        }),
      );
      continue;
    }

    /* plugin-row-pending（warn）：enabled 但一直停在 pending。 */
    if (phase === 'pending' && row.enabled !== false) {
      findings.push(
        finding(`plugin-row-pending/${pluginId}`, WARN, 'framework', {
          title: `插件 ${display} 一直停在加载中`,
          detail:
            `插件 ${display}（${pluginId}）是启用状态，但 fiber 相位一直是 pending：` +
            `它的 apply() 还没跑完（可能在等某个服务，或卡在一次没有超时的初始化里）。` +
            `在这之前它的功能都不可用，用户看到的是「插件装了但没反应」。` +
            `修法：先看日志确认卡在哪一步；确认是偶发的话重载一次，反复 pending 就是代码里有等待没收敛。`,
          repair: {
            kind: 'reload-plugin',
            payload: {
              pluginId,
              pluginName: display,
              guide: `检查插件 ${display} 的启动日志，确认它等待的服务已经就绪，然后重载该插件。`,
            },
          },
        }),
      );
    }
  }

  /* no-llm-provider（fatal）：一个 provider 都没注册，任何模型都发不出去。 */
  if (llmProviders && llmProviders.length === 0) {
    findings.push(
      finding('no-llm-provider', FATAL, 'framework', {
        title: '没有任何可用的模型提供方',
        detail:
          `ctx.llm.listProviders() 返回空列表：llm-pi-ai 没注册出任何 route。` +
          `此时模型选择器是空的，默认模型无处可指，所有会话都无法发起请求。` +
          `常见原因：llm-pi-ai 插件没启用/加载失败，或 providers 配置整体校验失败被丢弃。` +
          `修法：先确认 llm-pi-ai 已加载，再在接入向导里添加一个 provider 并探测模型清单。`,
        repair: {
          kind: 'probe-models',
          payload: {
            route: null,
            guide: '先确认 llm-pi-ai 插件已启用并加载成功，然后在「接入向导」里添加 provider、探测模型清单并写入配置。',
          },
        },
      }),
    );
  }

  /* default-model-not-live（fatal）：默认模型的 provider 没有注册。 */
  const provider = text(defaultSelection?.provider);
  const model = text(defaultSelection?.model);
  if (provider.length > 0 && llmProviders) {
    const live = new Set(
      llmProviders
        .map((row) => (typeof row === 'string' ? row : row && row.id))
        .filter((id) => typeof id === 'string' && id.length > 0),
    );
    if (live.size > 0 && !live.has(provider)) {
      findings.push(
        finding(`default-model-not-live/${provider}/${model || '#'}`, FATAL, 'default-model', {
          route: provider,
          modelId: model || undefined,
          title: `默认模型的提供方 ${provider} 没有上线`,
          detail:
            `agent-default-model 指向 provider "${provider}"，但这个 provider 不在 ctx.llm.listProviders() 里。` +
            `配置里可能写得没错，可运行时根本没有这条 route，每一轮对话都会在选择模型时失败。` +
            `修法：要么修好这个 provider（凭据/端点/模型清单），要么把默认模型切到已注册的 provider 上。`,
          repair: {
            kind: 'set-default-model',
            payload: {
              provider,
              model,
              candidates: liveCandidates(live, providers),
            },
          },
        }),
      );
    }
  }

  /* no-default-model（warn）：没有默认模型，用户每次都得手选。 */
  if (!defaultSelection || provider.length === 0 || model.length === 0) {
    findings.push(
      finding('no-default-model', WARN, 'default-model', {
        title: '没有配置默认模型',
        detail:
          `agent-default-model 没有给出完整的 provider/model。` +
          `新会话不会自动带上模型，用户必须每轮手动选一次；某些自动化场景（标题生成、后台任务）会直接失败。` +
          `修法：在设置里选一个已注册且凭据就绪的模型作为默认模型。`,
      }),
    );
  }

  return findings;
}

/** 给 set-default-model 的建议列表（只保留已注册的 provider）。 */
function liveCandidates(live, providers) {
  const out = [];
  for (const route of [...live].sort()) {
    const models = Array.isArray(providers[route]?.models) ? providers[route].models : [];
    for (const model of models) {
      const id = typeof model?.id === 'string' ? model.id : '';
      if (id.length > 0) out.push({ provider: route, model: id });
    }
  }
  return out.slice(0, 20);
}
