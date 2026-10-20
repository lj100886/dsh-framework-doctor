/**
 * lib/failover.js + Host 端故障转移接线 的测试。
 *
 * 重点：
 *   - 哪些错误值得换渠道（429/配额/服务端 换；400/鉴权错误 不换）
 *   - 错误分级：不同错误给不同冷却、严重度、是否额度问题
 *   - Retry-After 尊重端点原话；极短 Retry-After 就地重试不换渠道
 *   - 候选挑选：同名优先、冷却中的跳过、没有端点的跳过
 *   - 连续失败冷却翻倍；成功一次清零
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
    [{ status: 502 }, 'status 502'],
    [{ status: 402 }, 'status 402（额度）'],
    [{ code: 'rate_limit' }, '小写 code'],
  ];
  for (const [failure, label] of yes) ok(mod.shouldFailover(failure) === true, `应换渠道：${label}`);

  const no = [
    [{ code: 'INVALID_CREDENTIAL' }, '密钥错误'],
    [{ code: 'MISSING_CREDENTIAL' }, '缺凭据'],
    [{ code: 'UNKNOWN_MODEL' }, '模型不存在'],
    [{ code: 'UNSUPPORTED_OPTION' }, '不支持参数'],
    [{ status: 400 }, 'status 400'],
    [{ status: 401 }, 'status 401'],
    [{}, '空 failure'],
    [null, 'null'],
    [undefined, 'undefined'],
  ];
  for (const [failure, label] of no) ok(mod.shouldFailover(failure) === false, `不该换渠道：${label}`);
}

console.log('\n=== describeFailure（错误分级） ===');
{
  const quota = mod.describeFailure({ code: 'QUOTA' });
  eq(quota.code, 'QUOTA', 'QUOTA code');
  eq(quota.severity, 'critical', 'QUOTA 是 critical');
  eq(quota.scope, 'account', 'QUOTA 作用域是 account');
  eq(quota.billing, true, 'QUOTA 标记为额度问题');
  ok(quota.cooldownMs >= 30 * 60_000, 'QUOTA 冷却 ≥ 30 分钟', quota.cooldownMs);

  const rate = mod.describeFailure({ code: 'RATE_LIMIT' });
  eq(rate.severity, 'high', '429 是 high');
  ok(rate.cooldownMs >= 3 * 60_000 && rate.cooldownMs < quota.cooldownMs, '429 冷却短于 QUOTA', rate.cooldownMs);

  const server = mod.describeFailure({ code: 'SERVER' });
  eq(server.severity, 'medium', '5xx 是 medium');
  eq(server.scope, 'channel', '5xx 作用域是 channel');
  ok(server.cooldownMs < rate.cooldownMs, '5xx 冷却短于 429', server.cooldownMs);

  const net = mod.describeFailure({ code: 'TRANSPORT' });
  eq(net.scope, 'transport', '网络错误作用域是 transport');
  eq(net.severity, 'low', '网络错误是 low');
  ok(net.cooldownMs < server.cooldownMs, '网络冷却最短', net.cooldownMs);

  // Retry-After 尊重端点原话
  const withRetry = mod.describeFailure({ code: 'RATE_LIMIT', providerRetryAfterMs: 120_000 });
  ok(withRetry.cooldownMs >= 120_000, 'Retry-After 抬高冷却', withRetry.cooldownMs);
  eq(withRetry.retryAfterMs, 120_000, 'retryAfterMs 原样保留');

  // 极短 Retry-After：就地重试
  const quick = mod.describeFailure({ code: 'RATE_LIMIT', providerRetryAfterMs: 1_500 });
  eq(quick.immediate, true, '1.5 秒的 Retry-After 判为就地重试');
  const slow = mod.describeFailure({ code: 'RATE_LIMIT', providerRetryAfterMs: 30_000 });
  eq(slow.immediate, false, '30 秒的 Retry-After 不判为就地重试');

  // 上限
  const capped = mod.describeFailure({ code: 'QUOTA' }, { maxCooldownMs: 5 * 60_000 });
  ok(capped.cooldownMs <= 5 * 60_000, '冷却被上限夹住', capped.cooldownMs);

  // status-only 也能归一
  eq(mod.describeFailure({ status: 402 }).code, 'QUOTA', '402 归一为 QUOTA');
  eq(mod.describeFailure({ status: 429 }).code, 'RATE_LIMIT', '429 归一为 RATE_LIMIT');
}

console.log('\n=== pickFailoverTarget ===');
{
  const providers = {
    'chan-a': { baseURL: 'https://a.example/v1', models: [{ id: 'deepseek-v4.1-flash' }, { id: 'gpt-4o' }] },
    'chan-b': { baseURL: 'https://b.example/v1', models: [{ id: 'deepseek-v4.1-flash' }, { id: 'qwen3-max' }] },
    'chan-c': { models: [{ id: 'deepseek-v4.1-flash' }] }, // 无 baseURL
  };

  const hit = mod.pickFailoverTarget({ failedProvider: 'chan-a', model: 'deepseek-v4.1-flash', providers, cooling: [] });
  eq(hit?.route, 'chan-b', '同名模型优先选有端点的渠道');
  eq(hit?.reason, 'same-model:chan-b', 'reason 标明 same-model');

  const skipped = mod.pickFailoverTarget({
    failedProvider: 'chan-a', model: 'deepseek-v4.1-flash', providers, cooling: ['chan-b'],
  });
  eq(skipped, null, '唯一可用渠道在冷却中时不选它');

  const none = mod.pickFailoverTarget({ failedProvider: 'chan-a', model: 'gpt-4o', providers, cooling: [] });
  eq(none, null, '没有同名模型时不乱选');

  const withPrefix = {
    'chan-a': { baseURL: 'https://a/v1', models: [{ id: 'deepseek/deepseek-v3' }] },
    'chan-b': { baseURL: 'https://b/v1', models: [{ id: 'deepseek-v3' }] },
  };
  const family = mod.pickFailoverTarget({
    failedProvider: 'chan-a', model: 'deepseek/deepseek-v3', providers: withPrefix, cooling: [],
  });
  eq(family?.route, 'chan-b', '去掉 vendor 前缀后匹配同规格');
  eq(family?.reason, 'same-family:chan-b', 'reason 标明 same-family');

  const unregistered = mod.pickFailoverTarget({
    failedProvider: 'chan-a', model: 'deepseek-v4.1-flash', providers, cooling: [], registered: ['chan-a'],
  });
  eq(unregistered, null, '未注册渠道不当目标');
}

console.log('\n=== createFailoverState（健康画像） ===');
{
  const t0 = 1_000_000;
  const state = mod.createFailoverState({ maxCooldownMs: 3_600_000 });

  const first = state.markFailed('s1', 'chan-a', { code: 'RATE_LIMIT' }, t0);
  ok(first.cooling.has('chan-a'), '失败后进入冷却');
  ok(first.cooldownMs >= 3 * 60_000, '429 按类型给冷却', first.cooldownMs);
  eq(first.record.consecutiveFailures, undefined, 'record 里字段名是 failures');
  eq(first.record.failures, 1, '第一次失败计数 1');

  // 连续失败翻倍
  const second = state.markFailed('s1', 'chan-a', { code: 'RATE_LIMIT' }, t0 + 1000);
  eq(second.record.failures, 2, '第二次失败计数 2');
  ok(second.cooldownMs > first.cooldownMs, '连续失败冷却翻倍', { first: first.cooldownMs, second: second.cooldownMs });

  // 成功清零
  state.markHealthy('s1', 'chan-a');
  ok(!state.recordFor('s1', 'chan-a'), 'markHealthy 清掉档案');

  // 不同错误类型给不同冷却
  const q = state.markFailed('s1', 'chan-b', { code: 'QUOTA' }, t0);
  const s = state.markFailed('s1', 'chan-c', { code: 'SERVER' }, t0);
  ok(q.cooldownMs > s.cooldownMs, 'QUOTA 比 SERVER 冷却更久', { quota: q.cooldownMs, server: s.cooldownMs });

  // 报告
  const report = state.report('s1', t0 + 1000);
  ok(Array.isArray(report) && report.length >= 2, 'report 返回渠道档案');
  const quotaRow = report.find((row) => row.route === 'chan-b');
  eq(quotaRow?.billing, true, '报告里 QUOTA 标记 billing');
  eq(quotaRow?.severity, 'critical', '报告里带 severity');
  ok(typeof quotaRow?.remainingMs === 'number', '报告里带剩余冷却');

  // 覆盖表
  state.setOverride('s1', { route: 'chan-b', model: 'm1' });
  eq(state.getOverride('s1')?.provider, 'chan-b', '覆盖表记录 provider');
  eq(state.getOverride('s2'), undefined, '会话隔离');
  state.clearOverride('s1');
  eq(state.getOverride('s1'), undefined, 'clearOverride 移除');

  state.setOverride('s1', { route: 'x', model: 'y' });
  state.forget('s1');
  eq(state.getOverride('s1'), undefined, 'forget 清覆盖');
  eq(state.coolingFor('s1', t0).size, 0, 'forget 清健康档案');
  eq(state.report('s1', t0).length, 0, 'forget 后报告为空');

  const stats = state.stats();
  ok(stats.attempts >= 3, 'stats 记录尝试', stats.attempts);
}

/* ------------------------------------------------------------------ *
 * Host 接线
 * ------------------------------------------------------------------ */
function makeHostCtx(providers) {
  const handlers = new Map();
  const ctx = {
    logger: { info() {}, warn() {}, debug() {}, error() {} },
    settings: {
      describe: () => [
        { ns: 'llm-pi-ai', applies: 'live', revision: 1, value: { providers: structuredClone(providers) }, user: { providers: structuredClone(providers) } },
      ],
      mutate: async () => {},
    },
    effect(fn) { const d = fn(); return () => { if (typeof d === 'function') d(); }; },
    on(event, listener) { handlers.set(event, listener); return () => handlers.delete(event); },
    get(name) {
      if (name === 'llm') return { listProviders: () => Object.keys(providers).map((id) => ({ id, name: id })) };
      if (name === 'credentials') return { describe: async () => ({ configured: true }) };
      return undefined;
    },
    inject(deps, cb) {
      if (deps.includes('webServer')) {
        cb({ webServer: { register: () => () => {} }, effect: (fn) => { fn(); return () => {}; } });
      }
    },
  };
  return { ctx, handlers };
}

console.log('\n=== Host 接线（429 → 换渠道 → retry） ===');
{
  const host = await import(pathToFileURL(`${ROOT}/index.js`).href);
  const PROVIDERS = {
    'main-chan': { apiKeyEnv: 'MAIN_KEY', baseURL: 'https://main.example/v1', models: [{ id: 'deepseek-v4.1-flash' }] },
    'backup-chan': { apiKeyEnv: 'BACKUP_KEY', baseURL: 'https://backup.example/v1', models: [{ id: 'deepseek-v4.1-flash' }] },
  };
  const { ctx, handlers } = makeHostCtx(PROVIDERS);
  host.apply(ctx, { enabled: true, failover: true });

  ok(handlers.has('agent/request-error'), '注册了 agent/request-error 监听');
  ok(handlers.has('agent/request'), '注册了 agent/request 监听');

  const onError = handlers.get('agent/request-error');
  const onRequest = handlers.get('agent/request');
  const agent = { id: 'session-1' };

  const firstConfig = await onRequest({ agent, turn: 1, step: 1 }, async () => ({
    provider: 'main-chan', model: 'deepseek-v4.1-flash',
  }));
  eq(firstConfig.provider, 'main-chan', '第一次 request 不替换');

  let delegated = false;
  const action = await onError(
    { agent, turn: 1, step: 1, provider: 'main-chan', failure: { code: 'RATE_LIMIT', message: '429' } },
    async () => { delegated = true; return undefined; },
  );
  eq(action?.kind, 'retry', '429 时返回 retry');
  ok(!delegated, '接管了恢复');

  const replaced = await onRequest({ agent, turn: 1, step: 1 }, async () => ({
    provider: 'main-chan', model: 'deepseek-v4.1-flash',
  }));
  eq(replaced.provider, 'backup-chan', 'request 里换到备用渠道');
  eq(replaced.model, 'deepseek-v4.1-flash', '模型保持同名');

  let delegated2 = false;
  const action2 = await onError(
    { agent, turn: 1, step: 1, provider: 'backup-chan', failure: { code: 'RATE_LIMIT', message: '429' } },
    async () => { delegated2 = true; return undefined; },
  );
  eq(action2, undefined, '没有可用目标时交回默认处理');
  ok(delegated2, '确实调用了 next()');
}

console.log('\n=== Host 接线：极短 Retry-After 就地重试，不换渠道 ===');
{
  const host = await import(pathToFileURL(`${ROOT}/index.js`).href);
  const PROVIDERS = {
    'main-chan': { baseURL: 'https://main.example/v1', models: [{ id: 'm' }] },
    'backup-chan': { baseURL: 'https://backup.example/v1', models: [{ id: 'm' }] },
  };
  const { ctx, handlers } = makeHostCtx(PROVIDERS);
  host.apply(ctx, { enabled: true, failover: true });
  const onError = handlers.get('agent/request-error');
  const onRequest = handlers.get('agent/request');
  const agent = { id: 's-quick' };

  await onRequest({ agent, turn: 1, step: 1 }, async () => ({ provider: 'main-chan', model: 'm' }));
  const action = await onError(
    { agent, turn: 1, step: 1, provider: 'main-chan', failure: { code: 'RATE_LIMIT', providerRetryAfterMs: 800 } },
    async () => undefined,
  );
  eq(action?.kind, 'retry', '极短 Retry-After 也返回 retry');
  const after = await onRequest({ agent, turn: 1, step: 1 }, async () => ({ provider: 'main-chan', model: 'm' }));
  eq(after.provider, 'main-chan', '就地重试不切换渠道');
}

console.log('\n=== Host 接线：不可重试错误不接管 ===');
{
  const host = await import(pathToFileURL(`${ROOT}/index.js`).href);
  const { ctx, handlers } = makeHostCtx({});
  host.apply(ctx, { enabled: true, failover: true });
  const onError = handlers.get('agent/request-error');
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
  const { ctx, handlers } = makeHostCtx({});
  host.apply(ctx, { enabled: true, failover: false });
  ok(!handlers.has('agent/request-error'), 'failover=false 时不监听 request-error');
  ok(!handlers.has('agent/request'), 'failover=false 时不监听 request');
}

console.log(`\n${failures === 0 ? '全部通过' : '有失败'}：${checks - failures}/${checks} 项通过`);
if (failures > 0) process.exitCode = 1;