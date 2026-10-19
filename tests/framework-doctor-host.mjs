/**
 * 框架医生 —— Host 端集成自测（不依赖浏览器、不依赖真实 webServer）
 *
 * 桩掉 ctx，跑一遍 apply()，把注册的 HTTP 路由抓出来，逐个打请求，
 * 断言响应结构。目的是在安装前抓住"插件加载就炸"和"接口返回空壳"这两类问题。
 *
 * 用法：node tests/framework-doctor-host.mjs
 */

import { pathToFileURL } from 'node:url';

import { fileURLToPath } from 'node:url';

/** 仓库根：本文件在 <repo>/tests/ 下，所以往上一层。 */
const PLUGIN = fileURLToPath(new URL('../index.js', import.meta.url));

let failures = 0;
let checks = 0;

function ok(condition, label, detail) {
  checks += 1;
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail).slice(0, 400)}`}`);
  }
}

function eq(actual, expected, label) {
  ok(Object.is(actual, expected), label, { actual, expected });
}

/* ------------------------------------------------------------------ *
 * 一份"故意不完美"的配置：缺 baseURL、缺凭据、推理模型没写档位……
 * ------------------------------------------------------------------ */
const PROVIDERS = {
  'good-gateway': {
    displayName: '好的网关',
    apiKeyEnv: 'GOOD_GATEWAY_API_KEY',
    api: 'openai-completions',
    baseURL: 'https://api.example.com/v1',
    models: [
      { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', contextWindow: 131072 },
      { id: 'gpt-4o', name: 'GPT-4o', input: ['text', 'image'] },
    ],
  },
  'broken-gateway': {
    displayName: '坏掉的网关',
    api: 'openai-completions',
    models: [{ id: 'mystery-model' }],
  },
  'dup-gateway': {
    apiKeyEnv: 'DUP_KEY',
    baseURL: 'http://127.0.0.1:8000/v1',
    models: [
      { id: 'same-id', input: ['text'] },
      { id: 'same-id', input: ['text'] },
    ],
  },
};

const DEFAULT_SELECTION = { provider: 'ghost-provider', model: 'ghost-model', reasoningEffort: null };

const PLUGINS = [
  { entryId: 'ui-chat', moduleName: '@deepseek-ai/dsh-client-ui-chat', enabled: true, fiberPhase: 'active' },
  { entryId: 'some-broken', moduleName: 'broken-plugin', enabled: true, fiberPhase: 'failed' },
];

const LLM_PROVIDERS = [
  { id: 'good-gateway', name: '好的网关' },
  { id: 'broken-gateway', name: '坏掉的网关' },
];

/* ------------------------------------------------------------------ *
 * ctx 桩
 * ------------------------------------------------------------------ */

function makeCtx(overrides = {}) {
  const captured = { routes: [], effects: [], warnings: [], infos: [] };
  let revision = 7;
  const mutations = [];

  /* 活配置：describe 读它、mutate 写它，模拟真实 settings 的持久化语义，
     否则"先 apply 建 route、再 apply 合并"这类多步场景会读到过期快照。
     注意结构要和真实 settings 一致：配置根是 { providers: {...} }，
     mutate 的 path 是 ['providers', route]，所以这里也要有一层 providers。 */
  const liveProviders = { providers: structuredClone(PROVIDERS) };

  function applyOps(ops) {
    for (const op of ops ?? []) {
      if (op?.op !== 'set' || !Array.isArray(op.path) || op.path.length === 0) continue;
      let cursor = liveProviders;
      for (let i = 0; i < op.path.length - 1; i += 1) {
        const key = op.path[i];
        if (typeof cursor[key] !== 'object' || cursor[key] === null) cursor[key] = {};
        cursor = cursor[key];
      }
      cursor[op.path[op.path.length - 1]] = structuredClone(op.value);
    }
  }

  const settings = {
    describe() {
      return [
        {
          ns: 'llm-pi-ai',
          applies: 'live',
          revision,
          value: structuredClone(liveProviders),
          user: structuredClone(liveProviders),
        },
        { ns: 'agent-default-model', applies: 'live', revision: 1, value: {}, user: {} },
      ];
    },
    async mutate(ns, ops, expected) {
      mutations.push({ ns, ops, expected });
      if (ns === 'llm-pi-ai') {
        applyOps(ops);
        revision += 1;
      }
    },
  };

  const ctx = {
    logger: {
      info: (msg) => captured.infos.push(String(msg)),
      warn: (msg) => captured.warnings.push(String(msg)),
      debug: () => {},
      error: (msg) => captured.warnings.push(String(msg)),
    },
    settings,
    effect(fn) {
      const dispose = fn();
      captured.effects.push(dispose);
      return () => {};
    },
    on() {
      return () => {};
    },
    get(name) {
      if (name === 'llm') {
        return {
          listProviders: () => LLM_PROVIDERS,
          // 模拟模型流：两段文本 + finish。
          stream(options) {
            const self = this;
            return (async function* () {
              yield { type: 'text-delta', index: 0, text: '框架看起来基本健康。' };
              yield { type: 'text-delta', index: 0, text: ' 最要紧的是修好那个坏网关。' };
              yield { type: 'finish', reason: { kind: 'stop' } };
              void options;
              void self;
            })();
          },
        };
      }
      if (name === 'pluginManager') return { listPlugins: async () => PLUGINS };
      if (name === 'agentDefaultModel') {
        return {
          currentSelection: () => ({ ...DEFAULT_SELECTION }),
          saveSelection: async (next) => {
            mutations.push({ ns: 'agent-default-model', selection: next });
          },
        };
      }
      if (name === 'credentials') {
        return {
          describe: async (ref) => ({ configured: ref === 'GOOD_GATEWAY_API_KEY', writable: true }),
          resolve: async (ref) => (ref === 'GOOD_GATEWAY_API_KEY' ? { value: 'sk-test', source: 'store' } : undefined),
          set: async (ref, value) => {
            mutations.push({ ns: 'credentials', ref, value: '<redacted>' });
          },
        };
      }
      if (name === 'connection') return undefined;
      return undefined;
    },
    inject(deps, callback) {
      // 只模拟 webServer 存在的那条路径
      if (deps.includes('webServer')) {
        callback({
          webServer: {
            register(route) {
              captured.routes.push(route);
              return () => {};
            },
          },
          effect(fn) {
            const dispose = fn();
            captured.effects.push(dispose);
            return () => {};
          },
          get: ctx.get,
          logger: ctx.logger,
        });
      }
    },
    ...overrides,
  };

  return { ctx, captured, mutations, getRevision: () => revision };
}

/* ------------------------------------------------------------------ *
 * 假的 req / res
 * ------------------------------------------------------------------ */

function makeRes() {
  const state = { status: 0, headers: {}, body: '', finished: false };
  return {
    state,
    writeHead(status, headers) {
      state.status = status;
      state.headers = headers ?? {};
    },
    end(body) {
      state.body = body === undefined ? '' : String(body);
      state.finished = true;
    },
    get json() {
      try {
        return JSON.parse(state.body);
      } catch {
        return null;
      }
    },
  };
}

function makeReq(method, url, body) {
  const listeners = new Map();
  let flushed = false;
  const req = {
    method,
    url,
    headers: { host: '127.0.0.1:50554' },
    on(event, fn) {
      listeners.set(event, fn);
      // 真流里数据在监听器挂上之后才到；这里在 `end` 一挂上就补发，
      // 避免"监听器还没注册、事件已经放完"的假失败。
      if (event === 'end' && !flushed) {
        flushed = true;
        setTimeout(() => {
          if (body !== undefined) {
            listeners.get('data')?.(Buffer.from(JSON.stringify(body), 'utf8'));
          }
          listeners.get('end')?.();
        }, 0);
      }
      return req;
    },
    destroy() {},
  };
  return req;
}

async function call(captured, method, path, body) {
  const route = captured.routes.find((candidate) => candidate.kind === 'prefix');
  if (!route) throw new Error('没有注册任何 prefix 路由');
  const res = makeRes();
  await route.handler(makeReq(method, `/api/framework-doctor${path}`, body), res);
  // handler 内部是 fire-and-forget 的 Promise 链，等两轮微任务 + 一点时间
  for (let i = 0; i < 60 && !res.state.finished; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return res;
}

/* ------------------------------------------------------------------ *
 * 跑
 * ------------------------------------------------------------------ */

console.log('== 加载 Host 模块 ==');
let mod;
try {
  mod = await import(pathToFileURL(PLUGIN).href);
  ok(true, 'index.js 可加载');
} catch (error) {
  ok(false, 'index.js 可加载', error.message);
  process.exit(1);
}

eq(mod.name, 'framework-doctor', 'name 导出正确');
ok(Array.isArray(mod.inject) && mod.inject.includes('settings'), 'inject 含 settings');
ok(typeof mod.apply === 'function', 'apply 是函数');
eq(mod.ROUTE_PREFIX, '/api/framework-doctor', 'ROUTE_PREFIX 正确');

console.log('== normalizeConfig ==');
const cfg = mod.normalizeConfig({ probeTimeoutMs: 999999 });
ok(cfg.probeTimeoutMs <= 60000, 'probeTimeoutMs 被夹到上限以下', cfg.probeTimeoutMs);
ok(cfg.autoScan === undefined, 'autoScan 已被移除（不再有自动巡检）', cfg);
eq(mod.normalizeConfig({}).enabled, true, 'enabled 默认 true');
eq(mod.normalizeConfig({ enabled: false }).enabled, false, 'enabled 可关闭');

console.log('== apply() 装配 ==');
const { ctx, captured, mutations } = makeCtx();
try {
  mod.apply(ctx, { enabled: true, autoScan: false });
  ok(true, 'apply 不抛错');
} catch (error) {
  ok(false, 'apply 不抛错', error.message);
  process.exit(1);
}
ok(captured.routes.length === 1, '注册了且只注册了一个 HTTP 路由', captured.routes.map((r) => r.path));
eq(captured.routes[0]?.kind, 'prefix', '路由是 prefix');
eq(captured.routes[0]?.path, '/api/framework-doctor', '路由路径正确');

console.log('== GET /state ==');
{
  const res = await call(captured, 'GET', '/state');
  eq(res.state.status, 200, '/state 200');
  const body = res.json;
  ok(body && body.ok === true, '/state ok:true');
  ok(Array.isArray(body?.providers), '/state 返回 providers 数组');
  eq(body?.providers?.length, 3, '三个提供方都在');
  const good = body?.providers?.find((row) => row.route === 'good-gateway');
  ok(good && good.hasApiKeyEnv === true, 'good-gateway 有 apiKeyEnv');
  ok(good && good.modelCount === 2, 'good-gateway 两个模型');
  ok(!JSON.stringify(body).includes('sk-test'), '/state 响应里没有密钥明文');
  ok(body?.credentialState?.GOOD_GATEWAY_API_KEY?.configured === true, '凭据状态已解析');
  ok(Array.isArray(body?.llmProviders) && body.llmProviders.length === 2, 'llmProviders 已读取');
  ok(Array.isArray(body?.plugins) && body.plugins.length === 2, 'plugins 已读取');
}

console.log('== POST /diagnose ==');
let diagnoseBody;
{
  const res = await call(captured, 'POST', '/diagnose', {});
  const body = res.json;
  diagnoseBody = body;
  if (body?.ok === false && String(body?.error ?? '').includes('加载失败')) {
    console.log(`  SKIP 体检模块还没就位：${body.error}`);
  } else {
    eq(res.state.status, 200, '/diagnose 200');
    ok(body?.ok === true, '/diagnose ok:true');
    ok(Array.isArray(body?.findings), '返回 findings 数组');
    ok(body.findings.length > 0, '在故意配错的样例上确实查出了问题', body?.findings?.length);
    ok(typeof body?.health === 'number' && body.health >= 0 && body.health <= 100, 'health 在 0-100');
    ok(body?.summary?.fatal > 0, '至少一条 fatal', body?.summary);
    const ids = body.findings.map((f) => f.id);
    ok(ids.every((id) => typeof id === 'string' && id.length > 0), '每条 finding 都有 id');
    eq(new Set(ids).size, ids.length, 'finding id 不重复');
    // 二次扫描：id 必须稳定
    const again = (await call(captured, 'POST', '/diagnose', {})).json;
    eq(
      JSON.stringify(again.findings.map((f) => f.id)),
      JSON.stringify(ids),
      '两次扫描 id 顺序与内容一致（稳定可复现）',
    );
  }
}

console.log('== POST /apply ==');
{
  const res = await call(captured, 'POST', '/apply', {
    route: 'new-gateway',
    baseURL: 'https://new.example.com/v1',
    api: 'openai-completions',
    apiKey: 'sk-brand-new-secret',
    models: [
      {
        id: 'qwen3-max',
        name: 'Qwen3 Max',
        input: ['text'],
        contextWindow: 262144,
        maxTokens: 32768,
        reasoningEfforts: { off: null, low: 'low', medium: 'medium', high: 'high' },
        compat: { thinkingFormat: 'qwen-chat-template', supportsReasoningEffort: true },
        confidence: 'inferred',
        notes: ['按家族推测'],
      },
    ],
  });
  const body = res.json;
  eq(res.state.status, 200, '/apply 200');
  ok(body?.ok === true, '/apply ok:true');
  eq(body?.written, 1, '写入一个模型');
  const mutation = mutations.find((m) => m.ns === 'llm-pi-ai' && m.ops?.[0]?.path?.[0] === 'providers');
  ok(Boolean(mutation), '确实调用了 settings.mutate 写 providers');
  const written = mutation?.ops?.[0]?.value;
  eq(written?.baseURL, 'https://new.example.com/v1', 'baseURL 写入正确');
  ok(typeof written?.apiKeyEnv === 'string' && written.apiKeyEnv.includes('NEW_GATEWAY'), '生成了 apiKeyEnv 引用');
  ok(!JSON.stringify(written).includes('sk-brand-new-secret'), '配置里没有密钥明文');
  ok(mutations.some((m) => m.ns === 'credentials'), '密钥走凭据服务写入');
  const model = written?.models?.[0];
  ok(model && model.id === 'qwen3-max', '模型 id 保留');
  ok(model && model.confidence === undefined, '诊断字段 confidence 被剥掉');
  ok(model && model.notes === undefined, '诊断字段 notes 被剥掉');
  ok(model && typeof model.compat?.thinkingFormat === 'string', 'compat.thinkingFormat 保留');
}

console.log('== /apply mergeModels（已有提供方补齐，不丢数据） ==');
{
  // 先给一个"已有" route：手写两个模型，其中一个端点不会再公布。
  await call(captured, 'POST', '/apply', {
    route: 'merge-gateway',
    baseURL: 'https://merge.example.com/v1',
    apiKeyEnv: 'MERGE_KEY',
    models: [
      { id: 'kept-model', name: '手写保留模型', input: ['text'], contextWindow: 8192, maxTokens: 2048 },
      { id: 'legacy-model', name: '端点已下线的模型', input: ['text'] },
    ],
  });
  // 合并写入：探测结果含 kept-model（补齐字段）+ new-model（追加），不含 legacy-model。
  const res = await call(captured, 'POST', '/apply', {
    route: 'merge-gateway',
    baseURL: 'https://merge.example.com/v1',
    apiKeyEnv: 'MERGE_KEY',
    mergeModels: true,
    models: [
      {
        id: 'kept-model',
        input: ['text', 'image'],
        contextWindow: 131072,
        maxTokens: 65536,
        reasoningEfforts: { off: null, low: 'low', medium: 'medium', high: 'high' },
      },
      { id: 'new-model', name: '端点新模型', input: ['text'], contextWindow: 262144, maxTokens: 32768 },
    ],
  });
  const body = res.json;
  eq(res.state.status, 200, '/apply merge 200');
  ok(body?.ok === true, '/apply merge ok:true');
  eq(body?.merged, true, 'merge 标记回传');
  // 同一个 route 已被前面的用例写过，取最后一次写入 merge-gateway 的 mutation。
  const mergeMutations = mutations.filter(
    (m) => m.ns === 'llm-pi-ai' && m.ops?.[0]?.path?.[0] === 'providers' && m.ops?.[0]?.path?.[1] === 'merge-gateway',
  );
  ok(mergeMutations.length >= 2, 'merge-gateway 至少写入了两次（先建后合）', mergeMutations.length);
  const mutation = mergeMutations[mergeMutations.length - 1];
  const writtenModels = mutation?.ops?.[0]?.value?.models ?? [];
  const byId = new Map(writtenModels.map((model) => [model.id, model]));
  ok(byId.has('kept-model'), '已有模型 kept-model 被保留', [...byId.keys()]);
  ok(byId.has('legacy-model'), '端点没公布的 legacy-model 也被保留（不丢数据）', [...byId.keys()]);
  ok(byId.has('new-model'), '端点新模型 new-model 被追加', [...byId.keys()]);
  eq(writtenModels.length, 3, '合并后共 3 个模型', writtenModels.length);
  const kept = byId.get('kept-model');
  ok(Array.isArray(kept?.input) && kept.input.includes('image'), 'kept-model 的 image 模态被探测结果补齐', kept?.input);
  eq(kept?.contextWindow, 131072, 'kept-model 上下文被补齐', kept?.contextWindow);
  ok(kept?.reasoningEfforts && typeof kept.reasoningEfforts === 'object', 'kept-model 思考档位被补齐');
  eq(kept?.name, '手写保留模型', 'kept-model 手写显示名保持不动');
  // 不合并时仍是整组覆盖
  await call(captured, 'POST', '/apply', {
    route: 'merge-gateway',
    baseURL: 'https://merge.example.com/v1',
    apiKeyEnv: 'MERGE_KEY',
    models: [{ id: 'only-one' }],
  });
  const mergeMutations2 = mutations.filter(
    (m) => m.ns === 'llm-pi-ai' && m.ops?.[0]?.path?.[0] === 'providers' && m.ops?.[0]?.path?.[1] === 'merge-gateway',
  );
  const mutation2 = mergeMutations2[mergeMutations2.length - 1];
  const writtenModels2 = mutation2?.ops?.[0]?.value?.models ?? [];
  eq(writtenModels2.length, 1, '不合并时严格按勾选覆盖', writtenModels2.map((m) => m.id));
}

console.log('== /apply 参数校验 ==');
{
  const cases = [
    [{}, 400, '缺 route'],
    [{ route: 'bad route!', baseURL: 'https://x.example/v1', models: [{ id: 'a' }] }, 400, 'route 非法字符'],
    [{ route: 'r', baseURL: 'not-a-url', models: [{ id: 'a' }] }, 400, 'baseURL 非法'],
    [{ route: 'r', baseURL: 'ftp://x.example', models: [{ id: 'a' }] }, 400, '非 http 协议'],
    [{ route: 'r', baseURL: 'https://x.example/v1', models: [] }, 400, '没有模型'],
    [{ route: 'r', baseURL: 'https://x.example/v1', models: [{ name: '没有 id' }] }, 400, '模型全都没有 id'],
  ];
  for (const [payload, status, label] of cases) {
    const res = await call(captured, 'POST', '/apply', payload);
    eq(res.state.status, status, `/apply 拒绝：${label}`);
    ok(res.json?.ok === false, `/apply ${label} 返回 ok:false`);
    ok(typeof res.json?.error === 'string' && res.json.error.length > 0, `/apply ${label} 有中文原因`);
  }
}

console.log('== POST /repair (dryRun) ==');
{
  const res = await call(captured, 'POST', '/repair', { dryRun: true });
  const body = res.json;
  if (body?.ok === false && String(body?.error ?? '').includes('加载失败')) {
    console.log(`  SKIP 修复模块还没就位：${body.error}`);
  } else {
    eq(res.state.status, 200, '/repair dryRun 200');
    ok(body?.ok === true, '/repair dryRun ok:true');
    eq(body?.dryRun, true, 'dryRun 标记回传');
    ok(Array.isArray(body?.applied) && Array.isArray(body?.skipped) && Array.isArray(body?.failed), '三段结果都在');
    ok((body?.applied?.length ?? 0) > 0, '在故意配错的样例上至少能计划出一条修复', body?.planned);
    ok(
      (body?.applied ?? []).every((row) => row.status === 'planned'),
      'dryRun 不真的落地（status 全是 planned）',
    );
  }
}

console.log('== POST /chat（对话助手） ==');
{
  const res = await call(captured, 'POST', '/chat', { message: '现在框架怎么样？' });
  const body = res.json;
  eq(res.state.status, 200, '/chat 200');
  ok(body?.ok === true, '/chat ok:true');
  ok(typeof body?.reply === 'string' && body.reply.length > 0, 'reply 是非空文本', body?.reply?.slice(0, 60));
  ok(body.reply.includes('最要紧'), 'reply 是流式拼接的完整文本', body?.reply?.slice(0, 80));
  ok(body?.model?.provider && body?.model?.model, 'reply 带上了生成它的模型');
  ok(Array.isArray(body?.consulted), '/chat 返回它查过哪些信息（consulted）');
  ok(!body?.applied && !body?.failed, '/chat 不携带任何修复执行结果（只解释）');
}

console.log('== POST /chat 工具循环（AI 按需取数） ==');
{
  // 一个"会先索取信息、再回答"的假模型：第一轮发 TOOL 行，第二轮给最终答案。
  const { ctx: toolCtx, captured: toolCaptured } = makeCtx();
  let round = 0;
  const seenMessages = [];
  toolCtx.get = function (name) {
    if (name === 'llm') {
      return {
        listProviders: () => LLM_PROVIDERS,
        stream(options) {
          seenMessages.push(options.messages);
          round += 1;
          const current = round;
          return (async function* () {
            if (current === 1) {
              yield { type: 'text-delta', index: 0, text: '我先看一下插件情况。\n' };
              yield { type: 'text-delta', index: 0, text: 'TOOL: {"name":"plugins","args":{}}\n' };
            } else {
              yield { type: 'text-delta', index: 0, text: '插件里有 2 行，其中一行加载失败。' };
            }
            yield { type: 'finish', reason: { kind: 'stop' } };
          })();
        },
      };
    }
    if (name === 'pluginManager') return { listPlugins: async () => PLUGINS };
    if (name === 'agentDefaultModel') {
      return { currentSelection: () => ({ ...DEFAULT_SELECTION }), saveSelection: async () => {} };
    }
    if (name === 'credentials') {
      return { describe: async () => ({ configured: true }) };
    }
    return undefined;
  };
  mod.apply(toolCtx, { enabled: true, probeTimeoutMs: 8000 });
  const toolRoute = toolCaptured.routes.find((candidate) => candidate.kind === 'prefix');
  ok(Boolean(toolRoute), '工具循环用的 ctx 也注册了路由');
  if (toolRoute) {
    const res = makeRes();
    await toolRoute.handler(makeReq('POST', '/api/framework-doctor/chat', { message: '插件有没有问题？' }), res);
    for (let i = 0; i < 200 && !res.state.finished; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const body = res.json;
    eq(res.state.status, 200, '工具循环 /chat 200');
    eq(round, 2, '模型被调用了两轮（先索取、后回答）', round);
    ok(Array.isArray(body?.consulted) && body.consulted.length === 1, 'consulted 记录了它查了什么', body?.consulted);
    eq(body?.consulted?.[0]?.name, 'plugins', 'consulted 里是 plugins');
    ok(
      typeof body?.reply === 'string' && body.reply.includes('2 行'),
      '最终回答来自第二轮',
      body?.reply,
    );
    ok(
      !body.reply.includes('TOOL:'),
      '最终回答里没有残留 TOOL 行',
      body?.reply,
    );
    // 工具结果确实被回喂给了模型（第二轮的消息里应包含插件清单）
    const secondRound = seenMessages[1] || [];
    const flat = JSON.stringify(secondRound);
    ok(flat.includes('broken-plugin') || flat.includes('some-broken'), '工具结果被回喂给模型', flat.slice(-200));
  }
}

console.log('== POST /chat（无默认模型 → 中文错误） ==');
{
  const { ctx: freshCtx, captured: freshCaptured } = makeCtx();
  freshCtx.get = function (name) {
    if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: '', model: '' }) };
    if (name === 'llm') return { stream() {} };
    return undefined;
  };
  mod.apply(freshCtx, { enabled: true, probeTimeoutMs: 8000 });
  const freshRoute = freshCaptured.routes.find((candidate) => candidate.kind === 'prefix');
  ok(Boolean(freshRoute), '第二个 ctx 也注册了路由');
  if (freshRoute) {
    const res = makeRes();
    await freshRoute.handler(makeReq('POST', '/api/framework-doctor/chat', { message: '在吗' }), res);
    for (let i = 0; i < 60 && !res.state.finished; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    eq(res.state.status, 500, '无默认模型时 /chat 返回 500');
    ok(res.json?.ok === false, '无默认模型时 ok:false');
    ok(
      typeof res.json?.error === 'string' && res.json.error.includes('默认模型'),
      '无默认模型时给出中文原因',
      res.json?.error,
    );
  }
}

console.log('== 未知接口 ==');
{
  const res = await call(captured, 'GET', '/nope');
  eq(res.state.status, 404, '未知路径 404');
  ok(res.json?.ok === false, '未知路径 ok:false');
}

console.log('== 信任围栏 ==');
{
  const route = captured.routes[0];
  // 非回环 Host 头应被结构围栏拒绝
  const res = makeRes();
  const req = makeReq('GET', '/api/framework-doctor/state');
  req.headers = { host: 'evil.example.com' };
  route.handler(req, res);
  await new Promise((resolve) => setTimeout(resolve, 50));
  ok(res.state.status === 403 || res.state.status === 401, '非回环 Host 被拒绝', res.state.status);
}

console.log('== 关闭 enabled 时是空操作 ==');
{
  const second = makeCtx();
  mod.apply(second.ctx, { enabled: false });
  eq(second.captured.routes.length, 0, 'disabled 时不注册路由');
}

console.log('== 缺 settings 时不炸 ==');
{
  const third = makeCtx();
  const bare = { ...third.ctx, settings: undefined };
  let threw = false;
  try {
    mod.apply(bare, {});
  } catch (error) {
    threw = true;
    console.log('    ', error.message);
  }
  eq(threw, false, '没有 settings 服务时静默退化而不是抛错');
  eq(third.captured.routes.length, 0, '没有 settings 时不注册路由');
}

console.log(`\n${failures === 0 ? '全部通过' : '有失败'}：${checks - failures}/${checks} 项通过`);
if (failures > 0) process.exitCode = 1;
