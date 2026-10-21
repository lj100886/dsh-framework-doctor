/**
 * 检查 Our Free Model 的 combo 链是否真有备胎。
 *
 * 用户的 combo 前 3 跳是同一个上游（免费车道的三个别名），
 * 那条车道限流时整条链一起挂。这个模块负责把这件事**算出来并说清楚**，
 * 而不是等用户自己发现。
 *
 * 只读：读它的 settings.json（combo 定义）和 availability.json（每跳真实状态）。
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * 判断两个 catalog id 是否指向同一个上游车道。
 *
 * Our Free Model 的 catalog 里同一个模型可能有多个别名：
 *   deepseek-v4.1-flash-free              （免费车道的直名）
 *   deepseek-ai/deepseek-v4.1-flash       （seal 名）
 *   opencode/deepseek-v4.1-flash-free     （网关名）
 * 这三个打的是同一个上游，所以对"有没有备胎"这件事来说它们是同一跳。
 *
 * 判据：去掉 vendor 前缀和 -free 后缀后相等 → 同一车道。
 */
export function laneKey(id) {
  return String(id || '')
    .toLowerCase()
    .trim()
    .replace(/^[a-z0-9][a-z0-9._-]*\//, '')
    .replace(/[-_:](free|beta|preview|latest)$/g, '')
    .replace(/[_.:]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * 分析一条 combo 链。
 *
 * @param {object} combo  { name, id, models: string[], strategy, enabled }
 * @param {object} availability  availability.json 内容（可空）
 * @returns {{
 *   id: string, name: string, strategy: string,
 *   links: Array<{model: string, lane: string, state: string, detail: string}>,
 *   laneCount: number, distinctModels: number,
 *   redundant: boolean, hasSpare: boolean, allDown: boolean,
 *   problems: string[]
 * }}
 */
export function analyzeCombo(combo, availability) {
  const models = Array.isArray(combo?.models) ? combo.models.filter((m) => typeof m === 'string') : [];
  const results = availability && typeof availability.results === 'object' ? availability.results : {};

  const links = models.map((model) => {
    const row = results[model] && typeof results[model] === 'object' ? results[model] : null;
    return {
      model,
      lane: laneKey(model),
      state: typeof row?.state === 'string' ? row.state : 'unknown',
      detail: typeof row?.detail === 'string' ? row.detail : '',
    };
  });

  const lanes = new Set(links.map((l) => l.lane));
  const models2 = new Set(links.map((l) => l.lane));
  const problems = [];

  // 同一个车道出现多次 = 那一跳是重复的，没有提供任何额外冗余
  if (lanes.size < links.length) {
    const dupes = [];
    const seen = new Map();
    for (const link of links) {
      if (seen.has(link.lane)) dupes.push(link.model);
      else seen.set(link.lane, link.model);
    }
    problems.push(
      `${links.length} 跳里只有 ${lanes.size} 个不同的上游：` +
        `${dupes.length} 跳是重复的（${dupes.slice(0, 3).join('、')}），限流时它们会一起挂`,
    );
  }

  // 全部不可用 = 这条链现在答不出来。
  //
  // `unknown` 要当成**可疑**而不是可用：availability.json 只记录探测过的条目，
  // 没有记录说明这一跳从来没被独立验证过——它可能只是另一个 id 的别名，
  // 也可能根本没通。把它算成"可用"会让报告说"还有 5 跳可用"，而实际上一跳
  // 都没验证过，这正是用户被误导的地方。
  const healthyStates = new Set(['available', 'ok']);
  const downStates = new Set(['throttled', 'unavailable', 'region-blocked', 'error', 'failed']);

  const down = links.filter((l) => downStates.has(l.state));
  const unknown = links.filter((l) => l.state === 'unknown');
  const healthy = links.filter((l) => healthyStates.has(l.state));

  if (links.length > 0 && healthy.length === 0) {
    if (down.length === links.length) {
      problems.push(`链上 ${links.length} 跳全部不可用，这条 combo 现在必然失败`);
    } else {
      problems.push(
        `链上没有任何一跳被验证过可用（${down.length} 跳明确失败、${unknown.length} 跳未探测），` +
          '这条 combo 的可用性是未经验证的',
      );
    }
  } else if (down.length > 0) {
    problems.push(`${down.length} 跳明确失败，${healthy.length} 跳可用`);
  }

  // 只有一个上游 = 没有真备胎
  const hasSpare = lanes.size >= 2;
  if (!hasSpare && links.length > 1) {
    problems.push('所有跳打的是同一个上游，等于没有降级');
  }

  return {
    id: typeof combo?.id === 'string' ? combo.id : '',
    name: typeof combo?.name === 'string' ? combo.name : '',
    strategy: typeof combo?.strategy === 'string' ? combo.strategy : 'fallback',
    links,
    laneCount: lanes.size,
    distinctModels: models2.size,
    redundant: lanes.size < links.length,
    hasSpare,
    allDown: links.length > 0 && healthy.length === 0,
    healthyCount: healthy.length,
    unknownCount: unknown.length,
    downCount: down.length,
    problems,
  };
}

/**
 * 读 Our Free Model 的 combo 定义与可用性，逐条分析。
 *
 * @param {string} home  DSH home
 * @returns {{ok: boolean, combos: object[], checkedAt: number|null, error?: string}}
 */
export function analyzeAllCombos(home) {
  if (typeof home !== 'string' || home.length === 0) {
    return { ok: false, combos: [], checkedAt: null, error: '没有 DSH home' };
  }
  const dir = path.join(home, 'our-free-model');
  const readJson = (name) => {
    try {
      return JSON.parse(readFileSync(path.join(dir, name), 'utf8'));
    } catch {
      return null;
    }
  };

  const settings = readJson('settings.json');
  if (!settings) return { ok: false, combos: [], checkedAt: null, error: '读不到 settings.json' };

  const availability = readJson('availability.json');
  const raw = Array.isArray(settings.combos) ? settings.combos : [];
  const combos = raw
    .filter((c) => c && typeof c === 'object')
    .map((c) => analyzeCombo(c, availability));

  return {
    ok: true,
    combos,
    checkedAt: typeof availability?.at === 'number' ? availability.at : null,
  };
}

/**
 * 压成给助手读的纯文本。
 *
 * @param {ReturnType<typeof analyzeAllCombos>} result
 * @returns {string}
 */
export function describeCombos(result) {
  if (!result?.ok) return `读不到 combo 配置：${result?.error || '未知原因'}`;
  if (!Array.isArray(result.combos) || result.combos.length === 0) {
    return 'Our Free Model 里没有配置任何 combo。';
  }
  const when = result.checkedAt ? new Date(result.checkedAt).toISOString() : '时间未知';
  const lines = [`Our Free Model 的 combo（可用性检查于 ${when}）：`];
  for (const combo of result.combos) {
    lines.push('');
    lines.push(`【${combo.name}】${combo.id}（策略 ${combo.strategy}）`);
    lines.push(`  ${combo.links.length} 跳，${combo.laneCount} 个不同上游`);
    for (const link of combo.links) {
      const mark = link.state === 'available' || link.state === 'ok' ? '✓' : '✗';
      lines.push(`  ${mark} ${link.model}  [${link.state}]${link.detail ? ` ${link.detail.slice(0, 70)}` : ''}`);
    }
    for (const problem of combo.problems) lines.push(`  ⚠ ${problem}`);
    if (combo.hasSpare) lines.push('  → 有真正的备胎');
    else lines.push('  → 没有真正的备胎，这个 combo 等于单点');
  }
  return lines.join('\n');
}
