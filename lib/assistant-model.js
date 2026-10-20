/**
 * 框架医生自己的模型路由。
 *
 * 为什么要独立于默认模型：框架医生要读整份体检结果、要判断、还要写报告，
 * 它和用户正经对话的需求完全不同 —— 用户可能想让对话用最贵的模型、诊断用
 * 便宜快的；也可能反过来，希望诊断用可靠的、对话随便。把两者绑在一起是错的。
 *
 * 为什么要有降级链：模型会 429、会额度用尽、端点会挂。诊断在用户点下按钮的
 * 那一刻必须能跑完——跑不完就变成"医生自己也病了"，比不做检查更糟。
 *
 * 所以这个模块提供：
 *   - 一条**有序的候选链**（用户配置的模型 → 可选的自动回退到默认模型）；
 *   - 每次调用失败后按顺序换下一个，全部失败才把错误抛给页面；
 *   - 每一跳的失败都记进渠道健康档案（复用 failover 的记账，报告口径统一）。
 *
 * 纯逻辑放这里便于单测；真正的 llm.stream 调用在 index.js。
 */

/**
 * 归一化配置出来的候选链。
 *
 * 配置形态（`cordis.patch.yml`）：
 *
 * ```yaml
 * - id: framework-doctor
 *   config:
 *     model:
 *       # 顺序即优先级；第一个跑得通的就是这次用的
 *       chain:
 *         - provider: main-chan
 *           model: deepseek-v4.1-flash
 *         - provider: backup-chan
 *           model: deepseek-v4.1-flash
 *       # 链都失败时，要不要退回到用户当前选的默认模型
 *       fallbackToDefaultModel: true
 * ```
 *
 * 不配置时返回空链 + fallback 打开，等价于"就用默认模型"，保持向后兼容。
 *
 * @param {unknown} raw
 * @param {{defaultSelection?: {provider?: string, model?: string} | null}} [options]
 * @returns {{entries: Array<{provider: string, model: string, source: string}>,
 *            fallbackToDefaultModel: boolean,
 *            explicit: boolean}}
 */
export function resolveModelChain(raw, options = {}) {
  const cfg = raw && typeof raw === 'object' ? raw : {};
  const entries = [];

  const rawChain = Array.isArray(cfg.chain) ? cfg.chain : [];
  for (const row of rawChain) {
    if (!row || typeof row !== 'object') continue;
    const provider = typeof row.provider === 'string' ? row.provider.trim() : '';
    const model = typeof row.model === 'string' ? row.model.trim() : '';
    if (!provider || !model) continue;
    // 同一条重复配置没意义，去重但保留首次出现的位置。
    if (entries.some((e) => e.provider === provider && e.model === model)) continue;
    entries.push({ provider, model, source: 'chain' });
  }

  const fallback = cfg.fallbackToDefaultModel !== false;
  const selection = options.defaultSelection;
  if (
    fallback &&
    selection &&
    typeof selection.provider === 'string' &&
    selection.provider.length > 0 &&
    typeof selection.model === 'string' &&
    selection.model.length > 0 &&
    !entries.some((e) => e.provider === selection.provider && e.model === selection.model)
  ) {
    entries.push({ provider: selection.provider, model: selection.model, source: 'default' });
  }

  const explicit = Array.isArray(rawChain) && rawChain.length > 0;
  return { entries, fallbackToDefaultModel: fallback, explicit };
}

/**
 * 从某个候选开始，按顺序取出"这次调用该试哪些"。
 *
 * @param {Array<{provider: string, model: string, source: string}>} chain
 * @param {number} [from]  从第几个开始试（每次失败后 +1）
 * @returns {Array<{provider: string, model: string, source: string, index: number}>}
 */
export function candidatesFrom(chain, from = 0) {
  if (!Array.isArray(chain)) return [];
  const start = Number.isFinite(from) && from > 0 ? Math.min(from, chain.length) : 0;
  return chain.slice(start).map((entry, offset) => ({ ...entry, index: start + offset }));
}

/**
 * 判断一次失败是否值得在**框架医生自己的调用链**上继续换下一个。
 *
 * 和会话故障转移的判据一致（换渠道能解决的才换），但这里更宽松一点：
 * 框架医生的调用是"用户点了一下就等结果"，能多试一个就多试一个。
 *
 * @param {{code?: string, status?: number}} failure
 * @returns {boolean}
 */
export function shouldAdvanceChain(failure) {
  if (!failure || typeof failure !== 'object') return false;
  const code = typeof failure.code === 'string' ? failure.code.toUpperCase() : '';
  if (code.length > 0) {
    // 密钥/凭据/模型不存在：换渠道有可能能解决（别的渠道有自己的凭据和模型清单），
    // 所以在**诊断链**上值得再试一个；这与会话故障转移的保守策略不同，
    // 那边换的是用户正经对话，不能乱试。
    return !['UNSUPPORTED_OPTION'].includes(code);
  }
  const status = typeof failure.status === 'number' ? failure.status : undefined;
  if (status === undefined) return true;
  // 400 是请求本身有问题，换渠道也没用；其他状态码都值得再试一个。
  return status !== 400;
}

/**
 * 给报告用：这条链现在还能不能用、第一跳是谁。
 *
 * @param {ReturnType<typeof resolveModelChain>} chain
 * @param {Set<string>|string[]} [cooling]  冷却中的 route
 * @returns {{usable: boolean, first?: object, skipped: string[], explicit: boolean}}
 */
export function describeChain(chain, cooling) {
  const coolingSet = cooling instanceof Set ? cooling : new Set(cooling || []);
  const skipped = [];
  for (const entry of chain.entries ?? []) {
    if (coolingSet.has(entry.provider)) {
      skipped.push(entry.provider);
      continue;
    }
    return { usable: true, first: entry, skipped, explicit: Boolean(chain.explicit) };
  }
  return { usable: false, skipped, explicit: Boolean(chain.explicit) };
}