/**
 * combo 相关测试：识别、跨 provider 兜底、链路审计。
 *
 * 全部基于真实场景：用户的 combo `combo:deepseekv4-1-flash` 前 3 跳是
 * 同一条 OpenCode 免费车道的三个别名，那条车道 throttled 时整链一起挂。
 */
import { pathToFileURL } from 'node:url';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

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

const failover = await import(pathToFileURL(`${ROOT}/lib/failover.js`).href);
const audit = await import(pathToFileURL(`${ROOT}/lib/combo-audit.js`).href);

console.log('\n=== isComboModel / modelFromCombo ===');
{
  ok(failover.isComboModel('combo:deepseekv4-1-flash') === true, '识别 combo: 前缀');
  ok(failover.isComboModel('combo:recommended-free') === true, '识别推荐组合');
  ok(failover.isComboModel('deepseek-v4.1-flash-free') === false, '普通模型不是 combo');
  ok(failover.isComboModel('') === false, '空串不是 combo');
  ok(failover.isComboModel(null) === false, 'null 不是 combo');

  eq(failover.modelFromCombo('combo:deepseekv4-1-flash'), 'deepseek-v4.1-flash', '从 combo 猜出真实模型');
  eq(failover.modelFromCombo('combo:recommended-free'), '', '策略名猜不出模型');
  eq(failover.modelFromCombo('combo:auto'), '', 'auto 猜不出');
  eq(failover.modelFromCombo('deepseek-v4.1-flash'), '', '非 combo 返回空');
  eq(failover.modelFromCombo(''), '', '空串返回空');
}

console.log('\n=== combo 失败时跨 provider 找同款 ===');
{
  const providers = {
    'our-free-model': {
      baseURL: 'https://ofm',
      models: [{ id: 'combo:deepseekv4-1-flash' }, { id: 'deepseek-v4.1-flash-free' }],
    },
    workbuddy: { baseURL: 'https://wb', models: [{ id: 'deepseek-v4.1-flash' }] },
    codearts: { baseURL: 'https://ca', models: [{ id: 'deepseek-v4.1-flash' }] },
    loomy: { baseURL: 'https://lm', models: [{ id: 'DeepSeek-V4.1-Flash' }] },
    raccoon: { baseURL: 'https://rc', models: [{ id: 'sn-deepseek-v4-1-flash' }] },
  };

  const picked = failover.pickFailoverTarget({
    failedProvider: 'our-free-model',
    model: 'combo:deepseekv4-1-flash',
    providers,
    cooling: [],
  });
  ok(picked !== null, 'combo 失败时能找到外部同款', picked);
  ok(picked?.route !== 'our-free-model', '换到了别的 provider', picked);
  ok(String(picked?.reason).startsWith('combo-fallback'), '原因标记为 combo-fallback', picked?.reason);
  ok(/deepseek/i.test(String(picked?.model)), '挑中的是 DeepSeek 同款', picked?.model);

  // 猜不出模型的 combo：不硬凑
  const vague = failover.pickFailoverTarget({
    failedProvider: 'our-free-model',
    model: 'combo:recommended-free',
    providers,
    cooling: [],
  });
  eq(vague, null, '猜不出模型的 combo 不乱挑');

  // 没有外部同款时返回 null
  const lonely = failover.pickFailoverTarget({
    failedProvider: 'our-free-model',
    model: 'combo:deepseekv4-1-flash',
    providers: {
      'our-free-model': { baseURL: 'https://ofm', models: [{ id: 'combo:x' }] },
      other: { baseURL: 'https://o', models: [{ id: 'kimi-k3' }] },
    },
    cooling: [],
  });
  eq(lonely, null, '外部没有同款时返回 null');
}

console.log('\n=== laneKey：判断是不是同一个上游 ===');
{
  eq(audit.laneKey('deepseek-v4.1-flash-free'), audit.laneKey('deepseek-ai/deepseek-v4.1-flash'), '免费车道三个别名归一后相同');
  eq(audit.laneKey('opencode/deepseek-v4.1-flash-free'), audit.laneKey('deepseek-v4.1-flash-free'), 'opencode 前缀被剥掉');
  ok(audit.laneKey('glm-5.3-flash-free') !== audit.laneKey('deepseek-v4.1-flash-free'), '不同模型归一后不同');
}

console.log('\n=== analyzeCombo：真实场景 ===');
{
  // 用户的真实 combo：前 3 跳同一上游
  const combo = {
    id: 'combo:deepseekv4-1-flash',
    name: 'deepseekv4.1 flash 路由',
    strategy: 'fallback',
    models: [
      'deepseek-v4.1-flash-free',
      'deepseek-ai/deepseek-v4.1-flash',
      'opencode/deepseek-v4.1-flash-free',
      'moonshotai/kimi-k3',
    ],
  };
  const availability = {
    at: 1_792_506_056_080,
    results: {
      'deepseek-v4.1-flash-free': { state: 'throttled', detail: 'Rate limit exceeded.' },
    },
  };

  const result = audit.analyzeCombo(combo, availability);
  eq(result.links.length, 4, '4 跳');
  eq(result.laneCount, 2, '只有 2 个不同上游（3 跳重复）');
  eq(result.redundant, true, '标记为有重复跳');
  ok(result.problems.some((p) => p.includes('重复')), '问题里点明重复');
  eq(result.hasSpare, true, '仍有 2 个上游所以算有备胎');

  // 全部同一上游：没有真备胎
  const single = audit.analyzeCombo(
    {
      id: 'combo:only-free',
      name: 'only',
      models: ['deepseek-v4.1-flash-free', 'deepseek-ai/deepseek-v4.1-flash', 'opencode/deepseek-v4.1-flash-free'],
    },
    availability,
  );
  eq(single.laneCount, 1, '全同一上游时 laneCount=1');
  eq(single.hasSpare, false, '标记没有真备胎');
  ok(single.problems.some((p) => p.includes('没有降级')), '问题里点明等于没有降级');

  // 全部明确失败
  const allDead = audit.analyzeCombo(
    {
      id: 'combo:dead',
      name: 'dead',
      models: ['a-free', 'b-free'],
    },
    { at: 1, results: { 'a-free': { state: 'throttled' }, 'b-free': { state: 'unavailable' } } },
  );
  eq(allDead.allDown, true, '全部失败时 allDown=true');
  ok(allDead.problems.some((p) => p.includes('必然失败')), '问题里说必然失败');

  // unknown 不算可用
  const unknownOnly = audit.analyzeCombo(
    { id: 'combo:u', name: 'u', models: ['x-free', 'y-free'] },
    { at: 1, results: {} },
  );
  eq(unknownOnly.healthyCount, 0, 'unknown 不算健康');
  eq(unknownOnly.allDown, true, '全 unknown 视为不可用');
  ok(
    unknownOnly.problems.some((p) => p.includes('未经验证') || p.includes('没有')),
    '问题里说明未经验证',
  );

  // 健康链路
  const healthy = audit.analyzeCombo(
    { id: 'combo:h', name: 'h', models: ['a-free', 'b-free'] },
    { at: 1, results: { 'a-free': { state: 'available' }, 'b-free': { state: 'available' } } },
  );
  eq(healthy.healthyCount, 2, '两跳都健康');
  eq(healthy.allDown, false, '不算全挂');
  eq(healthy.problems.length, 0, '健康链路没有 problem');
}

console.log('\n=== analyzeAllCombos：读真实文件 ===');
{
  const home = mkdtempSync(path.join(tmpdir(), 'fd-combo-'));
  const dir = path.join(home, 'our-free-model');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'settings.json'),
    JSON.stringify({
      combos: [
        {
          id: 'combo:test',
          name: '测试链',
          strategy: 'fallback',
          enabled: true,
          models: ['deepseek-v4.1-flash-free', 'deepseek-ai/deepseek-v4.1-flash'],
        },
      ],
    }),
    'utf8',
  );
  writeFileSync(
    path.join(dir, 'availability.json'),
    JSON.stringify({ at: 1_700_000_000_000, results: { 'deepseek-v4.1-flash-free': { state: 'throttled' } } }),
    'utf8',
  );

  const result = audit.analyzeAllCombos(home);
  eq(result.ok, true, '读取成功');
  eq(result.combos.length, 1, '读到 1 个 combo');
  eq(result.combos[0].laneCount, 1, '两条同上游');
  eq(result.combos[0].hasSpare, false, '没有真备胎');

  const text = audit.describeCombos(result);
  ok(text.includes('测试链'), '描述里有名字', text.slice(0, 100));
  ok(text.includes('没有真正的备胎'), '描述里点明没有备胎');

  // 没有 settings：安静失败
  const emptyHome = mkdtempSync(path.join(tmpdir(), 'fd-combo-empty-'));
  const missing = audit.analyzeAllCombos(emptyHome);
  eq(missing.ok, false, '没有配置时 ok=false');
  ok(String(missing.error).length > 0, '带错误原因');
  ok(audit.describeCombos(missing).includes('读不到'), '描述给出可读说明');

  // home 为空
  eq(audit.analyzeAllCombos('').ok, false, 'home 为空时 ok=false');
  eq(audit.analyzeAllCombos(undefined).ok, false, 'home undefined 时 ok=false');

  rmSync(home, { recursive: true, force: true });
  rmSync(emptyHome, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? '全部通过' : '有失败'}：${checks - failures}/${checks} 项通过`);
if (failures > 0) process.exitCode = 1;