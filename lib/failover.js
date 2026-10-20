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

/** 哪些 failure code 值得换渠道重试。 */
const RETRYABLE_CODES = new Set([
  'RATE_LIMIT',
  'QUOTA',
  'SERVER',
  'TIMEOUT',
  'TRANSPORT',
  'EMPTY_RESPONSE',
]);

/**
 * 判断一次失败是否值得换渠道。
 *
 * @param {{code?: string, status?: number}} failure
 * @returns {boolean}
 */
export function shouldFailover(failure) {
  if (!failure || typeof failure !== 'object') return false;
  const code = typeof failure.code === 'string' ? failure.code.toUpperCase() : '';
  if (RETRYABLE_CODES.has(code)) return true;
  // 429 有时只带 status 不带 code
  const status = typeof failure.status === 'number' ? failure.status : undefined;
  if (status === 429 || status === 503 || status === 502) return true;
  return false;
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
function modelKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/^[a-z0-9._-]+\//, '') // 去掉 openrouter 风格的 vendor 前缀
    .replace(/[-_.:]v?\d+(\.\d+)*$/, (m) => m) // 保留版本后缀，先不动
    .trim();
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
 * 会话级覆盖表 + 冷却记账。
 *
 * 覆盖表：sessionId → { provider, model }，由 request waterfall 读取。
 * 冷却表：sessionId → Map<route, untilTs>，避免在同一个坏渠道上反复打转。
 */
export function createFailoverState(options = {}) {
  const cooldownMs = Number.isFinite(options.cooldownMs) ? options.cooldownMs : 60_000;
  const overrides = new Map();
  const cooling = new Map();
  // 每个会话最近一次**实际用过**的模型：request-error 的 payload 不带 model，
  // 所以换渠道时得靠 request waterfall 顺手记下来。
  const models = new Map();
  const stats = { attempts: 0, failovers: 0, exhausted: 0 };

  return {
    /** request waterfall 里调：记下这个会话这一步真实在用的模型。 */
    noteModel(sessionId, model) {
      if (typeof model === 'string' && model.length > 0) models.set(sessionId, model);
    },

    /** 取这个会话最近用过的模型。 */
    modelFor(sessionId) {
      return models.get(sessionId);
    },

    /** 记一次失败：该 route 进入冷却，返回当前仍在冷却的 route 集合。 */
    markFailed(sessionId, route, now = Date.now()) {
      stats.attempts += 1;
      let map = cooling.get(sessionId);
      if (!map) {
        map = new Map();
        cooling.set(sessionId, map);
      }
      map.set(route, now + cooldownMs);
      return new Set([...map.entries()].filter(([, until]) => until > now).map(([r]) => r));
    },

    /** 某会话当前冷却中的 route。 */
    coolingFor(sessionId, now = Date.now()) {
      const map = cooling.get(sessionId);
      if (!map) return new Set();
      return new Set([...map.entries()].filter(([, until]) => until > now).map(([r]) => r));
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
      cooling.delete(sessionId);
      models.delete(sessionId);
    },

    /** 一次换渠道彻底失败：没有可用目标了。 */
    noteExhausted() {
      stats.exhausted += 1;
    },

    stats() {
      return { ...stats, activeOverrides: overrides.size, sessionsTracked: cooling.size };
    },
  };
}

export { RETRYABLE_CODES };