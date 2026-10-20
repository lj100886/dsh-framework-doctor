/**
 * 真实世界错误码与模型名的回归测试。
 *
 * 这些用例**全部来自真实会话日志**（统计 47 个会话得出的 code 分布与失败消息），
 * 不是编出来的。上一版漏掉 QUOTA_EXCEEDED / EAC_UPSTREAM_FAILED / LANE_LOCKED，
 * 以及认不出 `-free` 后缀的同名模型，导致用户看到"框架医生没介入"。
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
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail).slice(0, 400)}`}`);
  }
}
function eq(a, b, label) {
  ok(Object.is(a, b), label, { actual: a, expected: b });
}

const mod = await import(pathToFileURL(`${ROOT}/lib/failover.js`).href);

console.log('\n=== 真实错误码（来自会话日志统计）===');
{
  // 这些 code 与次数都来自真实会话：TRANSPORT 77、TIMEOUT 52、SERVER 20、
  // QUOTA_EXCEEDED 18、EAC_UPSTREAM_FAILED 13、LANE_LOCKED 5、RATE_LIMIT 2
  const realCodes = [
    ['TRANSPORT', 77],
    ['TIMEOUT', 52],
    ['SERVER', 20],
    ['QUOTA_EXCEEDED', 18],
    ['EAC_UPSTREAM_FAILED', 13],
    ['LANE_LOCKED', 5],
    ['RATE_LIMIT', 2],
  ];
  for (const [code, count] of realCodes) {
    ok(mod.shouldFailover({ code }) === true, `接管真实错误码 ${code}（出现 ${count} 次）`);
  }
}

console.log('\n=== 真实失败消息的语义兜底 ===');
{
  // 消息原文摘自会话日志
  const realMessages = [
    '429: {"message":"inference exceeds tpm/rpm limit","type":"rate_limit_error"}',
    '429: {"message":"rpm exhausted","type":"quota_exceeded_error","code":"8"}',
    'WorkBuddy (国际版)：模型 deepseek-v4.1-flash 的可用账号均在限流中，最近一个将于 2026/10/19 20:08:58 解禁。',
    'zcode: 账号在模型 "GLM-5.3-Flash" 上的额度已用尽或没有可用权益',
    "OpenCode's free models aren't available from your current network because we've detected abusive traffic from this IP address.",
    'workbuddy: 服务出错了，请稍后重试 invoke model error',
    'Request timed out.',
    'Connection error.',
    'pi-ai stream idle timeout after 300000ms',
  ];
  for (const message of realMessages) {
    // 故意用一个不认识的 code，验证纯靠消息也能认出来
    ok(
      mod.shouldFailover({ code: 'SOME_NEW_CODE_XYZ', message }) === true,
      `靠消息认出：${message.slice(0, 50)}…`,
    );
  }
}

console.log('\n=== 不该接管的（换渠道也没用）===');
{
  const no = [
    [{ code: 'INVALID_REQUEST', message: 'inference request is invalid' }, '参数错'],
    [{ code: 'INVALID_CREDENTIAL' }, '密钥错'],
    [{ code: 'MISSING_CREDENTIAL' }, '缺凭据'],
    [{ code: 'AUTHORIZATION_REQUIRED' }, '需授权'],
    [{ code: 'UNKNOWN_MODEL' }, '模型不存在'],
    [{ code: 'NO_ADAPTER' }, '没有适配器'],
    [{ code: 'SOMETHING_ELSE', message: 'totally unrelated failure' }, '无关错误'],
    [null, 'null'],
  ];
  for (const [failure, label] of no) {
    ok(mod.shouldFailover(failure) === false, `不接管：${label}`);
  }
}

console.log('\n=== 同模型跨渠道匹配（真实渠道命名差异）===');
{
  const providers = {
    'our-free-model': {
      baseURL: 'https://ofm',
      models: [
        { id: 'deepseek-v4.1-flash-free' },
        { id: 'glm-5.3-flash-free' },
        { id: 'minimax-m3.1-flash-free' },
        { id: 'big-pickle' },
      ],
    },
    workbuddy: {
      baseURL: 'https://wb',
      models: [{ id: 'deepseek-v4.1-flash' }, { id: 'GLM-5.3' }, { id: 'minimax-m3.1-flash' }],
    },
    zcode: { baseURL: 'https://zc', models: [{ id: 'GLM-5.3-Flash' }, { id: 'GLM-5.3' }] },
    openrouter: {
      baseURL: 'https://or',
      models: [{ id: 'deepseek/deepseek-v4.1-flash' }, { id: 'nvidia/nemotron-3.5-super-vl:free' }],
    },
  };

  const cases = [
    ['our-free-model', 'deepseek-v4.1-flash-free', '带 -free 后缀能匹配到不带后缀的同名模型'],
    ['our-free-model', 'glm-5.3-flash-free', '大小写+连字符差异能匹配'],
    ['our-free-model', 'minimax-m3.1-flash-free', '多段版本号能匹配'],
    ['workbuddy', 'deepseek-v4.1-flash', '反向也能匹配'],
    ['openrouter', 'deepseek/deepseek-v4.1-flash', 'vendor 前缀能剥离'],
  ];
  for (const [failed, model, label] of cases) {
    const picked = mod.pickFailoverTarget({ failedProvider: failed, model, providers, cooling: [] });
    ok(picked !== null, label, { failed, model, picked });
    ok(picked?.route !== failed, `${label}（换到了别的渠道）`);
  }

  // 独此一家的模型：正确返回 null，而不是硬凑一个
  const lonely = mod.pickFailoverTarget({
    failedProvider: 'our-free-model',
    model: 'big-pickle',
    providers,
    cooling: [],
  });
  eq(lonely, null, '没有同规格备胎时返回 null，不硬凑');

  // 不同规格不能互相顶替（GLM-5.3 ≠ GLM-5.3-Flash）
  const spec = mod.pickFailoverTarget({
    failedProvider: 'workbuddy',
    model: 'GLM-5.3',
    providers,
    cooling: [],
  });
  ok(
    spec === null || !/flash/i.test(spec.model),
    'GLM-5.3 不会被降级顶替成 GLM-5.3-Flash',
    spec,
  );
}

console.log('\n=== 新增错误码的冷却档位合理 ===');
{
  const quota = mod.describeFailure({ code: 'QUOTA_EXCEEDED' });
  eq(quota.severity, 'critical', 'QUOTA_EXCEEDED 是 critical');
  eq(quota.billing, true, 'QUOTA_EXCEEDED 标记额度问题');
  ok(quota.cooldownMs >= 30 * 60_000, 'QUOTA_EXCEEDED 冷却够久', quota.cooldownMs);

  const eac = mod.describeFailure({ code: 'EAC_UPSTREAM_FAILED' });
  eq(eac.scope, 'channel', 'EAC_UPSTREAM_FAILED 是渠道问题');
  ok(eac.cooldownMs <= 2 * 60_000, 'EAC 冷却不算久', eac.cooldownMs);

  const lane = mod.describeFailure({ code: 'LANE_LOCKED' });
  eq(lane.severity, 'high', 'LANE_LOCKED 是 high');
  eq(lane.billing, true, 'LANE_LOCKED 值得提示用户');

  // 三个都比网络错误久，但都短于额度
  const net = mod.describeFailure({ code: 'TRANSPORT' });
  ok(eac.cooldownMs > net.cooldownMs, 'EAC 比网络错误晾得久');
  ok(quota.cooldownMs > lane.cooldownMs, '额度比车道锁晾得久');
}

console.log(`\n${failures === 0 ? '全部通过' : '有失败'}：${checks - failures}/${checks} 项通过`);
if (failures > 0) process.exitCode = 1;