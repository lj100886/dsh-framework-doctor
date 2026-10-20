/**
 * 读别的渠道插件已经缓存在本地磁盘的状态。
 *
 * 为什么读磁盘而不是问 API：channel 插件的 HTTP 接口走 harness 的
 * connection 信任围栏，认浏览器会话 cookie，Host 端裸请求一律 401
 * （实测 /summary /pool /eac/status 都是）。但它们把**可用性和失败原因**
 * 落在了自己的数据目录里，Host 直接读文件即可，不需要任何鉴权。
 *
 * 这些数据比我们自己观察到的错误码精确得多——比如
 * "This model is not available in your country" 或
 * "free models aren't available from your current network because
 *  we've detected abusive traffic from this IP address"，
 * 那是端点自己给出的判定，比一个 429 有用得多。
 *
 * 只读、只解析、不改。读不到就当没有（插件没装/换了版本很正常）。
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

/** 已知的渠道插件本地缓存布局。新插件加在这里。 */
const LOCAL_SOURCES = [
  {
    id: 'our-free-model',
    label: 'Our Free Model',
    dirName: 'our-free-model',
    files: {
      availability: 'availability.json',
      catalog: 'catalog.json',
      settings: 'settings.json',
    },
  },
];

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 把一个渠道插件的本地缓存读成统一结构。
 *
 * @param {{dirName: string, files: Record<string,string>, id: string, label: string}} source
 * @param {string} home  DSH home（数据目录的父目录）
 * @returns {object|null}
 */
export function readLocalChannelState(source, home) {
  if (typeof home !== 'string' || home.length === 0) return null;
  const dir = path.join(home, source.dirName);
  const availability = readJson(path.join(dir, source.files.availability || 'availability.json'));
  const catalog = readJson(path.join(dir, source.files.catalog || 'catalog.json'));

  // 两个文件都没有：这个插件没装，或者版本不同、布局变了。
  if (!availability && !catalog) return null;

  const models = [];
  const results = availability && typeof availability.results === 'object' ? availability.results : {};
  for (const [modelId, row] of Object.entries(results)) {
    if (!row || typeof row !== 'object') continue;
    models.push({
      id: modelId,
      state: typeof row.state === 'string' ? row.state : 'unknown',
      detail: typeof row.detail === 'string' ? row.detail : '',
      latencyMs: typeof row.latencyMs === 'number' ? row.latencyMs : null,
      checkedAt: typeof row.at === 'number' ? row.at : null,
    });
  }

  const listed = Array.isArray(catalog?.entries)
    ? catalog.entries.filter((id) => typeof id === 'string')
    : [];
  const kiloRows = Array.isArray(catalog?.kiloRows) ? catalog.kiloRows : [];

  const egress = availability && typeof availability.egress === 'object'
    ? {
        ip: typeof availability.egress.ip === 'string' ? availability.egress.ip : '',
        country: typeof availability.egress.country === 'string' ? availability.egress.country : '',
      }
    : null;

  return {
    provider: source.id,
    label: source.label,
    checkedAt: typeof availability?.at === 'number' ? availability.at : null,
    egress,
    models,
    // 目录里列出的模型（不等于可用）。
    listed,
    kiloCount: kiloRows.length,
  };
}

/**
 * 读所有已知渠道插件的本地状态。
 *
 * @param {string} home
 * @returns {object[]} 只返回真的读到了的
 */
export function readAllLocalChannelStates(home) {
  const out = [];
  for (const source of LOCAL_SOURCES) {
    const state = readLocalChannelState(source, home);
    if (state) out.push(state);
  }
  return out;
}

/** 从可用性记录里挑出「明确不可用」的，按原因归类。 */
export function classifyUnavailable(state) {
  const blocked = [];
  const abuse = [];
  const regional = [];
  const other = [];

  for (const row of state?.models ?? []) {
    const detail = String(row.detail || '').toLowerCase();
    if (row.state === 'available' || row.state === 'ok') continue;
    if (detail.includes('abusive traffic') || detail.includes('abuse')) abuse.push(row);
    else if (detail.includes('not available in your country') || detail.includes('region')) regional.push(row);
    else if (row.state === 'region-blocked') regional.push(row);
    else if (row.state === 'unavailable') other.push(row);
    else blocked.push(row);
  }

  return { abuse, regional, other, blocked };
}

/**
 * 把这些本地状态压成给对话助手读的纯文本。
 *
 * @param {object[]} states
 * @returns {string}
 */
export function describeLocalStates(states) {
  if (!Array.isArray(states) || states.length === 0) {
    return '没有找到任何渠道插件的本地状态缓存（可能没装，或版本布局不同）。';
  }
  const lines = [];
  for (const state of states) {
    const when = state.checkedAt ? new Date(state.checkedAt).toISOString() : '时间未知';
    lines.push(`${state.label}（检查于 ${when}）`);
    if (state.egress?.ip) {
      lines.push(`  出口：${state.egress.ip}${state.egress.country ? `（${state.egress.country}）` : ''}`);
    }
    const groups = classifyUnavailable(state);
    if (groups.abuse.length > 0) {
      lines.push(`  ⚠ 被判定滥用流量、拒绝服务（${groups.abuse.length} 个模型，换模型没用，要换出口 IP）：`);
      for (const row of groups.abuse.slice(0, 6)) lines.push(`    · ${row.id}：${row.detail}`);
    }
    if (groups.regional.length > 0) {
      lines.push(`  ⚠ 区域不可用（${groups.regional.length} 个模型，当前网络所在地区被限制）：`);
      for (const row of groups.regional.slice(0, 6)) lines.push(`    · ${row.id}：${row.detail}`);
    }
    if (groups.other.length > 0) {
      lines.push(`  · 其它不可用（${groups.other.length} 个）：`);
      for (const row of groups.other.slice(0, 6)) {
        lines.push(`    · ${row.id}：${row.detail || row.state}`);
      }
    }
    const okCount = (state.models ?? []).filter((row) => row.state === 'available' || row.state === 'ok').length;
    if (okCount > 0) lines.push(`  ✓ 可用：${okCount} 个模型`);
  }
  return lines.join('\n');
}

export { LOCAL_SOURCES };