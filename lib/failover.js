/**
 * 会话级故障转移：模型调用失败（429 / 配额 / 服务端错误）时，换一个已接入的
 * 渠道继续，而不是让会话卡在那里。
 *
 * 机制（已对着 harness 的 agent-loop 源码确认）：
 *   - `agent/request-error` 是 waterfall。返回 `{ kind: 'retry' }` 会让 agent loop
 *     `continue`，重新走一次 prepareRequest —— 也就是说"重试"是同一个 step、
 *     同一个 turn 的重来，不是新的一轮。
 *   - `prepareRequest` 每次都重新触发 `agent/request` waterfall，那里返回的
 *     provider/model 就是这个 attempt 真正要用的路由。
 *
 * 因此分工是：
 *   1. request-error 里**决定**要不要换（可重试的错误 + 有备用渠道）；
 *   2. 把"这个会话下次该用哪个 route"记在一个会话级覆盖表里；
 *   3. request waterfall 里读这张表，把 provider/model 换掉；
 *   4. 返回 { kind: 'retry' } 让 loop 重跑。
 *
 * 纯函数部分（候选挑选、错误分类、冷却记账）放在这里，便于单测。
 * 事件订阅在 index.js 里做。
 */

/**
 * 哪些 failure code 值得换渠道重试。
 *
 * 这份清单是**对着真实会话日志统计出来的**，不是猜的。统计 47 个会话后
 * 出现过的 code 与次数：
 *
 *   TRANSPORT 77 · TIMEOUT 52 · SERVER 20 · QUOTA_EXCEEDED 18 ·
 *   EAC_UPSTREAM_FAILED 13 · LANE_LOCKED 5 · RATE_LIMIT 2
 *
 * 最初只写了 RATE_LIMIT/QUOTA/SERVER/TIMEOUT/TRANSPORT/EMPTY_RESPONSE，
 * 结果真实世界里 QUOTA_EXCEEDED、EAC_UPSTREAM_FAILED、LANE_LOCKED
 * 这三个最常见的额度类错误全都不认——用户看到"框架医生没介入"就是这么来的。
 */
const RETRYABLE_CODES = new Set([
  // 限流 / 额度：换渠道有意义（别的渠道有自己的额度）
  'RATE_LIMIT',
  'RATE_LIMITED',
  'QUOTA',
  'QUOTA_EXCEEDED',
  'INSUFFICIENT_QUOTA',
  'BALANCE_INSUFFICIENT',
  // 上游/端点故障
  'SERVER',
  'SERVICE_UNAVAILABLE',
  'BAD_GATEWAY',
  'OVERLOADED',
  'EAC_UPSTREAM_FAILED',
  'UPSTREAM_FAILED',
  'PROVIDER_ERROR',
  // 渠道自身状态：车道被锁、账号池空
  'LANE_LOCKED',
  'NO_ACCOUNT',
  'ACCOUNT_UNAVAILABLE',
  // 网络
  'TIMEOUT',
  'TRANSPORT',
  'CONNECTION_ERROR',
  'NETWORK',
  // 空响应：上游 200 但没内容，换渠道常能解决
  'EMPTY_RESPONSE',
  'EMPTY_STREAM',
]);

/**
 * 错误码不认识时的**语义兜底**。
 *
 * 渠道插件各有各的 code 命名，今天叫 QUOTA_EXCEEDED、明天可能叫别的；
 * 但它们的 message 用的是同一批词。所以最后再看一眼人话，命中就换——
 * 宁可多换一次，也不要让用户卡在"医生没反应"上。
 *
 * 这些词都是从真实失败消息里摘出来的，例如：
 *   "rpm exhausted"
 *   "可用账号均在限流中，最近一个将于 … 解禁"
 *   "额度已用尽或没有可用权益"
 *   "detected abusive traffic from this IP address"
 */
const RETRYABLE_MESSAGE_PATTERNS = [
  /rate[_\s-]?limit/i,
  /tpm|rpm/i,
  /\b429\b/,
  /quota/i,
  /exhausted/i,
  /insufficient (balance|quota|credit)/i,
  /限流/,
  /额度.*(用尽|不足|用完)/,
  /没有可用(权益|账号)/,
  /账号.*(限流|解禁)/,
  /abusive traffic/i,
  /服务出错|稍后重试|上游.*(失败|不可用)/,
  /overloaded|capacity/i,
  /timed?\s*out|timeout/i,
  /connection (error|refused|reset)/i,
];

/** 从 failure 里抽出规范化后的 code（有些失败只带 status）。 */
function normalizeCode(failure) {
  const code = typeof failure?.code === 'string' ? failure.code.toUpperCase() : '';
  if (code.length > 0) return code;
  const status = typeof failure?.status === 'number' ? failure.status : undefined;
  if (status === 429) return 'RATE_LIMIT';
  if (status === 402) return 'QUOTA';
  if (status === 503 || status === 502 || status === 500) return 'SERVER';
  return '';
}

/**
 * 判断一次失败是否值得换渠道。
 *
 * @param {{code?: string, status?: number, message?: string}} failure
 * @returns {boolean}
 */
export function shouldFailover(failure) {
  if (!failure || typeof failure !== 'object') return false;

  // 1) 认识的错误码
  const code = normalizeCode(failure);
  if (RETRYABLE_CODES.has(code)) return true;

  // 2) 不认识就按人话判断。这一步是上面那张表漏项的保险——
  //    真实日志里 18 次 QUOTA_EXCEEDED 就是靠 code 认不出来的。
  const message = typeof failure.message === 'string' ? failure.message : '';
  if (message.length > 0 && RETRYABLE_MESSAGE_PATTERNS.some((re) => re.test(message))) return true;

  // 3) 明确的"不该换"：参数错、鉴权错、模型不存在——换渠道也一样失败。
  if (
    code === 'INVALID_REQUEST' ||
    code === 'UNSUPPORTED_OPTION' ||
    code === 'INVALID_CREDENTIAL' ||
    code === 'MISSING_CREDENTIAL' ||
    code === 'AUTHORIZATION_REQUIRED' ||
    code === 'UNKNOWN_MODEL' ||
    code === 'NO_ADAPTER'
  ) {
    return false;
  }

  return false;
}

/**
 * 失败诊断：不光判断"能不能换"，还给出**这个渠道现在有多坏、该晾它多久**。
 *
 * 为什么不在热路径上问大模型：`agent/request-error` 在请求失败的关键路径上，
 * 那里每多一次 awaited 网络调用，重试就多等一截；更糟的是模型本身挂了的时候
 * 再去调模型会死锁。所以热路径只做**基于证据的确定性判断**，把归因和写报告
 * 交给页面上的对话助手（它没有时间压力，且能顺着对话追问）。
 *
 * 分级依据（都来自 failure 本身，不需要额外请求）：
 *   - `providerRetryAfterMs`：端点的 Retry-After，最权威，直接照用；
 *   - `QUOTA`：额度用尽，短时间重试无意义 → 长时间冷却，且值得提醒用户充值；
 *   - `RATE_LIMIT` / 429：限流，通常几分钟 → 中等冷却；
 *   - `SERVER` / 5xx：端点抖动 → 短冷却；
 *   - `TIMEOUT` / `TRANSPORT` / `EMPTY_RESPONSE`：网络或空响应 → 更短冷却。
 */

/** 各类失败的冷却梯度（毫秒）。只是**下限**，会被 Retry-After 抬高。 */
const COOLDOWN_BY_CODE = {
  // 额度类：重试没用，晾久一点
  QUOTA: 30 * 60_000,
  QUOTA_EXCEEDED: 30 * 60_000,
  INSUFFICIENT_QUOTA: 30 * 60_000,
  BALANCE_INSUFFICIENT: 30 * 60_000,
  // 限流：通常几分钟
  RATE_LIMIT: 3 * 60_000,
  RATE_LIMITED: 3 * 60_000,
  // 上游/端点故障
  SERVER: 60_000,
  SERVICE_UNAVAILABLE: 60_000,
  BAD_GATEWAY: 60_000,
  OVERLOADED: 60_000,
  EAC_UPSTREAM_FAILED: 60_000,
  UPSTREAM_FAILED: 60_000,
  PROVIDER_ERROR: 60_000,
  // 渠道自身状态：车道锁/账号池空，等得久一点
  LANE_LOCKED: 5 * 60_000,
  NO_ACCOUNT: 5 * 60_000,
  ACCOUNT_UNAVAILABLE: 5 * 60_000,
  // 网络
  TIMEOUT: 30_000,
  TRANSPORT: 30_000,
  CONNECTION_ERROR: 30_000,
  NETWORK: 30_000,
  // 空响应
  EMPTY_RESPONSE: 15_000,
  EMPTY_STREAM: 15_000,
};

/** 各类失败的严重度：给报告和 UI 用。 */
const SEVERITY_BY_CODE = {
  QUOTA: 'critical',
  QUOTA_EXCEEDED: 'critical',
  INSUFFICIENT_QUOTA: 'critical',
  BALANCE_INSUFFICIENT: 'critical',
  RATE_LIMIT: 'high',
  RATE_LIMITED: 'high',
  SERVER: 'medium',
  SERVICE_UNAVAILABLE: 'medium',
  BAD_GATEWAY: 'medium',
  OVERLOADED: 'medium',
  EAC_UPSTREAM_FAILED: 'medium',
  UPSTREAM_FAILED: 'medium',
  PROVIDER_ERROR: 'medium',
  LANE_LOCKED: 'high',
  NO_ACCOUNT: 'high',
  ACCOUNT_UNAVAILABLE: 'high',
  TIMEOUT: 'low',
  TRANSPORT: 'low',
  CONNECTION_ERROR: 'low',
  NETWORK: 'low',
  EMPTY_RESPONSE: 'low',
  EMPTY_STREAM: 'low',
};

/** 这个失败说明"渠道本身有问题"还是"只是一次抖动"。 */
const SCOPE_BY_CODE = {
  QUOTA: 'account',
  QUOTA_EXCEEDED: 'account',
  INSUFFICIENT_QUOTA: 'account',
  BALANCE_INSUFFICIENT: 'account',
  RATE_LIMIT: 'account',
  RATE_LIMITED: 'account',
  LANE_LOCKED: 'account',
  NO_ACCOUNT: 'account',
  ACCOUNT_UNAVAILABLE: 'account',
  SERVER: 'channel',
  SERVICE_UNAVAILABLE: 'channel',
  BAD_GATEWAY: 'channel',
  OVERLOADED: 'channel',
  EAC_UPSTREAM_FAILED: 'channel',
  UPSTREAM_FAILED: 'channel',
  PROVIDER_ERROR: 'channel',
  EMPTY_RESPONSE: 'channel',
  EMPTY_STREAM: 'channel',
  TIMEOUT: 'transport',
  TRANSPORT: 'transport',
  CONNECTION_ERROR: 'transport',
  NETWORK: 'transport',
};

/** 额度类失败：提醒用户"要不要充值/换套餐"是合理的。 */
const BILLING_CODES = new Set([
  'QUOTA',
  'QUOTA_EXCEEDED',
  'INSUFFICIENT_QUOTA',
  'BALANCE_INSUFFICIENT',
  'RATE_LIMIT',
  'RATE_LIMITED',
  'LANE_LOCKED',
  'NO_ACCOUNT',
]);

/**
 * 把一次失败翻译成"该怎么处理这个渠道"。
 *
 * @param {object} failure  LlmFailure
 * @param {object} [options]
 * @param {number} [options.now]
 * @param {number} [options.maxCooldownMs]  冷却上限，避免 QUOTA 把渠道晾死
 * @returns {{code: string, severity: string, scope: string, cooldownMs: number,
 *            retryAfterMs: number|undefined, billing: boolean, immediate: boolean}}
 */
export function describeFailure(failure, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const maxCooldownMs = Number.isFinite(options.maxCooldownMs) ? options.maxCooldownMs : 60 * 60_000;
  const code = normalizeCode(failure);
  const retryAfterRaw = failure?.providerRetryAfterMs;
  const retryAfterMs =
    typeof retryAfterRaw === 'number' && retryAfterRaw > 0 ? Math.min(retryAfterRaw, maxCooldownMs) : undefined;

  const base = COOLDOWN_BY_CODE[code] ?? 60_000;
  // 端点给了 Retry-After 就以它为准（那是端点的原话），否则用梯度值。
  const cooldownMs = Math.min(maxCooldownMs, Math.max(base, retryAfterMs ?? 0));

  return {
    code: code || 'UNKNOWN',
    severity: SEVERITY_BY_CODE[code] ?? 'medium',
    scope: SCOPE_BY_CODE[code] ?? 'channel',
    cooldownMs,
    retryAfterMs,
    billing: BILLING_CODES.has(code),
    // Retry-After 短到不值得换渠道（例如 1 秒），就地等一下更划算。
    immediate: retryAfterMs !== undefined && retryAfterMs <= 2_000,
    now,
  };
}

/** 从 provider 的 headers 里取一个头（大小写不敏感）。 */
function headerValue(headers, wanted) {
  if (!headers || typeof headers !== 'object') return undefined;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === wanted.toLowerCase());
  return key === undefined ? undefined : headers[key];
}

/**
 * 把一个 provider 配置块压成可比较的"渠道描述"。
 *
 * @param {string} route
 * @param {object} profile
 * @returns {{route: string, baseURL: string, api: string, hasAuth: boolean}}
 */
export function describeChannel(route, profile) {
  const p = profile && typeof profile === 'object' ? profile : {};
  return {
    route,
    baseURL: typeof p.baseURL === 'string' ? p.baseURL.replace(/\/+$/, '') : '',
    api: typeof p.api === 'string' ? p.api : 'openai-completions',
    hasAuth: Boolean(
      (typeof p.apiKeyEnv === 'string' && p.apiKeyEnv.length > 0) ||
        headerValue(p.headers, 'authorization'),
    ),
  };
}

/** 模型在两个渠道里算不算"同一个模型"：id 完全一致，或归一化后一致。 */
/**
 * 把一个模型 id 归一成"它到底是哪个模型"。
 *
 * 真实场景里同一个模型在不同渠道叫法不同，直接字符串相等会漏掉大量备胎：
 *
 *   our-free-model: deepseek-v4.1-flash-free   ← 免费车道给 -free 后缀
 *   workbuddy:      deepseek-v4.1-flash
 *   zcode:          GLM-5.3-Flash              ← 大小写和连字符都不一样
 *   openrouter:     deepseek/deepseek-v4.1-flash  ← vendor 前缀
 *   kilo:           nvidia/nemotron-3.5-super-vl:free
 *
 * 归一规则（顺序有讲究）：
 *   1. 小写；
 *   2. 去掉 vendor 前缀（`deepseek/`、`nvidia/`）；
 *   3. 去掉**渠道后缀**：`-free` / `:free` / `-beta` / `-preview` / `-latest`；
 *   4. 把 `_` `.` `:` 统一成 `-`，压掉连续连字符。
 *
 * 版本号保留：`v4.1` 和 `v4` 是不同的模型，不能归到一起。
 *
 * @param {string} name
 * @returns {string}
 */
function modelKey(name) {
  return String(name || '')
    .toLowerCase()
    .trim()
    // vendor 前缀：deepseek/xxx、nvidia/xxx
    .replace(/^[a-z0-9][a-z0-9._-]*\//, '')
    // 渠道后缀：-free、:free、-beta、-preview、-latest、-experimental
    .replace(/[-_:](free|beta|preview|latest|experimental|nightly)$/g, '')
    // 分隔符统一
    .replace(/[_.:]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * 为一个失败的路由挑一个备用渠道。
 *
 * 规则（从保守到宽松，取第一个命中的）：
 *   1. **同名模型**：别的 provider 里也有完全同 id 的模型；
 *   2. **同家族模型**：别的 provider 里有归一化后同名的模型（去掉 vendor 前缀后相等）。
 * 无论哪种，都要求那个 provider 有 baseURL（至少要能发请求）。
 *
 * @param {object} input
 * @param {string} input.failedProvider  失败的路由
 * @param {string} input.model           正在用的模型 id
 * @param {Record<string, object>} input.providers  当前全部 provider 配置
 * @param {Set<string>|string[]} [input.cooling]  冷却中的 route（刚失败过，别立刻再试）
 * @param {string[]} [input.registered]  已注册到模型服务的 route（可选，用于过滤）
 * @returns {{route: string, model: string, reason: string} | null}
 */
export function pickFailoverTarget({ failedProvider, model, providers, cooling, registered }) {
  if (!providers || typeof providers !== 'object') return null;
  const coolingSet = cooling instanceof Set ? cooling : new Set(cooling || []);
  const registeredSet = Array.isArray(registered) ? new Set(registered) : null;
  const wanted = modelKey(model);

  const candidates = Object.keys(providers)
    .filter((route) => route !== failedProvider)
    .filter((route) => !coolingSet.has(route))
    .filter((route) => {
      const profile = providers[route];
      if (!profile || typeof profile !== 'object') return false;
      // 必须有端点；没有 baseURL 的目录内建路由这里不碰（它们的可用性由 pi-ai 目录决定）
      if (typeof profile.baseURL !== 'string' || profile.baseURL.length === 0) return false;
      if (registeredSet && !registeredSet.has(route)) return false;
      return true;
    })
    .sort();

  // 第 1 轮：完全同名
  for (const route of candidates) {
    const models = Array.isArray(providers[route].models) ? providers[route].models : [];
    const hit = models.find((m) => m && String(m.id) === String(model));
    if (hit) return { route, model: String(hit.id), reason: `same-model:${route}` };
  }

  // 第 2 轮：归一化同名（跨渠道的同规格模型）
  if (wanted.length > 0) {
    for (const route of candidates) {
      const models = Array.isArray(providers[route].models) ? providers[route].models : [];
      const hit = models.find((m) => m && modelKey(m.id) === wanted);
      if (hit) return { route, model: String(hit.id), reason: `same-family:${route}` };
    }
  }

  return null;
}

/**
 * 会话级覆盖表 + 渠道健康画像。
 *
 * 不用"一刀切冷却"：每个渠道记一份**失败档案**（最近几次失败的类型、时间、
 * Severity、Retry-After），冷却时长由 describeFailure 按错误类型算出来。
 * 同一个渠道连续失败会累积（连续 QUOTA 比单次 429 严重得多），成功一次则清零。
 *
 * 这些档案同时也是给对话助手看的原始材料：助手据此判断"失效到什么程度、
 * 要不要用户介入、值不值得充值"，并在页面上写报告。
 */
export function createFailoverState(options = {}) {
  const maxCooldownMs = Number.isFinite(options.maxCooldownMs) ? options.maxCooldownMs : 60 * 60_000;
  const historyLimit = Number.isFinite(options.historyLimit) ? options.historyLimit : 8;
  const overrides = new Map();
  /** sessionId → Map<route, { until, code, severity, scope, billing, failures, lastAt, retryAfterMs }> */
  const health = new Map();
  // 每个会话最近一次**实际用过**的模型：request-error 的 payload 不带 model，
  // 所以换渠道时得靠 request waterfall 顺手记下来。
  const models = new Map();
  const stats = { attempts: 0, failovers: 0, exhausted: 0 };

  function sessionHealth(sessionId) {
    let map = health.get(sessionId);
    if (!map) {
      map = new Map();
      health.set(sessionId, map);
    }
    return map;
  }

  /** 内部用：某会话当前仍在冷却的 route（不依赖 this）。 */
  function coolingSetFor(sessionId, now) {
    const map = health.get(sessionId);
    if (!map) return new Set();
    return new Set([...map.entries()].filter(([, rec]) => rec.until > now).map(([route]) => route));
  }

  return {
    /** request waterfall 里调：记下这个会话这一步真实在用的模型。 */
    noteModel(sessionId, model) {
      if (typeof model === 'string' && model.length > 0) models.set(sessionId, model);
    },

    /** 取这个会话最近用过的模型。 */
    modelFor(sessionId) {
      return models.get(sessionId);
    },

    /**
     * 记一次失败：按错误类型算冷却，累积连续失败次数。
     *
     * @param {string} sessionId
     * @param {string} route
     * @param {object} failure  LlmFailure
     * @param {number} [now]
     * @returns {{cooling: Set<string>, record: object, cooldownMs: number}}
     */
    markFailed(sessionId, route, failure, now = Date.now()) {
      stats.attempts += 1;
      const map = sessionHealth(sessionId);
      const previous = map.get(route);
      const diagnosis = describeFailure(failure, { now, maxCooldownMs });

      // 连续失败：同一个渠道还没恢复就又挂了，说明不是偶发抖动。
      // 每多一次连续失败，冷却翻一倍（封顶 maxCooldownMs），这样反复挂的渠道
      // 会被自然晾到越来越久，而不是每 60 秒回来骚扰一次。
      const streak = (previous?.failures ?? 0) + 1;
      const mult = Math.min(8, 2 ** Math.max(0, streak - 1));
      const cooldownMs = Math.min(maxCooldownMs, diagnosis.cooldownMs * mult);

      const record = {
        until: now + cooldownMs,
        lastAt: now,
        code: diagnosis.code,
        severity: diagnosis.severity,
        scope: diagnosis.scope,
        billing: diagnosis.billing,
        retryAfterMs: diagnosis.retryAfterMs,
        cooldownMs,
        failures: streak,
      };
      map.set(route, record);
      return { cooling: coolingSetFor(sessionId, now), record, cooldownMs };
    },

    /** 某渠道成功了一次：健康档案清零，回到正常候选。 */
    markHealthy(sessionId, route) {
      health.get(sessionId)?.delete(route);
    },

    /** 某会话当前冷却中的 route 集合。 */
    coolingFor(sessionId, now = Date.now()) {
      return coolingSetFor(sessionId, now);
    },

    /** 某会话某个渠道的档案（可能还没失败过）。 */
    recordFor(sessionId, route) {
      return health.get(sessionId)?.get(route);
    },

    /**
     * 导出某会话（或全部会话）的健康快照，给对话助手/页面读。
     *
     * @param {string} [sessionId] 省略则导出全部会话
     * @param {number} [now]
     * @returns {object[]}
     */
    report(sessionId, now = Date.now()) {
      const rows = [];
      const sessions = sessionId === undefined ? [...health.keys()] : [sessionId];
      for (const sid of sessions) {
        const map = health.get(sid);
        if (!map) continue;
        for (const [route, rec] of map) {
          rows.push({
            sessionId: sid,
            route,
            cooling: rec.until > now,
            remainingMs: Math.max(0, rec.until - now),
            code: rec.code,
            severity: rec.severity,
            scope: rec.scope,
            billing: rec.billing,
            retryAfterMs: rec.retryAfterMs,
            consecutiveFailures: rec.failures,
            lastFailureAt: new Date(rec.lastAt).toISOString(),
          });
        }
      }
      return rows.sort((a, b) => b.consecutiveFailures - a.consecutiveFailures || a.route.localeCompare(b.route));
    },

    /** 记下这个会话下一 attempt 该换到哪。 */
    setOverride(sessionId, target) {
      overrides.set(sessionId, { provider: target.route, model: target.model });
      stats.failovers += 1;
    },

    /** 读覆盖；没有就返回 undefined。 */
    getOverride(sessionId) {
      return overrides.get(sessionId);
    },

    /** 清掉覆盖（一次成功之后调用，回归用户原本的选择）。 */
    clearOverride(sessionId) {
      overrides.delete(sessionId);
    },

    /** 清掉某会话的全部状态（agent disposed 时调用）。 */
    forget(sessionId) {
      overrides.delete(sessionId);
      health.delete(sessionId);
      models.delete(sessionId);
    },

    /** 一次换渠道彻底失败：没有可用目标了。 */
    noteExhausted() {
      stats.exhausted += 1;
    },

    stats() {
      return { ...stats, activeOverrides: overrides.size, sessionsTracked: health.size };
    },
  };
}

export { RETRYABLE_CODES, BILLING_CODES, COOLDOWN_BY_CODE, SEVERITY_BY_CODE, normalizeCode };