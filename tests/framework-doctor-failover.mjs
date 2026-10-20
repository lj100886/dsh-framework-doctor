/**
 * lib/failover.js + Host 端故障转移接线 的测试。
 *
 * 重点验证：
 *   - 哪些错误值得换渠道（429/配额/服务端 换；400/鉴权错误 不换）
 *   - 候选挑选：同名优先、冷却中的跳过、没有端点的跳过
 *   - Host 接线：request-error 返回 retry 并在 request 里换掉路由
 */
import { pathToFileURL } from 'node:url';

const ROOT = 'D:/loowaworkspeas/plugins/dsh-framework-doctor';

let failures = 0;
let checks = 0;

function ok(condition, label, detail) {
  checks += 1;
  if (condition) console.log(`  ok   ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail).slice(0, 500)}`}`);
  }
}
function eq(a, b, label) {
  ok(Object.is(a, b), label, { actual: a, expected: b });
}

const mod = await import(pathToFileURL(`${ROOT}/lib/failover.js`).href);

console.log('\n=== shouldFailover ===');
{
  const yes = [
    [{ code: 'RATE_LIMIT' }, 'RATE_LIMIT'],
    [{ code: 'QUOTA' }, 'QUOTA'],
    [{ code: 'SERVER' }, 'SERVER'],
    [{ code: 'TIMEOUT' }, 'TIMEOUT'],
    [{ code: 'TRANSPORT' }, 'TRANSPORT'],
    [{ code: 'EMPTY_RESPONSE' }, 'EMPTY_RESPONSE'],
    [{ status: 429 }, 'status 429'],
    [{ status: 503 }, 'status 503'],
    [{ code: 'rate_limit' }, '小写 code'],
  ];
  for (const [failure, label] of yes) {
    ok(mod.shouldFailover(failure) === true, `应换渠道：${label}`);
  }
  const no = [
    [{ code: 'INVALID_CREDENTIAL' }, '密钥错误（换渠道也没用）'],
    [{ code: 'MISSING_CREDENTIAL' }, '缺凭据'],
    [{ code: 'UNKNOWN_MODEL' }, '模型不存在'],
    [{ code: 'UNSUPPORTED_OPTION' }, '不支持参数'],
    [{ status: 400 }, 'status 400'],
    [{ status: 401 }, 'status 401'],
    [{}, '空 failure'],
    [null, 'null'],
    [undefined, 'undefined'],
  ];
  for (const [failure, label] of no) {
    ok(mod.shouldFailover(failure) === false, `不该换渠道：${label}`);
  }
}

console.log('\n=== pickFailoverTarget ===');
{
  const providers = {
    'chan-a': {
      baseURL: 'https://a.example/v1',
      models: [{ id: 'deepseek-v4.1-flash' }, { id: 'gpt-4o' }],
    },
    'chan-b': {
      baseURL: 'https://b.example/v1',
      models: [{ id: 'deepseek-v4.1-flash' }, { id: 'qwen3-max' }],
    },
    'chan-c': {
      // 没有 baseURL：不可用作故障转移目标
      models: [{ id: 'deepseek-v4.1-flash' }],
    },
  };

  const hit = mod.pickFailoverTarget({
    failedProvider: 'chan-a',
    model: 'deepseek-v4.1-flash',
    providers,
    cooling: [],
  });
  eq(hit?.route, 'chan-b', '同名模型优先选有端点的渠道');
  eq(hit?.model, 'deepseek-v4.1-flash', '模型名保持');
  eq(hit?.reason, 'same-model:chan-b', 'reason 标明 same-model');

  // 冷却中的要跳过
  const skipped = mod.pickFailoverTarget({
    failedProvider: 'chan-a',
    model: 'deepseek-v4.1-flash',
    providers,
    cooling: ['chan-b'],
  });
  eq(skipped, null, '唯一可用的渠道在冷却中时不选它');

  // 没有同名模型 → 不瞎选
  const none = mod.pickFailoverTarget({
    failedProvider: 'chan-a',
    model: 'gpt-4o',
    providers,
    cooling: [],
  });
  eq(none, null, '没有同名模型时不乱选一个');

  // 跨渠道同规格：openrouter 的 vendor 前缀
  const withPrefix = {
    'chan-a': { baseURL: 'https://a/v1', models: [{ id: 'deepseek/deepseek-v3' }] },
    'chan-b': { baseURL: 'https://b/v1', models: [{ id: 'deepseek-v3' }] },
  };
  const family = mod.pickFailoverTarget({
    failedProvider: 'chan-a',
    model: 'deepseek/deepseek-v3',
    providers: withPrefix,
    cooling: [],
  });
  eq(family?.route, 'chan-b', '去掉 vendor 前缀后匹配到同规格模型');
  eq(family?.reason, 'same-family:chan-b', 'reason 标明 same-family');

  // 未注册的渠道不选
  const unregistered = mod.pickFailoverTarget({
    failedProvider: 'chan-a',
    model: 'deepseek-v4.1-flash',
    providers,
    cooling: [],
    registered: ['chan-a'],
  });
  eq(unregistered, null, '未注册到模型服务的渠道不当目标');
}

console.log('\n=== createFailoverState ===');
{
  const state = mod.createFailoverState({ cooldownMs: 1000 });
  const t0 = 1_000_000;

  const cooling1 = state.markFailed('s1', 'chan-a', t0);
  ok(cooling1.has('chan-a'), '失败后 route 进入冷却');

  eq(state.getOverride('s1'), undefined, '一开始没有覆盖');

  state.setOverride('s1', { route: 'chan-b', model: 'm1' });
  const ov = state.getOverride('s1');
  eq(ov?.provider, 'chan-b', '覆盖表记录 provider');
  eq(ov?.model, 'm1', '覆盖表记录 model');

  // 冷却过期
  const coolingLater = state.coolingFor('s1', t0 + 5000);
  ok(!coolingLater.has('chan-a'), '冷却到期后不再是冷却态');

  // 另一个会话互不影响
  eq(state.getOverride('s2'), undefined, '不同会话状态隔离');

  state.clearOverride('s1');
  eq(state.getOverride('s1'), undefined, 'clearOverride 移除覆盖');

  state.setOverride('s1', { route: 'chan-b', model: 'm1' });
  state.markFailed('s1', 'chan-b', t0);
  state.forget('s1');
  eq(state.getOverride('s1'), undefined, 'forget 清掉覆盖');
  eq(state.coolingFor('s1', t0).size, 0, 'forget 清掉冷却');

  const stats = state.stats();
  ok(stats.attempts >= 1, 'stats 记录尝试');
  ok(stats.failovers >= 1, 'stats 记录换渠道');
}

/* ------------------------------------------------------------------ *
 * Host 接线：模拟一次 429 → 换渠道 → retry
 * ------------------------------------------------------------------ */
console.log('\n=== Host 接线（429 → 换渠道 → retry） ===');
{
  const host = await import(pathToFileURL(`${ROOT}/index.js`).href);

  const PROVIDERS = {
    'main-chan': {
      apiKeyEnv: 'MAIN_KEY',
      baseURL: 'https://main.example/v1',
      models: [{ id: 'deepseek-v4.1-flash', input: ['text'], contextWindow: 131072, maxTokens: 8192 }],
    },
    'backup-chan': {
      apiKeyEnv: 'BACKUP_KEY',
      baseURL: 'https://backup.example/v1',
      models: [{ id: 'deepseek-v4.1-flash', input: ['text'], contextWindow: 131072, maxTokens: 8192 }],
    },
  };

  const handlers = new Map();
  const registeredRoutes = [];
  const ctx = {
    logger: { info() {}, warn() {}, debug() {}, error() {} },
    settings: {
      describe: () => [
        {
          ns: 'llm-pi-ai',
          applies: 'live',
          revision: 1,
          value: { providers: structuredClone(PROVIDERS) },
          user: { providers: structuredClone(PROVIDERS) },
        },
      ],
      mutate: async () => {},
    },
    effect(fn) {
      const dispose = fn();
      return () => { if (typeof dispose === 'function') dispose(); };
    },
    on(event, listener) {
      handlers.set(event, listener);
      return () => handlers.delete(event);
    },
    get(name) {
      if (name === 'llm') {
        return { listProviders: () => Object.keys(PROVIDERS).map((id) => ({ id, name: id })) };
      }
      if (name === 'credentials') return { describe: async () => ({ configured: true }) };
      return undefined;
    },
    inject(deps, cb) {
      if (deps.includes('webServer')) {
        cb({
          webServer: { register: (r) => { registeredRoutes.push(r); return () => {}; } },
          effect: (fn) => { fn(); return () => {}; },
        });
      }
    },
  };

  host.apply(ctx, { enabled: true, failover: true, failoverCooldownMs: 1000 });

  ok(handlers.has('agent/request-error'), '注册了 agent/request-error 监听');
  ok(handlers.has('agent/request'), '注册了 agent/request 监听');

  const onError = handlers.get('agent/request-error');
  const onRequest = handlers.get('agent/request');
  const agent = { id: 'session-1' };

  // 先走一次正常 request：记下这个会话用的模型（真实流程里 request 在 request-error 之前）。
  const firstConfig = await onRequest({ agent, turn: 1, step: 1 }, async () => ({
    provider: 'main-chan',
    model: 'deepseek-v4.1-flash',
  }));
  eq(firstConfig.provider, 'main-chan', '第一次 request 不做替换');

  // 首次 429：应该返回 retry
  let delegated = false;
  const action = await onError(
    { agent, turn: 1, step: 1, provider: 'main-chan', failure: { code: 'RATE_LIMIT', message: '429' } },
    async () => { delegated = true; return undefined; },
  );
  eq(action?.kind, 'retry', '429 时返回 retry');
  ok(!delegated, '接管了恢复，没有把错误交回默认处理');

  // 随后 request waterfall：应把 provider 换成 backup-chan
  const replaced = await onRequest({ agent, turn: 1, step: 1 }, async () => ({
    provider: 'main-chan',
    model: 'deepseek-v4.1-flash',
  }));
  eq(replaced.provider, 'backup-chan', 'request 里换到了备用渠道');
  eq(replaced.model, 'deepseek-v4.1-flash', '模型保持同名');
  ok(replaced.reasoningEffort === undefined, '不透传不该有的字段');

  // 再次失败在 backup-chan：不能换回 main（冷却中），且没有第三个渠道 → 交回默认
  let delegated2 = false;
  const action2 = await onError(
    { agent, turn: 1, step: 1, provider: 'backup-chan', failure: { code: 'RATE_LIMIT', message: '429' } },
    async () => { delegated2 = true; return undefined; },
  );
  eq(action2, undefined, '没有可用目标时交回默认处理');
  ok(delegated2, '确实调用了 next()');
}

console.log('\n=== Host 接线（不可重试错误不接管） ===');
{
  const host = await import(pathToFileURL(`${ROOT}/index.js`).href);
  const handlers = new Map();
  const ctx = {
    logger: { info() {}, warn() {}, debug() {}, error() {} },
    settings: {
      describe: () => [{ ns: 'llm-pi-ai', applies: 'live', revision: 1, value: { providers: {} }, user: { providers: {} } }],
      mutate: async () => {},
    },
    effect(fn) { fn(); return () => {}; },
    on(event, listener) { handlers.set(event, listener); return () => {}; },
    get: () => undefined,
    inject: () => {},
  };
  host.apply(ctx, { enabled: true, failover: true });
  const onError = handlers.get('agent/request-error');
  ok(Boolean(onError), '注册了监听');
  let delegated = false;
  const action = await onError(
    { agent: { id: 's' }, turn: 1, step: 1, provider: 'x', failure: { code: 'INVALID_CREDENTIAL' } },
    async () => { delegated = true; return undefined; },
  );
  eq(action, undefined, '密钥错误不接管');
  ok(delegated, '密钥错误交回默认处理');
}

console.log('\n=== failover 关闭时完全不挂监听 ===');
{
  const host = await import(pathToFileURL(`${ROOT}/index.js`).href);
  const handlers = new Map();
  const ctx = {
    logger: { info() {}, warn() {}, debug() {}, error() {} },
    settings: {
      describe: () => [{ ns: 'llm-pi-ai', applies: 'live', revision: 1, value: { providers: {} }, user: { providers: {} } }],
      mutate: async () => {},
    },
    effect(fn) { fn(); return () => {}; },
    on(event, listener) { handlers.set(event, listener); return () => {}; },
    get: () => undefined,
    inject: () => {},
  };
  host.apply(ctx, { enabled: true, failover: false });
  ok(!handlers.has('agent/request-error'), 'failover=false 时不监听 request-error');
  ok(!handlers.has('agent/request'), 'failover=false 时不监听 request');
}

console.log(`\n${failures === 0 ? '全部通过' : '有失败'}：${checks - failures}/${checks} 项通过`);
if (failures > 0) process.exitCode = 1;