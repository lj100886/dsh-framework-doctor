/**
 * dsh-framework-doctor — 框架医生（Host 端）
 *
 * 两件事：
 *   1. 接入：给一个调用网址，探测端点公布的模型清单，结合家族知识推导出
 *      输入模态、上下文、输出上限、思考档位、思考格式，写进 `llm-pi-ai` 配置。
 *   2. 体检与修复：把配置与运行时状态扫一遍，产出可读的问题清单，
 *      并把能自动修的项落成 settings 变更。
 *
 * 边界（刻意收窄）：
 *   - 只注册一个 HTTP 前缀 `/api/framework-doctor`，且过一遍 connection 的
 *     信任围栏；不监听任何端口，不自己起服务。
 *   - 密钥只在 Host 进程内使用，绝不进入任何响应体。写配置只写
 *     `apiKeyEnv` 引用（凭据服务），不把明文写进 patch 文件。
 *   - 不改用户没让改的东西：修复只动被诊断出来的那几条路径。
 *   - 探测模块、体检模块全部惰性加载：任一模块坏了，插件本体照常起来，
 *     页面拿到一条中文错误，而不是整个设置页白屏。
 *
 * 所有服务都按"可能不存在"处理：缺 settings 时插件整体退化为空操作，
 * 缺 webServer 时只是页面没数据源，缺 llm/credentials/pluginManager
 * 时对应那部分体检降级为"未检查"，而不是抛错。
 */

import { rejectionFor, connectionAdmissionView } from './lib/trust.js';

const name = 'framework-doctor';

/** 硬依赖只有 settings：它是配置的唯一读写口，没有它整个插件没有意义。 */
const inject = ['settings'];

/** 目标命名空间：第三方网关与手写路由都在这里。 */
const TARGET_NS = 'llm-pi-ai';

/** 默认模型那一行的入口 id（patch 里就是这么写的）。 */
const DEFAULT_MODEL_NS = 'agent-default-model';

/** HTTP 前缀。故意长于内核的 `/api`，走 longest-prefix 派发。 */
const ROUTE_PREFIX = '/api/framework-doctor';

const MAX_BODY_BYTES = 1024 * 1024;

/* ------------------------------------------------------------------ *
 * 配置
 * ------------------------------------------------------------------ */

function normalizeConfig(config) {
  const raw = typeof config === 'object' && config !== null ? config : {};
  return {
    enabled: raw.enabled !== false,
    probeTimeoutMs: clampInt(raw.probeTimeoutMs, 3_000, 60_000, 15_000),
    // 会话级故障转移：默认开。关掉它，模型 429 时就是原样报错。
    failover: raw.failover !== false,
    failoverCooldownMs: clampInt(raw.failoverCooldownMs, 5_000, 600_000, 60_000),
  };
}

function clampInt(value, min, max, fallback) {
  const num = typeof value === 'string' ? Number(value) : value;
  if (typeof num !== 'number' || !Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.round(num)));
}

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 深拷贝，剥掉 loader 表达式标记对象（`{__jsExpr}` 求值结果不可回写）。 */
function plainClone(value) {
  if (Array.isArray(value)) return value.map(plainClone);
  if (!isObject(value)) return value;
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if (isObject(entry) && typeof entry.__jsExpr === 'string') continue;
    out[key] = plainClone(entry);
  }
  return out;
}

function messageOf(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

/* ------------------------------------------------------------------ *
 * 惰性模块加载
 *
 * 并行开发期间某个 lib 可能还没就位；加载失败要变成页面上的中文提示，
 * 而不是让插件加载期抛错。加载成功一次后缓存。
 * ------------------------------------------------------------------ */

function createLazyLoader() {
  const cache = new Map();
  return function load(key, importer) {
    if (!cache.has(key)) {
      cache.set(
        key,
        Promise.resolve()
          .then(importer)
          .then((mod) => ({ ok: true, mod }))
          .catch((error) => ({ ok: false, error: messageOf(error) })),
      );
    }
    return cache.get(key);
  };
}

/* ------------------------------------------------------------------ *
 * 读配置
 * ------------------------------------------------------------------ */

/**
 * 读 `llm-pi-ai` 的有效配置。
 *
 * `describe()` 给的是投影后的表单值：`value` 是合并后的有效值，`user` 是
 * 用户层覆盖，`revision` 写回时要带上。任何一步缺字段都按空处理。
 */
function readTarget(settings) {
  let descriptor;
  try {
    descriptor = settings.describe().find((row) => row.ns === TARGET_NS);
  } catch (error) {
    return { error: `读取 ${TARGET_NS} 配置失败：${messageOf(error)}` };
  }
  if (!descriptor) {
    return { error: `当前 profile 没有 ${TARGET_NS} 这一行，模型配置无处可写。` };
  }
  const effective = isObject(descriptor.value) ? descriptor.value : {};
  const userLayer = isObject(descriptor.user) ? descriptor.user : {};
  const providers = isObject(effective.providers) ? effective.providers : {};
  const userProviders = isObject(userLayer.providers) ? userLayer.providers : {};
  return {
    providers,
    userProviders,
    revision: descriptor.revision,
    writable: descriptor.applies === 'live',
    descriptor,
  };
}

/** 把 providers 字典压成"诊断需要的那点信息"，避免把密钥带出去。 */
function summarizeProviders(providers) {
  const rows = [];
  for (const [route, profile] of Object.entries(providers)) {
    if (!isObject(profile)) continue;
    const models = Array.isArray(profile.models) ? profile.models : [];
    rows.push({
      route,
      displayName: typeof profile.displayName === 'string' ? profile.displayName : route,
      api: typeof profile.api === 'string' ? profile.api : null,
      baseURL: typeof profile.baseURL === 'string' ? profile.baseURL : null,
      hasApiKeyEnv: typeof profile.apiKeyEnv === 'string' && profile.apiKeyEnv.length > 0,
      apiKeyEnv: typeof profile.apiKeyEnv === 'string' ? profile.apiKeyEnv : null,
      hasAuthHeader: Boolean(headerValue(profile.headers, 'authorization')),
      modelCount: models.length,
      models: models.map((model) => ({
        id: isObject(model) ? String(model.id ?? '') : '',
        name: isObject(model) && typeof model.name === 'string' ? model.name : null,
        input: isObject(model) && Array.isArray(model.input) ? model.input : null,
        contextWindow: isObject(model) ? (model.contextWindow ?? null) : null,
        maxTokens: isObject(model) ? (model.maxTokens ?? null) : null,
        hasReasoningEfforts: isObject(model) && model.reasoningEfforts !== undefined,
        reasoningEfforts: isObject(model) && model.reasoningEfforts !== undefined ? model.reasoningEfforts : null,
      })),
    });
  }
  return rows;
}

function headerValue(headers, wanted) {
  if (!isObject(headers)) return undefined;
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === wanted.toLowerCase());
  return key === undefined ? undefined : headers[key];
}

/* ------------------------------------------------------------------ *
 * 凭据状态（只问"有没有"，不问"是什么"）
 * ------------------------------------------------------------------ */

async function readCredentialState(ctx, providers) {
  const out = {};
  const refs = new Set();
  for (const profile of Object.values(providers)) {
    if (!isObject(profile)) continue;
    if (typeof profile.apiKeyEnv === 'string' && profile.apiKeyEnv.length > 0) refs.add(profile.apiKeyEnv);
  }
  const credentials = ctx.get('credentials');
  for (const ref of refs) {
    if (!credentials || typeof credentials.describe !== 'function') {
      out[ref] = { configured: null, source: null, note: '凭据服务不可用，无法确认' };
      continue;
    }
    try {
      const info = await credentials.describe(ref);
      out[ref] = {
        configured: Boolean(info?.configured),
        source: typeof info?.source === 'string' ? info.source : null,
      };
    } catch (error) {
      out[ref] = { configured: null, source: null, note: `查询失败：${messageOf(error)}` };
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 运行时状态
 * ------------------------------------------------------------------ */

function readLlmProviders(ctx) {
  const llm = ctx.get('llm');
  if (!llm || typeof llm.listProviders !== 'function') return null;
  try {
    const list = llm.listProviders();
    return Array.isArray(list)
      ? list.map((row) => ({ id: String(row?.id ?? ''), name: String(row?.name ?? row?.id ?? '') }))
      : null;
  } catch {
    return null;
  }
}

async function readPlugins(ctx) {
  const manager = ctx.get('pluginManager');
  if (!manager || typeof manager.listPlugins !== 'function') return null;
  try {
    const list = await manager.listPlugins();
    return Array.isArray(list)
      ? list.map((row) => ({
          entryId: String(row?.entryId ?? ''),
          moduleName: String(row?.moduleName ?? ''),
          enabled: Boolean(row?.enabled),
          fiberPhase: row?.fiberPhase ?? null,
        }))
      : null;
  } catch {
    return null;
  }
}

function readDefaultSelection(ctx) {
  const service = ctx.get('agentDefaultModel');
  if (!service || typeof service.currentSelection !== 'function') return null;
  try {
    const selection = service.currentSelection();
    if (!isObject(selection)) return null;
    return {
      provider: typeof selection.provider === 'string' ? selection.provider : null,
      model: typeof selection.model === 'string' ? selection.model : null,
      reasoningEffort:
        typeof selection.reasoningEffort === 'string' ? selection.reasoningEffort : null,
    };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * 健康分
 * ------------------------------------------------------------------ */

function scoreOf(findings) {
  let score = 100;
  for (const finding of findings) {
    if (finding.severity === 'fatal') score -= 18;
    else if (finding.severity === 'warn') score -= 6;
    else score -= 1;
  }
  return Math.max(0, Math.min(100, score));
}

function summarize(findings) {
  const summary = { fatal: 0, warn: 0, info: 0, total: findings.length, repairable: 0 };
  for (const finding of findings) {
    if (finding.severity === 'fatal') summary.fatal += 1;
    else if (finding.severity === 'warn') summary.warn += 1;
    else summary.info += 1;
    if (finding.repair && typeof finding.repair.kind === 'string') summary.repairable += 1;
  }
  return summary;
}

/* ------------------------------------------------------------------ *
 * HTTP 小工具
 * ------------------------------------------------------------------ */

function sendJson(res, status, payload) {
  let body;
  try {
    body = Buffer.from(JSON.stringify(payload), 'utf8');
  } catch (error) {
    body = Buffer.from(JSON.stringify({ ok: false, error: `响应序列化失败：${messageOf(error)}` }), 'utf8');
    status = 500;
  }
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(isObject(parsed) ? parsed : {});
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

/* ------------------------------------------------------------------ *
 * 主体
 * ------------------------------------------------------------------ */

function apply(ctx, config) {
  const cfg = normalizeConfig(config);
  const logger = ctx.logger;

  if (!cfg.enabled) {
    logger?.info?.('[framework-doctor] disabled by config; settings page stays mountable');
    return;
  }

  const settings = ctx.settings;
  if (!settings || typeof settings.describe !== 'function') {
    logger?.warn?.('[framework-doctor] settings service unavailable; plugin is inert');
    return;
  }

  const load = createLazyLoader();
  const loadInfer = () => load('infer', () => import('./lib/infer.js'));
  const loadDiagnose = () => load('diagnose', () => import('./lib/diagnose.js'));
  const loadRepair = () => load('repair', () => import('./lib/repair.js'));

  /** 最近一次扫描结果，供 /state 与页面首屏使用。 */
  let lastScan = null;

  /** 探测超时：页面请求可能中途断开，但探测本身要有自己的上限。 */
  function probeSignal(outerSignal) {
    const timeout = AbortSignal.timeout(cfg.probeTimeoutMs);
    return outerSignal ? AbortSignal.any([outerSignal, timeout]) : timeout;
  }

  /**
   * 解析一次探测要用的密钥。
   *
   * 优先用页面上临时填的（用户刚粘贴、还没入库的那个），其次用该 route
   * 已配置的 `apiKeyEnv` 引用。密钥只在本进程内使用，不写日志、不进响应。
   */
  async function resolveProbeKey(ctx2, apiKey, apiKeyEnv) {
    if (typeof apiKey === 'string' && apiKey.trim().length > 0) return apiKey.trim();
    if (typeof apiKeyEnv !== 'string' || apiKeyEnv.length === 0) return undefined;
    const credentials = ctx2.get('credentials');
    if (!credentials || typeof credentials.resolve !== 'function') return undefined;
    try {
      const resolved = await credentials.resolve(apiKeyEnv);
      return typeof resolved?.value === 'string' && resolved.value.length > 0 ? resolved.value : undefined;
    } catch {
      return undefined;
    }
  }

  /** 探测一次端点，把 infer 模块的失败也归一成中文原因。 */
  async function probe(request, signal) {
    const loaded = await loadInfer();
    if (!loaded.ok) return { ok: false, error: `探测模块加载失败：${loaded.error}` };
    const infer = loaded.mod;
    if (typeof infer.probeEndpoint !== 'function') {
      return { ok: false, error: '探测模块缺少 probeEndpoint 导出' };
    }
    try {
      const result = await infer.probeEndpoint(request, signal);
      return { ok: true, result, infer };
    } catch (error) {
      return { ok: false, error: messageOf(error) };
    }
  }

  /** 收集一次体检需要的全部输入。任一来源不可用时对应字段为 null。 */
  async function collectInputs() {
    const target = readTarget(settings);
    if (target.error) return { error: target.error };
    const providers = target.providers;
    const [credentialState, plugins] = await Promise.all([
      readCredentialState(ctx, providers),
      readPlugins(ctx),
    ]);
    return {
      providers,
      revision: target.revision,
      credentialState,
      plugins,
      llmProviders: readLlmProviders(ctx),
      defaultSelection: readDefaultSelection(ctx),
    };
  }

  /** 跑一次完整体检，返回 findings + 汇总 + 健康分。 */
  async function scan() {
    const loadedDiagnose = await loadDiagnose();
    if (!loadedDiagnose.ok) {
      return { ok: false, error: `体检模块加载失败：${loadedDiagnose.error}` };
    }
    const diagnose = loadedDiagnose.mod;
    const inputs = await collectInputs();
    if (inputs.error) return { ok: false, error: inputs.error };

    const findings = [];
    const failures = [];
    try {
      if (typeof diagnose.diagnoseConfig === 'function') {
        findings.push(
          ...diagnose.diagnoseConfig({
            providers: inputs.providers,
            defaultSelection: inputs.defaultSelection,
            credentialState: inputs.credentialState,
            llmProviders: inputs.llmProviders,
          }),
        );
      } else {
        failures.push('体检模块缺少 diagnoseConfig 导出');
      }
    } catch (error) {
      failures.push(`配置体检出错：${messageOf(error)}`);
    }
    try {
      if (typeof diagnose.diagnoseRuntime === 'function') {
        findings.push(
          ...diagnose.diagnoseRuntime({
            plugins: inputs.plugins,
            llmProviders: inputs.llmProviders,
            defaultSelection: inputs.defaultSelection,
            providers: inputs.providers,
          }),
        );
      }
    } catch (error) {
      failures.push(`运行时体检出错：${messageOf(error)}`);
    }

    // 稳定排序：致命在前，同级按 id 字典序，保证两次扫描顺序一致。
    const order = { fatal: 0, warn: 1, info: 2 };
    findings.sort((a, b) => {
      const delta = (order[a.severity] ?? 9) - (order[b.severity] ?? 9);
      if (delta !== 0) return delta;
      return String(a.id).localeCompare(String(b.id));
    });

    const result = {
      ok: true,
      findings,
      summary: summarize(findings),
      health: scoreOf(findings),
      scannedAt: new Date().toISOString(),
      warnings: failures,
      checked: {
        config: true,
        runtime: inputs.plugins !== null || inputs.llmProviders !== null,
        credentials: Object.keys(inputs.credentialState).length > 0,
      },
    };
    lastScan = result;
    return result;
  }

  /* ------------------------------------------------------------------ *
   * 对话助手的信息工具（全部只读）
   *
   * 用户要求"AI 要能随时拿到框架的足够信息"。做法：给模型一份工具目录，
   * 它可以在一轮对话里多次点名要数据，Host 去真实服务取回来喂给它。
   * 这里**只放只读工具**：写操作（修复/写入配置）永远走可点击的动作，
   * 由用户按下才执行。
   * ------------------------------------------------------------------ */

  const INFO_TOOLS = [
    ['state', '{}', '总览：provider 清单（含 baseURL、凭据有无、模型数）、默认模型、已注册到模型服务的 route'],
    ['diagnose', '{}', '跑一次完整体检，返回所有问题和严重度'],
    ['plugins', '{}', '插件清单：每个插件的 entryId、包名、是否启用、加载相位（active/failed/pending）'],
    ['tools', '{}', '这个智能体现在能调用哪些工具（名字 + 说明）'],
    ['provider', '{"route":"配置名"}', '某个 provider 的完整配置（密钥已脱敏）'],
    ['probe', '{"baseURL":"https://...","api":"可选","apiKey":"可选"}', '实时访问一个端点，返回它公布的模型清单与推导出的能力'],
  ];

  /** 执行一次信息工具，返回给模型看的纯文本。任何失败都变成可读文本，不抛。 */
  async function dispatchInfoTool(name, args) {
    const tool = String(name || '').trim();
    const a = isObject(args) ? args : {};
    try {
      if (tool === 'state') {
        const target = readTarget(settings);
        if (target.error) return `读取失败：${target.error}`;
        const rows = summarizeProviders(target.providers);
        const selection = readDefaultSelection(ctx);
        const llmProviders = readLlmProviders(ctx);
        const credentialState = await readCredentialState(ctx, target.providers);
        const lines = [];
        lines.push(`默认模型：${selection ? `${selection.provider} / ${selection.model}${selection.reasoningEffort ? `（思考档位 ${selection.reasoningEffort}）` : ''}` : '未设置'}`);
        lines.push(`已注册到模型服务的 route：${llmProviders && llmProviders.length ? llmProviders.map((p) => p.id).join('、') : '（读不到或为空）'}`);
        lines.push(`llm-pi-ai 配置里的 provider：${rows.length ? '' : '（空）'}`);
        for (const row of rows) {
          const cred = row.apiKeyEnv
            ? `${row.apiKeyEnv}${credentialState[row.apiKeyEnv]?.configured === false ? '（未配置值）' : '（已配置）'}`
            : row.hasAuthHeader ? '用 headers 鉴权' : '无';
          lines.push(`- ${row.route}（${row.displayName}）：api=${row.api || '未声明'}，baseURL=${row.baseURL || '无'}，凭据=${cred}，模型数=${row.modelCount}`);
          for (const model of row.models.slice(0, 30)) {
            lines.push(`    · ${model.id}｜输入=${model.input ? model.input.join('+') : '未声明'}｜上下文=${model.contextWindow ?? '未声明'}｜输出上限=${model.maxTokens ?? '未声明'}｜思考档位=${model.hasReasoningEfforts ? JSON.stringify(model.reasoningEfforts) : '未声明'}`);
          }
        }
        return lines.join('\n');
      }

      if (tool === 'diagnose') {
        const result = await scan();
        if (!result.ok) return `体检失败：${result.error}`;
        const lines = [`健康分 ${result.health}/100；致命 ${result.summary.fatal}、警告 ${result.summary.warn}、提示 ${result.summary.info}`];
        for (const finding of result.findings) {
          lines.push(`- [${finding.severity}] ${finding.id}｜${finding.title}`);
          if (finding.route) lines.push(`  位置：${finding.route}${finding.modelId ? ` / ${finding.modelId}` : ''}`);
          lines.push(`  ${finding.detail}`);
          if (finding.repair?.kind) lines.push(`  可用修复：${finding.repair.kind}`);
        }
        if (result.findings.length === 0) lines.push('没有发现问题。');
        return lines.join('\n');
      }

      if (tool === 'plugins') {
        const plugins = await readPlugins(ctx);
        if (plugins === null) return '插件服务不可用（ctx.pluginManager 未提供）。';
        const lines = [`共 ${plugins.length} 个插件行：`];
        for (const row of plugins) {
          lines.push(`- ${row.entryId}｜${row.moduleName}｜启用=${row.enabled}｜相位=${row.fiberPhase ?? '无'}`);
        }
        return lines.join('\n');
      }

      if (tool === 'tools') {
        const registry = ctx.get('tools');
        if (!registry || typeof registry.schemas !== 'function') return '工具注册表不可用（ctx.tools 未提供）。';
        const schemas = registry.schemas();
        const lines = [`共 ${schemas.length} 个工具：`];
        for (const schema of schemas) {
          lines.push(`- ${schema.name}：${String(schema.description || '').slice(0, 120)}`);
        }
        return lines.join('\n');
      }

      if (tool === 'provider') {
        const route = typeof a.route === 'string' ? a.route.trim() : '';
        if (!route) return '缺少参数 route。';
        const target = readTarget(settings);
        if (target.error) return `读取失败：${target.error}`;
        const profile = target.providers[route];
        if (!isObject(profile)) return `没有名为 "${route}" 的 provider。现有：${Object.keys(target.providers).join('、') || '（空）'}`;
        // 脱敏：headers 里的值一律换成占位，避免模型把密钥复述出来。
        const safe = plainClone(profile);
        if (isObject(safe.headers)) {
          for (const key of Object.keys(safe.headers)) {
            if (/authorization|api[-_]?key|token|secret/i.test(key)) safe.headers[key] = '<已脱敏>';
          }
        }
        return JSON.stringify(safe, null, 2);
      }

      if (tool === 'probe') {
        const baseURL = typeof a.baseURL === 'string' ? a.baseURL.trim() : '';
        if (!baseURL) return '缺少参数 baseURL。';
        const apiKey = await resolveProbeKey(ctx, a.apiKey, a.apiKeyEnv);
        const outcome = await probe(
          {
            baseURL,
            api: typeof a.api === 'string' && a.api.length > 0 ? a.api : undefined,
            apiKey,
          },
          probeSignal(),
        );
        if (!outcome.ok) return `探测失败：${outcome.error}`;
        const lines = [`清单地址：${outcome.result.endpoint}；带密钥=${outcome.result.hasKey}`];
        for (const model of outcome.result.models.slice(0, 50)) {
          lines.push(`- ${model.id}｜输入=${model.input ? model.input.join('+') : '未声明'}｜上下文=${model.contextWindow ?? '未声明'}｜输出上限=${model.maxTokens ?? '未声明'}｜思考档位=${model.reasoningEfforts === false ? '不支持' : model.reasoningEfforts ? Object.keys(model.reasoningEfforts).join('/') : '未识别'}`);
        }
        return lines.join('\n');
      }

      return `未知的信息工具 "${tool}"。可用的：${INFO_TOOLS.map((t) => t[0]).join('、')}`;
    } catch (error) {
      return `工具 ${tool} 执行出错：${messageOf(error)}`;
    }
  }

  /** 从模型回复里解析 TOOL 请求行，并剥掉它们。 */
  function parseToolCalls(rawText) {
    const calls = [];
    const kept = [];
    for (const rawLine of String(rawText || '').split(/\r?\n/)) {
      const match = rawLine.match(/^\s*TOOL:\s*(\{.*\})\s*$/);
      if (!match) {
        kept.push(rawLine);
        continue;
      }
      try {
        const parsed = JSON.parse(match[1]);
        if (parsed && typeof parsed.name === 'string') {
          calls.push({ name: parsed.name, args: isObject(parsed.args) ? parsed.args : {} });
          continue;
        }
      } catch {
        /* 解析不了的当普通文本留着 */
      }
      kept.push(rawLine);
    }
    return { calls, text: kept.join('\n') };
  }

  /**
   * 对话式助手：用户在对话框里说需求，AI 在框架医生范围内回答。
   *
   * 设计：
   *   - 多轮对话：客户端把历史消息带过来；
   *   - 按需取数：模型可以在回复里写 `TOOL: {"name":"plugins","args":{}}`，
   *     Host 执行只读工具并把结果回喂，最多 4 轮，然后给最终回答；
   *   - 动作建议：回复末尾的 `ACTIONS:` 段变成可点击按钮，写操作由用户按下才执行。
   */
  async function chat(body) {
    const selection = readDefaultSelection(ctx);
    if (!selection || !selection.provider || !selection.model) {
      return { ok: false, error: '没有可用的默认模型，无法对话（请先在模型设置里选一个默认模型）' };
    }
    const llm = ctx.get('llm');
    if (!llm || typeof llm.stream !== 'function') {
      return { ok: false, error: '模型服务不可用（ctx.llm 未提供），无法对话' };
    }

    const scanResult = await scan();
    if (!scanResult.ok) return { ok: false, error: scanResult.error };
    const target = readTarget(settings);
    const providersSummary = target.error
      ? []
      : summarizeProviders(target.providers);

    // 系统提示：角色 + 只读信息工具目录 + 回答规范。
    // 初始只给"摘要 + 工具目录"，具体数据由模型按需点名索取 —— 这样它拿到的
    // 是当前真实状态，而不是开场那一眼的快照。
    const systemLines = [
      '你是 DSH「框架医生」里的对话助手，负责帮用户看护这个智能体的模型配置与运行健康。',
      '',
      '你可以随时点名索取框架信息来回答用户：在你的回复里单独写一行',
      '  TOOL: {"name":"工具名","args":{...}}',
      'Host 会执行这个只读工具，把真实结果回给你，然后你继续回答。最多可以连续索取 4 轮。',
      '可用的信息工具：',
    ];
    for (const [toolName, argsShape, description] of INFO_TOOLS) {
      systemLines.push(`- ${toolName} ${argsShape}：${description}`);
    }
    systemLines.push(
      '',
      '你的原则：',
      '1. 用大白话回答，先讲最要紧的；不确定的事实要先 TOOL 查证，不要凭印象猜；',
      '2. 只描述事实和建议，不要假装已经修改了任何东西；',
      '3. 最终回答（不再需要工具时）不要输出 TOOL 行；',
      '4. 如果用户想做某件事（修复、接入新 provider、切换默认模型等），在回答末尾追加一个 `ACTIONS:` 段，',
      '   每行一条 `- 动作标签 | 动作类型 | 附加JSON参数`，动作类型只能是下列之一：',
      '   - `run-diagnose`：重新体检；',
      '   - `repair-all`：一键修复所有可自动修复的问题；',
      '   - `repair-one | {"id":"findingId"}`：修复指定问题；',
      '   - `probe | {"baseURL":"https://...","apiKey":"可选密钥"}`：探测一个端点并列出模型；',
      '   - `apply-probe | {"route":"配置名","baseURL":"https://...","apiKey":"可选密钥"}`：把探测结果写入配置。',
      '   这些动作是给用户点的按钮，写操作只有用户按下才会执行。用户没说要做动作就不要输出 ACTIONS 段。',
      '',
      `当前默认模型：${selection.provider} / ${selection.model}`,
      '',
      `开场摘要（需要细节就用工具查）：健康分 ${scanResult.health}/100；致命 ${scanResult.summary.fatal}、警告 ${scanResult.summary.warn}、提示 ${scanResult.summary.info}`,
    );
    if (scanResult.findings.length > 0) {
      systemLines.push(`最要紧的 ${Math.min(5, scanResult.findings.length)} 条（完整清单用 diagnose 工具查）：`);
      for (const finding of scanResult.findings.slice(0, 5)) {
        systemLines.push(`- [${finding.severity}] ${finding.title}`);
      }
    } else {
      systemLines.push('体检发现：没有发现问题。');
    }
    systemLines.push(
      '',
      `llm-pi-ai 配置里现有 ${providersSummary.length} 个 provider${providersSummary.length ? `：${providersSummary.map((r) => r.route).join('、')}` : ''}（细节用 state 工具查）。`,
    );

    // 历史消息：客户端传 `[{role:'user'|'assistant', text}]`，最多保留最近 10 条。
    const history = Array.isArray(body.messages) ? body.messages.slice(-10) : [];
    const messages = [
      { role: 'system', content: [{ type: 'text', text: systemLines.join('\n') }] },
    ];
    for (const entry of history) {
      if (entry && typeof entry.text === 'string') {
        messages.push({
          role: entry.role === 'assistant' ? 'assistant' : 'user',
          content: [{ type: 'text', text: entry.text }],
        });
      }
    }
    const userText = typeof body.message === 'string' && body.message.trim().length > 0
      ? body.message.trim()
      : '';
    if (userText) {
      messages.push({ role: 'user', content: [{ type: 'text', text: userText }] });
    }

    // 工具循环：模型可以连续索取信息（最多 4 轮），拿够了再给最终回答。
    const consulted = [];
    const MAX_TOOL_ROUNDS = 4;
    let rawReply = '';
    let lastText = '';

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
      const controller = new AbortController();
      const stream = llm.stream({
        provider: selection.provider,
        model: selection.model,
        messages,
        signal: controller.signal,
      });

      const chunks = [];
      let finished = false;
      try {
        for await (const chunk of stream) {
          if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') chunks.push(chunk.text);
          if (chunk?.type === 'finish') finished = true;
        }
      } catch (error) {
        return { ok: false, error: `对话失败：${messageOf(error)}` };
      }
      if (!finished && chunks.length === 0) {
        return { ok: false, error: '模型没有返回任何内容（可能被中止或无输出）' };
      }

      const roundText = chunks.join('');
      lastText = roundText;
      const { calls, text } = parseToolCalls(roundText);

      // 没有索取工具 → 这就是最终回答。
      if (calls.length === 0) {
        rawReply = roundText;
        break;
      }

      // 有索取：把这一轮的文字（若有）记成助手发言，然后回喂工具结果。
      if (text.trim()) {
        messages.push({ role: 'assistant', content: [{ type: 'text', text: text.trim() }] });
      }
      const results = [];
      for (const call of calls) {
        const output = await dispatchInfoTool(call.name, call.args);
        consulted.push({ name: call.name, args: call.args });
        results.push(`【工具 ${call.name} 的结果】\n${output}`);
      }
      messages.push({
        role: 'user',
        content: [{
          type: 'text',
          text:
            `${results.join('\n\n')}\n\n` +
            '以上是真实数据。如果还需要别的信息，继续用 TOOL 行索取（剩余轮数 ' +
            `${MAX_TOOL_ROUNDS - round}）；不需要就给出最终回答。`,
        }],
      });

      if (round === MAX_TOOL_ROUNDS) rawReply = text.trim() || '（已连续索取多轮信息，请根据上面的数据直接问我）';
    }

    const { reply, actions } = parseActions(rawReply || lastText);

    return {
      ok: true,
      reply,
      actions,
      consulted,
      model: { provider: selection.provider, model: selection.model },
      generatedAt: new Date().toISOString(),
    };
  }

  /** 从模型回复里解析 ACTIONS 段，产出可点击动作列表。 */
  function parseActions(rawReply) {
    const actions = [];
    let reply = rawReply;
    const marker = rawReply.lastIndexOf('ACTIONS:');
    if (marker !== -1) {
      const tail = rawReply.slice(marker + 'ACTIONS:'.length);
      reply = rawReply.slice(0, marker).trimEnd();
      for (const rawLine of tail.split(/\r?\n/)) {
        const line = rawLine.replace(/^-\s*/, '').trim();
        if (!line) continue;
        const parts = line.split('|').map((part) => part.trim());
        if (parts.length < 2) continue;
        const label = parts[0];
        const type = parts[1];
        const jsonText = parts.slice(2).join('|').trim();
        let args = {};
        if (jsonText) {
          try {
            args = JSON.parse(jsonText.replace(/`/g, ''));
          } catch {
            continue;
          }
        }
        actions.push({ label, type, args });
      }
    }
    return { reply, actions };
  }

  /**
   * 执行修复。
   *
   * 两轮：第一轮 planRepair 拿到需要探测的步骤，探测后把结果塞进
   * `context.probed` 再跑第二轮拿到具体 op。然后逐条落地。
   */
  async function repair({ findingIds, dryRun }) {
    const loadedDiagnose = await loadDiagnose();
    if (!loadedDiagnose.ok) return { ok: false, error: `体检模块加载失败：${loadedDiagnose.error}` };
    const loadedRepair = await loadRepair();
    if (!loadedRepair.ok) return { ok: false, error: `修复模块加载失败：${loadedRepair.error}` };
    const diagnose = loadedDiagnose.mod;
    const repairMod = loadedRepair.mod;
    if (typeof repairMod.planRepair !== 'function') {
      return { ok: false, error: '修复模块缺少 planRepair 导出' };
    }

    const inputs = await collectInputs();
    if (inputs.error) return { ok: false, error: inputs.error };

    let findings;
    try {
      findings = [
        ...(diagnose.diagnoseConfig({
          providers: inputs.providers,
          defaultSelection: inputs.defaultSelection,
          credentialState: inputs.credentialState,
          llmProviders: inputs.llmProviders,
        }) ?? []),
        ...(diagnose.diagnoseRuntime({
          plugins: inputs.plugins,
          llmProviders: inputs.llmProviders,
          defaultSelection: inputs.defaultSelection,
          providers: inputs.providers,
        }) ?? []),
      ];
    } catch (error) {
      return { ok: false, error: `体检出错：${messageOf(error)}` };
    }

    if (Array.isArray(findingIds) && findingIds.length > 0) {
      const wanted = new Set(findingIds.map(String));
      findings = findings.filter((finding) => wanted.has(String(finding.id)));
    }

    const baseContext = {
      providers: inputs.providers,
      defaultSelection: inputs.defaultSelection,
      probed: {},
    };

    let plan;
    try {
      plan = repairMod.planRepair(findings, baseContext) ?? { steps: [], skipped: [] };
    } catch (error) {
      return { ok: false, error: `生成修复计划出错：${messageOf(error)}` };
    }

    // 第一轮里标了 needsProbe 的步骤：按 route 探测一次，填进 context.probed。
    const probeRoutes = new Set();
    for (const step of plan.steps ?? []) {
      const route = step?.payload?.route;
      if (step?.needsProbe && typeof route === 'string' && route.length > 0) probeRoutes.add(route);
    }
    const probeErrors = {};
    for (const route of probeRoutes) {
      const profile = inputs.providers[route];
      if (!isObject(profile)) {
        probeErrors[route] = '该提供方已不在配置里';
        continue;
      }
      const apiKey = await resolveProbeKey(ctx, undefined, profile.apiKeyEnv);
      const outcome = await probe(
        {
          baseURL: typeof profile.baseURL === 'string' ? profile.baseURL : '',
          api: typeof profile.api === 'string' ? profile.api : undefined,
          apiKey,
          headers: isObject(profile.headers) ? profile.headers : undefined,
        },
        probeSignal(),
      );
      if (outcome.ok) {
        baseContext.probed[route] = outcome.result.models;
      } else {
        probeErrors[route] = outcome.error;
      }
    }

    if (probeRoutes.size > 0) {
      try {
        plan = repairMod.planRepair(findings, baseContext) ?? plan;
      } catch (error) {
        return { ok: false, error: `生成修复计划出错：${messageOf(error)}` };
      }
    }

    const steps = Array.isArray(plan.steps) ? plan.steps : [];
    const result = {
      ok: true,
      dryRun: Boolean(dryRun),
      planned: steps.length,
      applied: [],
      skipped: [],
      failed: [],
      probeErrors,
    };

    // 按 settings 命名空间把 op 分组：一次 mutate 提交一组，减少往返。
    const llmOps = [];
    const llmStepIds = [];
    for (const step of steps) {
      const op = step?.op;
      if (!op || typeof op !== 'object') {
        result.skipped.push({
          findingId: step?.findingId ?? null,
          title: step?.title ?? '',
          reason:
            typeof repairMod.describeRepair === 'function'
              ? repairMod.describeRepair(step)
              : (step?.payload?.hint ?? '需要人工处理'),
        });
        continue;
      }
      if (op.op === 'set' || op.op === 'unset') {
        llmOps.push(op);
        llmStepIds.push(step.findingId ?? null);
      } else {
        result.skipped.push({
          findingId: step?.findingId ?? null,
          title: step?.title ?? '',
          reason: `未知的 op 类型：${String(op.op)}`,
        });
      }
    }

    if (dryRun) {
      result.applied = llmOps.map((op, index) => ({
        findingId: llmStepIds[index],
        op,
        status: 'planned',
      }));
      return result;
    }

    if (llmOps.length > 0) {
      try {
        await settings.mutate(TARGET_NS, llmOps, inputs.revision);
        result.applied.push(
          ...llmOps.map((op, index) => ({ findingId: llmStepIds[index], op, status: 'applied' })),
        );
        logger?.info?.(`[framework-doctor] applied ${llmOps.length} config op(s)`);
      } catch (error) {
        result.failed.push({ scope: TARGET_NS, error: messageOf(error), ops: llmOps.length });
        logger?.warn?.(`[framework-doctor] config repair failed: ${messageOf(error)}`);
      }
    }

    // 默认模型选择走自己的服务，不混在 llm-pi-ai 的 ops 里。
    for (const step of steps) {
      const selection = step?.payload?.selection;
      if (!isObject(selection) || step?.op) continue;
      if (typeof selection.provider !== 'string' || typeof selection.model !== 'string') continue;
      const service = ctx.get('agentDefaultModel');
      if (!service || typeof service.saveSelection !== 'function') {
        result.skipped.push({
          findingId: step?.findingId ?? null,
          title: step?.title ?? '',
          reason: '默认模型服务不可用，无法写入',
        });
        continue;
      }
      if (dryRun) {
        result.applied.push({ findingId: step?.findingId ?? null, selection, status: 'planned' });
        continue;
      }
      try {
        await service.saveSelection({
          provider: selection.provider,
          model: selection.model,
          ...(typeof selection.reasoningEffort === 'string'
            ? { reasoningEffort: selection.reasoningEffort }
            : {}),
        });
        result.applied.push({ findingId: step?.findingId ?? null, selection, status: 'applied' });
      } catch (error) {
        result.failed.push({ scope: DEFAULT_MODEL_NS, error: messageOf(error) });
      }
    }

    return result;
  }

  /**
   * 写入一个提供方。
   *
   * 密钥处理：页面填了 key 就存进凭据服务（`apiKeyEnv` 引用），配置里
   * 只留引用名；没填就沿用该 route 已有的引用。绝不把明文写进配置。
   */
  async function applyProvider(body, signal) {
    const route = typeof body.route === 'string' ? body.route.trim() : '';
    if (!route) return { ok: false, status: 400, error: '缺少提供方名称（route）' };
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(route)) {
      return { ok: false, status: 400, error: '提供方名称只能用字母、数字、点、下划线和连字符' };
    }

    const note = [];

    const baseURL = typeof body.baseURL === 'string' ? body.baseURL.trim() : '';
    if (!baseURL) return { ok: false, status: 400, error: '缺少调用网址（baseURL）' };
    let parsed;
    try {
      parsed = new URL(baseURL);
    } catch {
      return { ok: false, status: 400, error: `调用网址不是合法网址：${baseURL}` };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { ok: false, status: 400, error: '调用网址只能是 http 或 https' };
    }

    const models = Array.isArray(body.models) ? body.models.filter(isObject) : [];
    if (models.length === 0) {
      return { ok: false, status: 400, error: '没有要写入的模型，请先探测端点并勾选模型' };
    }

    const target = readTarget(settings);
    if (target.error) return { ok: false, status: 500, error: target.error };
    const existing = isObject(target.providers[route]) ? target.providers[route] : {};
    const existingModels = Array.isArray(existing.models) ? existing.models.filter(isObject) : [];

    /* 合并模式：以现有模型为底，探测结果按 id 覆盖已存在模型的字段，
       追加端点公布但配置里没有的模型，保留端点没公布的手写模型。
       默认（merge 为 false）是整组覆盖 —— 严格按用户勾选写入。 */
    let merged = false;
    let nextModels;
    if (body.mergeModels === true && existingModels.length > 0) {
      const byId = new Map();
      for (const model of existingModels) {
        const id = typeof model.id === 'string' ? model.id : '';
        if (id) byId.set(id, plainClone(model));
      }
      for (const found of models) {
        const id = typeof found.id === 'string' ? found.id.trim() : '';
        if (!id) continue;
        const current = byId.get(id);
        if (current) {
          const next = mergeDiscovered(current, found);
          byId.set(id, next);
        } else {
          byId.set(id, cleanModel(found));
        }
      }
      nextModels = [...byId.values()].map(cleanModel).filter((model) => model !== null);
      merged = true;
      note.push(`合并模式：${existingModels.length} 个现有模型打底，按端点结果补齐`);
    } else {
      nextModels = models.map(cleanModel).filter((model) => model !== null);
      note.push('整组覆盖：写入的就是你勾选的模型列表');
    }

    // 密钥：新填的进凭据服务，否则沿用旧引用。
    let apiKeyEnv = typeof existing.apiKeyEnv === 'string' ? existing.apiKeyEnv : undefined;
    const typedKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
    if (typedKey.length > 0) {
      const credentials = ctx.get('credentials');
      if (!credentials || typeof credentials.set !== 'function') {
        return { ok: false, status: 500, error: '凭据服务不可用，无法保存密钥（拒绝把明文写进配置文件）' };
      }
      apiKeyEnv = typeof body.apiKeyEnv === 'string' && body.apiKeyEnv.trim().length > 0
        ? body.apiKeyEnv.trim()
        : `${route.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`;
      try {
        await credentials.set(apiKeyEnv, typedKey);
        note.push(`密钥已存入凭据服务（引用名 ${apiKeyEnv}）`);
      } catch (error) {
        return { ok: false, status: 500, error: `密钥保存失败：${messageOf(error)}` };
      }
    } else if (apiKeyEnv) {
      note.push(`沿用已有凭据引用 ${apiKeyEnv}`);
    } else {
      note.push('没有提供密钥，该提供方将以无凭据状态写入');
    }

    // 只写 schema 认识的字段，其余继承值保持不动。
    const nextProfile = plainClone(existing);
    nextProfile.displayName =
      typeof body.displayName === 'string' && body.displayName.trim().length > 0
        ? body.displayName.trim()
        : (typeof existing.displayName === 'string' ? existing.displayName : route);
    nextProfile.baseURL = baseURL;
    if (typeof body.api === 'string' && body.api.length > 0) nextProfile.api = body.api;
    if (apiKeyEnv) nextProfile.apiKeyEnv = apiKeyEnv;
    nextProfile.models = nextModels;

    if (nextProfile.models.length === 0) {
      return { ok: false, status: 400, error: '勾选的模型都缺少 id，没有可写入的内容' };
    }

    try {
      await settings.mutate(
        TARGET_NS,
        [{ op: 'set', path: ['providers', route], value: nextProfile }],
        target.revision,
      );
    } catch (error) {
      return { ok: false, status: 500, error: `写入配置失败：${messageOf(error)}` };
    }

    logger?.info?.(
      `[framework-doctor] wrote provider ${route} with ${nextProfile.models.length} model(s)` +
        (merged ? ' (merged)' : ''),
    );
    return {
      ok: true,
      route,
      merged,
      written: nextProfile.models.length,
      models: nextProfile.models.map((model) => model.id),
      note: note.join('；'),
    };
  }

  /**
   * 合并一条探测结果到现有模型条目。
   *
   * 只覆盖探测**明确说过的**字段（input / contextWindow / maxTokens /
   * reasoningEfforts / compat），其余（显示名、手写的自定义字段）保持原样。
   * 探测没说过的字段绝不回填成默认值。
   */
  function mergeDiscovered(current, found) {
    const out = plainClone(current);
    if (Array.isArray(found.input)) {
      const input = [];
      for (const item of found.input) {
        if ((item === 'text' || item === 'image') && !input.includes(item)) input.push(item);
      }
      if (input.length > 0) out.input = input;
    }
    for (const key of ['contextWindow', 'maxTokens']) {
      const value = found[key];
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) out[key] = Math.round(value);
    }
    if (found.reasoningEfforts === false) out.reasoningEfforts = false;
    else if (isObject(found.reasoningEfforts)) {
      const efforts = {};
      for (const [level, wire] of Object.entries(found.reasoningEfforts)) {
        if (!['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(level)) continue;
        if (wire === null) efforts[level] = null;
        else if (typeof wire === 'string' && wire.length > 0) efforts[level] = wire;
      }
      if (Object.keys(efforts).length > 0) out.reasoningEfforts = efforts;
    }
    if (isObject(found.compat)) {
      const compat = plainClone(out.compat ?? {});
      for (const key of [
        'thinkingFormat',
        'supportsReasoningEffort',
        'supportsStore',
        'supportsDeveloperRole',
        'supportsUsageInStreaming',
        'supportsFinishReason',
        'maxTokensField',
        'requiresToolResultName',
        'requiresAssistantAfterToolResult',
        'requiresThinkingAsText',
        'requiresReasoningContentOnAssistantMessages',
      ]) {
        const value = found.compat[key];
        if (typeof value === 'string' || typeof value === 'boolean') compat[key] = value;
      }
      if (Object.keys(compat).length > 0) out.compat = compat;
    }
    return out;
  }

  /** 模型条目清洗：只留 schema 认识的字段，剥掉探测期加的诊断字段。 */
  function cleanModel(model) {
    if (!isObject(model)) return null;
    const id = typeof model.id === 'string' ? model.id.trim() : '';
    if (!id) return null;
    const out = { id };
    if (typeof model.name === 'string' && model.name.trim().length > 0) out.name = model.name.trim();
    if (Array.isArray(model.input)) {
      const input = [];
      for (const item of model.input) {
        if ((item === 'text' || item === 'image') && !input.includes(item)) input.push(item);
      }
      out.input = input.length > 0 ? input : ['text'];
    }
    for (const key of ['contextWindow', 'maxTokens']) {
      const value = model[key];
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) out[key] = Math.round(value);
    }
    if (model.reasoningEfforts === false) out.reasoningEfforts = false;
    else if (isObject(model.reasoningEfforts)) {
      const efforts = {};
      for (const [level, wire] of Object.entries(model.reasoningEfforts)) {
        if (!['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(level)) continue;
        if (wire === null) efforts[level] = null;
        else if (typeof wire === 'string' && wire.length > 0) efforts[level] = wire;
      }
      if (Object.keys(efforts).length > 0) out.reasoningEfforts = efforts;
    }
    if (isObject(model.compat)) {
      const compat = {};
      for (const key of [
        'thinkingFormat',
        'supportsReasoningEffort',
        'supportsStore',
        'supportsDeveloperRole',
        'supportsUsageInStreaming',
        'supportsFinishReason',
        'maxTokensField',
        'requiresToolResultName',
        'requiresAssistantAfterToolResult',
        'requiresThinkingAsText',
        'requiresReasoningContentOnAssistantMessages',
      ]) {
        const value = model.compat[key];
        if (typeof value === 'string' || typeof value === 'boolean') compat[key] = value;
      }
      if (Object.keys(compat).length > 0) out.compat = compat;
    }
    return out;
  }

  /* ---------------------------------------------------------------- *
   * 路由
   * ---------------------------------------------------------------- */

  async function handle(req, res, url) {
    const route = url.pathname.slice(ROUTE_PREFIX.length) || '/';

    if (route === '/state' && req.method === 'GET') {
      const target = readTarget(settings);
      if (target.error) {
        sendJson(res, 500, { ok: false, error: target.error });
        return;
      }
      const [credentialState, plugins] = await Promise.all([
        readCredentialState(ctx, target.providers),
        readPlugins(ctx),
      ]);
      sendJson(res, 200, {
        ok: true,
        providers: summarizeProviders(target.providers),
        defaultSelection: readDefaultSelection(ctx),
        credentialState,
        llmProviders: readLlmProviders(ctx),
        plugins,
        lastScanAt: lastScan?.scannedAt ?? null,
        health: lastScan?.health ?? null,
        summary: lastScan?.summary ?? null,
        config: { autoScan: cfg.autoScan, scanIntervalMs: cfg.scanIntervalMs },
      });
      return;
    }

    if (route === '/probe' && req.method === 'POST') {
      const body = await readBody(req);
      const baseURL = typeof body.baseURL === 'string' ? body.baseURL.trim() : '';
      if (!baseURL) {
        sendJson(res, 400, { ok: false, error: '缺少调用网址（baseURL）' });
        return;
      }
      const controller = new AbortController();
      req.on('close', () => controller.abort());
      const apiKey = await resolveProbeKey(ctx, body.apiKey, body.apiKeyEnv);
      const outcome = await probe(
        {
          baseURL,
          api: typeof body.api === 'string' && body.api.length > 0 ? body.api : undefined,
          apiKey,
          headers: isObject(body.headers) ? body.headers : undefined,
        },
        probeSignal(controller.signal),
      );
      if (!outcome.ok) {
        sendJson(res, 502, { ok: false, error: outcome.error });
        return;
      }
      sendJson(res, 200, {
        ok: true,
        models: outcome.result.models ?? [],
        endpoint: outcome.result.endpoint ?? null,
        triedEndpoints: outcome.result.triedEndpoints ?? [],
        hasKey: Boolean(outcome.result.hasKey),
        warnings: outcome.result.warnings ?? [],
      });
      return;
    }

    if (route === '/diagnose' && req.method === 'POST') {
      const result = await scan();
      sendJson(res, result.ok ? 200 : 500, result);
      return;
    }

    if (route === '/apply' && req.method === 'POST') {
      const body = await readBody(req);
      const controller = new AbortController();
      req.on('close', () => controller.abort());
      const result = await applyProvider(body, controller.signal);
      sendJson(res, result.ok ? 200 : (result.status ?? 500), result);
      return;
    }

    if (route === '/repair' && req.method === 'POST') {
      const body = await readBody(req);
      const result = await repair({
        findingIds: Array.isArray(body.findingIds) ? body.findingIds : undefined,
        dryRun: body.dryRun === true,
      });
      sendJson(res, result.ok ? 200 : 500, result);
      return;
    }

    if (route === '/chat' && req.method === 'POST') {
      const body = await readBody(req);
      const result = await chat(body);
      sendJson(res, result.ok ? 200 : 500, result);
      return;
    }

    sendJson(res, 404, { ok: false, error: `未知接口：${route}` });
  }

  // 信任围栏：晚绑定 connection（composition 可能在插件加载之后才发布它）。
  const fence = connectionAdmissionView(() => ctx.get('connection'));

  function rejectIfUntrusted(req, res) {
    const status = rejectionFor(req, fence, undefined);
    if (status === undefined) return false;
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(status === 401 ? 'unauthorized' : status === 503 ? 'admission unavailable' : 'forbidden');
    return true;
  }

  ctx.inject(['webServer'], (scoped) => {
    const server = scoped.webServer;
    scoped.effect(
      () =>
        server.register({
          kind: 'prefix',
          path: ROUTE_PREFIX,
          handler: (req, res) => {
            if (rejectIfUntrusted(req, res)) return;
            let url;
            try {
              url = new URL(req.url ?? '/', 'http://127.0.0.1');
            } catch {
              sendJson(res, 400, { ok: false, error: '请求地址无法解析' });
              return;
            }
            Promise.resolve()
              .then(() => handle(req, res, url))
              .catch((error) => {
                logger?.warn?.(`[framework-doctor] ${url.pathname} failed: ${messageOf(error)}`);
                if (!res.headersSent) sendJson(res, 500, { ok: false, error: messageOf(error) });
              });
          },
        }),
      'framework-doctor: api routes',
    );
    logger?.info?.(`[framework-doctor] api mounted at ${ROUTE_PREFIX}`);
  });

  /* 不设自动巡检：配置好之后不动它，体检只在用户手动点、或配置被改动时进行。 */

  /* ---------------------------------------------------------------- *
   * 会话级故障转移
   *
   * 模型调用因 429 / 配额 / 服务端错误中断时，换一个已接入的渠道继续，
   * 而不是让会话卡在那里。
   *
   * 机制（已对着 harness 的 agent-loop 源码确认）：
   *   - `agent/request-error` 返回 { kind: 'retry' } → loop `continue`，
   *     在同一 turn/step 内重新走 prepareRequest；
   *   - prepareRequest 每次都重新触发 `agent/request` waterfall，
   *     那里返回的 provider/model 就是这次 attempt 真正要用的路由。
   *
   * 所以：request-error 里挑好备用渠道并写进会话覆盖表，request 里读表替换。
   * 只在**失败之后**才换，绝不改动用户原本的选择。
   * ---------------------------------------------------------------- */

  if (cfg.failover) {
    ctx.effect(() => {
      let state = null;
      let disposed = false;

      // 懒加载：failover 模块坏了不能连累插件本体起来。
      const ready = load('failover', () => import('./lib/failover.js')).then((loaded) => {
        if (!loaded.ok) {
          logger?.warn?.(`[framework-doctor] failover disabled: ${loaded.error}`);
          return null;
        }
        state = loaded.mod.createFailoverState({ cooldownMs: cfg.failoverCooldownMs });
        return loaded.mod;
      });

      const offFailure = ctx.on('agent/request-error', async (payload, next) => {
        const mod = await ready;
        if (!mod || disposed || !state) return next();

        const failure = payload?.failure;
        const route = typeof payload?.provider === 'string' ? payload.provider : '';
        const sessionId = payload?.agent?.id;

        if (!route || !sessionId || !mod.shouldFailover(failure)) return next();

        const target = readTarget(settings);
        if (target.error) return next();

        // 记一次失败：这个 route 进入冷却，避免同一 attempt 链条反复打同一个坏渠道。
        const cooling = state.markFailed(sessionId, route);

        // 当前 attempt 用的是哪个模型：优先用会话里记着的（第一次失败时记的原始选择），
        // payload 本身不带 model。
        const previous = state.getOverride(sessionId);
        if (previous && previous.provider) cooling.add(previous.provider);
        const wantedModel = previous?.model ?? state.modelFor(sessionId) ?? '';

        const picked = mod.pickFailoverTarget({
          failedProvider: route,
          model: wantedModel,
          providers: target.providers,
          cooling,
          registered: (readLlmProviders(ctx) || []).map((row) => row.id),
        });

        if (!picked) {
          state.noteExhausted();
          logger?.warn?.(
            `[framework-doctor] no failover target for ${route}` +
              `${wantedModel ? ` (model ${wantedModel})` : ''} ` +
              `after ${failure?.code || failure?.status || 'failure'}; leaving the error terminal`,
          );
          return next();
        }

        state.setOverride(sessionId, picked);
        logger?.info?.(
          `[framework-doctor] failover ${route} → ${picked.route} (${picked.model}) ` +
            `after ${failure?.code || failure?.status || 'failure'}; retrying`,
        );
        return { kind: 'retry' };
      });

      const offRequest = ctx.on('agent/request', async (payload, next) => {
        const config = await next();
        const mod = await ready;
        if (!mod || disposed || !state) return config;

        const sessionId = payload?.agent?.id;
        if (!sessionId) return config;

        // 记下这一步真实要用的模型：request-error 的 payload 不带 model，
        // 换渠道时要靠它来判断"同名模型"。
        state.noteModel(sessionId, config.model);

        const override = state.getOverride(sessionId);
        if (!override || !override.provider || !override.model) return config;

        // 只有在确实还是"换过去的那条路由"时才替换；
        // 用户若在失败后手动改了模型，config 已经不同，就尊重用户。
        if (config.provider === override.provider && config.model === override.model) return config;

        return { ...config, provider: override.provider, model: override.model };
      });

      // 成功的轮次结束后清掉覆盖，回归用户原本的模型选择。
      const offTurnEnd = ctx.on('agent/turn-stopping', async (payload) => {
        if (!state) return;
        const sessionId = payload?.agent?.id;
        if (!sessionId) return;
        if (state.getOverride(sessionId)) state.clearOverride(sessionId);
      });

      const offDisposed = ctx.on('agent/disposed', (payload) => {
        if (!state) return;
        const sessionId = payload?.agent?.id;
        if (sessionId) state.forget(sessionId);
      });

      return () => {
        disposed = true;
        offFailure?.();
        offRequest?.();
        offTurnEnd?.();
        offDisposed?.();
      };
    }, 'framework-doctor: session failover');
  }

  logger?.info?.('[framework-doctor] ready');
}

export { name, apply, inject, normalizeConfig, TARGET_NS, ROUTE_PREFIX };
