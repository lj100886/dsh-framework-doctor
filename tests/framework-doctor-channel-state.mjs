/**
 * 渠道状态读取的测试：本地磁盘缓存（Host 侧） + 账单端点（浏览器侧）。
 *
 * 两个数据源性质完全不同：
 *   - 本地缓存：Host 直接读文件，无需鉴权，但要求插件把状态落盘；
 *   - 账单端点：只能浏览器取（connection 围栏认会话 cookie），Host 一律 401。
 * 所以两边都要"读不到就安静降级"，不能因为别家插件不在就报错。
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
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail).slice(0, 500)}`}`);
  }
}
function eq(a, b, label) {
  ok(Object.is(a, b), label, { actual: a, expected: b });
}

const local = await import(pathToFileURL(`${ROOT}/lib/local-channel-state.js`).href);
const billing = await import(pathToFileURL(`${ROOT}/lib/billing-client.js`).href);

/* ------------------------------------------------------------------ *
 * 本地缓存（Host 侧）
 * ------------------------------------------------------------------ */
console.log('\n=== 本地缓存：读取与分类 ===');
{
  const home = mkdtempSync(path.join(tmpdir(), 'fd-cache-'));
  const dir = path.join(home, 'our-free-model');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'availability.json'),
    JSON.stringify({
      version: 1,
      at: 1_792_506_056_080,
      egress: { ip: '203.0.113.7', country: 'CN' },
      results: {
        'model-abuse': {
          state: 'unavailable',
          detail: "free models aren't available because we've detected abusive traffic from this IP address",
          latencyMs: 743,
          at: 1_792_506_050_439,
        },
        'model-region': {
          state: 'region-blocked',
          detail: 'This model is not available in your country',
          latencyMs: 4310,
          at: 1_792_506_054_006,
        },
        'model-ok': { state: 'available', latencyMs: 200 },
        'model-dead': { state: 'unavailable', detail: 'gateway returned 502' },
      },
    }),
    'utf8',
  );
  writeFileSync(
    path.join(dir, 'catalog.json'),
    JSON.stringify({
      version: 1,
      entries: ['model-abuse', 'model-region', 'model-ok', 'model-dead'],
      kiloRows: [{ id: 'kilo-auto/free' }, { id: 'kilo-x' }],
    }),
    'utf8',
  );

  const states = local.readAllLocalChannelStates(home);
  eq(states.length, 1, '读到一个渠道插件');
  const state = states[0];
  eq(state.provider, 'our-free-model', 'provider 正确');
  eq(state.egress?.ip, '203.0.113.7', '读到出口 IP');
  eq(state.egress?.country, 'CN', '读到出口国家');
  eq(state.models.length, 4, '读到 4 条模型状态');
  eq(state.kiloCount, 2, '读到 kilo 行数');

  const groups = local.classifyUnavailable(state);
  eq(groups.abuse.length, 1, '识别出滥用流量');
  eq(groups.abuse[0].id, 'model-abuse', '滥用的是 model-abuse');
  eq(groups.regional.length, 1, '识别出区域封锁');
  eq(groups.regional[0].id, 'model-region', '区域封锁的是 model-region');
  eq(groups.other.length, 1, '识别出其它不可用');
  eq(groups.other[0].id, 'model-dead', '其它不可用的是 model-dead');

  const text = local.describeLocalStates(states);
  ok(text.includes('滥用流量'), '描述里点明了滥用流量', text.slice(0, 120));
  ok(text.includes('203.0.113.7'), '描述里带出口 IP');
  ok(text.includes('model-region'), '描述里列出受影响的模型');

  // 目录不存在：安静返回空
  const emptyHome = mkdtempSync(path.join(tmpdir(), 'fd-empty-'));
  eq(local.readAllLocalChannelStates(emptyHome).length, 0, '没有缓存时返回空数组');
  eq(local.readAllLocalChannelStates('').length, 0, 'home 为空时返回空数组');
  eq(local.readAllLocalChannelStates(undefined).length, 0, 'home 为 undefined 时返回空数组');
  ok(local.describeLocalStates([]).includes('没有找到'), '空状态给一句可读说明');

  // 坏 JSON：不抛
  writeFileSync(path.join(dir, 'availability.json'), '{not json', 'utf8');
  const broken = local.readAllLocalChannelStates(home);
  eq(broken.length, 1, 'availability 坏了但 catalog 还在时仍返回');

  rmSync(home, { recursive: true, force: true });
  rmSync(emptyHome, { recursive: true, force: true });
}

/* ------------------------------------------------------------------ *
 * 账单端点（浏览器侧）
 * ------------------------------------------------------------------ */
console.log('\n=== 账单：normalizeAccounts 兼容多种返回形状 ===');
{
  const fromAccounts = billing.normalizeAccounts({
    accounts: [
      { label: 'CodeArts', credits: 120, status: 'ok' },
      { name: 'LobsterAI', balance: 3.5, state: 'ok' },
    ],
  });
  eq(fromAccounts.length, 2, '{accounts:[]} 解析出 2 条');
  eq(fromAccounts[0].name, 'CodeArts', 'label 作为名字');
  eq(fromAccounts[0].credits, 120, '读到积分');
  eq(fromAccounts[1].dollars, 3.5, '读到余额');

  const fromLanes = billing.normalizeAccounts({ lanes: [{ login: 'a', credits: 1 }] });
  eq(fromLanes.length, 1, '{lanes:[]} 也能解析');

  const bare = billing.normalizeAccounts([{ id: 'x', credits: 0 }]);
  eq(bare.length, 1, '裸数组也能解析');

  eq(billing.normalizeAccounts(null).length, 0, 'null 返回空');
  eq(billing.normalizeAccounts({ foo: 1 }).length, 0, '不认识的结构返回空');

  // 字符串数字也要能读
  const strings = billing.normalizeAccounts({ accounts: [{ name: 's', credits: '42' }] });
  eq(strings[0].credits, 42, '字符串数字被转成数字');
}

console.log('\n=== 账单：summarizeBilling ===');
{
  const summary = billing.summarizeBilling({
    label: 'Our Free Model',
    settingsSection: 'our-free-model',
    accounts: [
      { name: 'a', credits: 100, dollars: null },
      { name: 'b', credits: 50, dollars: null },
      { name: 'c', credits: 0, dollars: null },
    ],
  });
  eq(summary.hasData, true, '有数据');
  eq(summary.accounts, 3, '3 个账号');
  eq(summary.totalCredits, 150, '积分合计 150');
  eq(summary.lowCount, 1, '识别出 1 个耗尽');
  eq(summary.totalDollars, null, '没有余额字段时是 null 而不是 0');

  const empty = billing.summarizeBilling({ accounts: [], error: '未登录' });
  eq(empty.hasData, false, '空账号 hasData=false');
  eq(empty.error, '未登录', '错误原因透传');

  const dollars = billing.summarizeBilling({
    accounts: [{ name: 'a', dollars: 1.25 }, { name: 'b', dollars: 2.5 }],
  });
  eq(dollars.totalDollars, 3.75, '余额合计');
}

console.log('\n=== 账单：readBilling 的降级行为 ===');
{
  // 没有 fetch：应该返回 ok:false 而不是抛
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = undefined;
    const result = await billing.readBilling(billing.BILLING_PROVIDERS[0], { timeout: 1000 });
    eq(result.ok, false, 'fetch 不存在时 ok:false');
    ok(typeof result.error === 'string', '带可读错误');
    ok(Array.isArray(result.accounts), 'accounts 仍是数组');

    // 401：说明没登录那个插件，不是我们的错
    globalThis.fetch = async () => ({ ok: false, status: 401 });
    const denied = await billing.readBilling(billing.BILLING_PROVIDERS[0], { timeout: 1000 });
    eq(denied.ok, false, '401 时 ok:false');
    ok(String(denied.error).includes('未登录'), '401 提示未登录', denied.error);

    // 404：插件没装
    globalThis.fetch = async () => ({ ok: false, status: 404 });
    const missing = await billing.readBilling(billing.BILLING_PROVIDERS[0], { timeout: 1000 });
    ok(String(missing.error).includes('未安装'), '404 提示未安装', missing.error);

    // 正常：返回账号
    globalThis.fetch = async (url) => {
      if (String(url).includes('/pool')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ accounts: [{ label: 'CodeArts', credits: 9 }] }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ available: true }) };
    };
    const good = await billing.readBilling(billing.BILLING_PROVIDERS[0], { timeout: 1000 });
    eq(good.ok, true, '正常时 ok:true');
    eq(good.accounts.length, 1, '读到 1 个账号');
    eq(good.accounts[0].credits, 9, '读到积分');
    ok(good.eac !== null, 'EAC 状态也读到了');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

console.log(`\n${failures === 0 ? '全部通过' : '有失败'}：${checks - failures}/${checks} 项通过`);
if (failures > 0) process.exitCode = 1;