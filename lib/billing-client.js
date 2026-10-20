/**
 * 从**浏览器侧**读别的渠道插件的账单数据。
 *
 * 为什么必须在客户端做：
 *   channel 插件（如 our-free-model）的 HTTP API 用 harness 的 connection
 *   信任围栏鉴权（`rejectionFor(req, deps.connection)`），认的是浏览器会话
 *   cookie。Host 侧裸 fetch 一律 401（实测 /summary、/pool、/eac/status 都是）。
 *   而我们这个页面的代码本来就跑在浏览器里、带着同一个 cookie，所以直接
 *   fetch 就能过——不需要任何跨进程取巧。
 *
 * 设计原则：
 *   - **尽力而为**：这些端点属于别的插件，它没装、改路径、改了返回结构都很正常。
 *     任何一步失败就静默降级，绝不影响框架医生自己的功能。
 *   - **只读**：不调用领积分、不触发登录，只查余额/状态。
 *   - 不缓存敏感值，不打印到日志。
 */

/** 已知能提供余额/积分的渠道插件及其端点。新插件加在这里即可。 */
const BILLING_PROVIDERS = [
  {
    id: 'our-free-model',
    label: 'Our Free Model',
    settingsSection: 'our-free-model',
    poolPath: '/api/our-free-model/pool',
    eacPath: '/api/our-free-model/eac/status',
  },
];

/**
 * 读一个渠道插件的账单快照。
 *
 * @param {typeof BILLING_PROVIDERS[number]} provider
 * @param {{timeout?: number, baseURI?: string}} [options]
 * @returns {Promise<{ok: boolean, provider: string, label: string, settingsSection: string,
 *                    accounts: object[], eac?: object|null, error?: string}>}
 */
export async function readBilling(provider, options = {}) {
  const timeout = Number.isFinite(options.timeout) ? options.timeout : 12_000;
  const baseURI = options.baseURI || (typeof document !== 'undefined' ? document.baseURI : undefined);
  const resolve = (path) => {
    try {
      return new URL(path.replace(/^\//, ''), baseURI || undefined).pathname;
    } catch {
      return path;
    }
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(resolve(provider.poolPath), {
      method: 'GET',
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) {
      // 401/403 = 用户还没登录那个插件；404 = 那个插件没装或路径变了。
      // 两种情况都不是错误，只是"这里没有可读的账单"。
      return {
        ok: false,
        provider: provider.id,
        label: provider.label,
        settingsSection: provider.settingsSection,
        accounts: [],
        error: response.status === 401 || response.status === 403
          ? '未登录或会话已过期'
          : response.status === 404
            ? '该插件未安装或未提供账单接口'
            : `HTTP ${response.status}`,
      };
    }
    const payload = await response.json().catch(() => null);
    const accounts = normalizeAccounts(payload);

    // EAC 协付池是另一条腿；失败不影响余额展示。
    let eac = null;
    try {
      const eacResponse = await fetch(resolve(provider.eacPath), {
        method: 'GET',
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
      if (eacResponse.ok) eac = await eacResponse.json().catch(() => null);
    } catch {
      /* 尽力而为 */
    }

    return {
      ok: true,
      provider: provider.id,
      label: provider.label,
      settingsSection: provider.settingsSection,
      accounts,
      eac,
    };
  } catch (error) {
    return {
      ok: false,
      provider: provider.id,
      label: provider.label,
      settingsSection: provider.settingsSection,
      accounts: [],
      error: error?.name === 'AbortError' ? '查询超时' : String(error?.message ?? error),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 把端点的返回摊平成统一的账号行。
 *
 * 端点形态可能变，所以这里对几个常见形状都做兼容：
 *   { accounts: [...] }、{ lanes: [...] }、裸数组。
 * 每个账号尽量提取：名字、剩余积分、剩余余额、状态。
 *
 * @param {unknown} payload
 * @returns {object[]}
 */
export function normalizeAccounts(payload) {
  let rows = [];
  if (Array.isArray(payload)) rows = payload;
  else if (Array.isArray(payload?.accounts)) rows = payload.accounts;
  else if (Array.isArray(payload?.lanes)) rows = payload.lanes;
  else if (Array.isArray(payload?.pool)) rows = payload.pool;
  else return [];

  const out = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const name =
      firstString(row.label, row.name, row.login, row.id, row.provider) || '未命名账号';
    const credits = firstNumber(row.credits, row.credit, row.remainingCredits, row.points);
    const dollars = firstNumber(row.balance, row.dollars, row.remainingUsd, row.usd, row.remaining);
    const status = firstString(row.status, row.state) || '';
    const models = Array.isArray(row.models) ? row.models.length : undefined;
    out.push({
      name,
      credits: credits === undefined ? null : credits,
      dollars: dollars === undefined ? null : dollars,
      status,
      models: models === undefined ? null : models,
    });
  }
  return out;
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function firstNumber(...values) {
  for (const value of values) {
    const num = typeof value === 'string' ? Number(value) : value;
    if (typeof num === 'number' && Number.isFinite(num)) return num;
  }
  return undefined;
}

/**
 * 汇总一份账单快照，给页面/报告用。
 *
 * @param {Awaited<ReturnType<typeof readBilling>>} snapshot
 * @returns {{hasData: boolean, accounts: number, totalCredits: number|null,
 *            totalDollars: number|null, lowCount: number, label: string,
 *            settingsSection: string, error?: string}}
 */
export function summarizeBilling(snapshot) {
  const accounts = Array.isArray(snapshot?.accounts) ? snapshot.accounts : [];
  let totalCredits = 0;
  let creditsSeen = false;
  let totalDollars = 0;
  let dollarsSeen = false;
  let lowCount = 0;

  for (const row of accounts) {
    if (typeof row.credits === 'number') {
      totalCredits += row.credits;
      creditsSeen = true;
      if (row.credits <= 0) lowCount += 1;
    }
    if (typeof row.dollars === 'number') {
      totalDollars += row.dollars;
      dollarsSeen = true;
      if (row.dollars <= 0) lowCount += 1;
    }
  }

  return {
    hasData: accounts.length > 0,
    accounts: accounts.length,
    totalCredits: creditsSeen ? Math.round(totalCredits * 100) / 100 : null,
    totalDollars: dollarsSeen ? Math.round(totalDollars * 100) / 100 : null,
    lowCount,
    label: snapshot?.label || '',
    settingsSection: snapshot?.settingsSection || '',
    ...(snapshot?.error ? { error: snapshot.error } : {}),
  };
}

export { BILLING_PROVIDERS };