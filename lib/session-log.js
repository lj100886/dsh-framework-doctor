/**
 * 读会话日志，回答"那个会话为什么失败"。
 *
 * 这是把前几轮我手动做的事做成工具：解压会话文件、找失败事件、还原失败链、
 * 对照错误码给出判断。
 *
 * 关键事实（踩过坑才确定）：
 *
 * 1. 会话文件是 `session.v4.jsonl.zstd`，**多帧 zstd**，每帧一条 JSONL。
 *    `zlib.zstdDecompressSync` 只解第一帧，所以必须先按 magic 切帧再逐帧解，
 *    否则永远只能拿到第一行（我就被这个坑过一轮）。
 *
 * 2. 失败信息藏在 `assistant/attempt` 的 `data.stream[].chunk.reason.failure`
 *    里，不在顶层。payload 里通常没有 model 字段——模型要看同会话前面的
 *    `model/selection` 事件。
 *
 * 3. 一个会话里失败可能有几十上百次，直接全列出来没用。要的是：
 *    最后用的是哪个模型、它失败了几次、错误码分布、最后一次的具体报错。
 *
 * 只读。不修改任何会话文件。
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

/** zstd 帧起始魔数。 */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** 只解压到这么多字节，防止某个巨大会话把内存吃满。 */
const MAX_DECOMPRESSED_BYTES = 64 * 1024 * 1024;

/**
 * 把一个多帧 zstd 文件按帧切开。
 *
 * @param {Buffer} buf
 * @returns {Buffer[]}
 */
export function splitZstdFrames(buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) return [];
  const starts = [];
  let from = 0;
  while (from < buf.length) {
    const at = buf.indexOf(ZSTD_MAGIC, from);
    if (at < 0) break;
    starts.push(at);
    from = at + ZSTD_MAGIC.length;
  }
  const frames = [];
  for (let i = 0; i < starts.length; i += 1) {
    const end = i + 1 < starts.length ? starts[i + 1] : buf.length;
    frames.push(buf.subarray(starts[i], end));
  }
  return frames;
}

/**
 * 逐帧解压，返回每一帧解出来的文本行。
 *
 * 两个必须注意的点：
 *
 * 1. 会话文件是**多帧** zstd，`zstdDecompressSync` 只解第一帧，所以按 magic
 *    切帧再逐帧解。
 * 2. 一帧**不一定等于一整行**——长事件可能被拆到多帧，一帧也可能含多行。
 *    所以不能把每帧当成一行去 parse；要全部拼起来再按 `\n` 切。
 *    早期版本把帧当行，导致大量事件解析失败、失败记录全丢（"模型调用 0 次"
 *    但明明有重试就是这么来的）。
 *
 * 坏帧跳过（会话正在写入时最后一帧可能不完整，这是正常情况）。
 *
 * @param {string} file
 * @returns {{text: string, lines: string[], frames: number, badFrames: number, bytes: number, error?: string}}
 */
export function readSessionLines(file) {
  let raw;
  try {
    raw = readFileSync(file);
  } catch (error) {
    return { text: '', lines: [], frames: 0, badFrames: 0, bytes: 0, error: String(error?.message ?? error) };
  }
  const frames = splitZstdFrames(raw);
  const chunks = [];
  let badFrames = 0;
  let total = 0;
  for (const frame of frames) {
    try {
      const text = zlib.zstdDecompressSync(frame).toString('utf8');
      total += text.length;
      if (total > MAX_DECOMPRESSED_BYTES) break;
      chunks.push(text);
    } catch {
      badFrames += 1;
    }
  }
  // 拼接后再切行：帧边界和行边界无关。
  const text = chunks.join('');
  const lines = text.split('\n').filter((line) => line.trim().length > 0);
  return { text, lines, frames: frames.length, badFrames, bytes: raw.length };
}

/**
 * 列出所有会话，最近的在前。
 *
 * @param {string} home  DSH home
 * @returns {Array<{id: string, dir: string, file: string, mtime: number, size: number, project: string}>}
 */
export function listSessions(home) {
  const root = path.join(home, 'sessions');
  const out = [];
  if (!existsSync(root)) return out;

  (function walk(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name === 'session.v4.jsonl.zstd') {
        try {
          const stat = statSync(full);
          out.push({
            id: path.basename(path.dirname(full)),
            dir: path.dirname(full),
            file: full,
            mtime: stat.mtimeMs,
            size: stat.size,
            project: path.basename(path.dirname(path.dirname(full))),
          });
        } catch {
          /* ignore */
        }
      }
    }
  })(root);

  return out.sort((a, b) => b.mtime - a.mtime);
}

/**
 * 从事件流里还原一次会话的模型使用与失败情况。
 *
 * @param {object[]} events
 * @returns {{
 *   selections: Array<{provider: string, model: string, at: number}>,
 *   attempts: number,
 *   failures: Array<{code: string, message: string, status?: number, at: number}>,
 *   byCode: Array<{code: string, count: number}>,
 *   lastModel: {provider: string, model: string} | null,
 *   lastFailure: object | null,
 *   turns: number,
 *   retries: number,
 *   title: string,
 * }}
 */
export function analyzeSessionEvents(events) {
  const list = Array.isArray(events) ? events : [];
  const selections = [];
  const failures = [];
  const codeCounts = new Map();
  let attempts = 0;
  let retries = 0;
  let title = '';
  const turns = new Set();

  for (const event of list) {
    if (!event || typeof event !== 'object') continue;
    const type = event.type ?? event.kind;

    if (type === 'model/selection' && event.data?.provider) {
      selections.push({
        provider: String(event.data.provider),
        model: String(event.data.model ?? ''),
        at: Number(event.time ?? 0),
      });
      continue;
    }

    if (type === 'session/title' && typeof event.data?.title === 'string') {
      title = event.data.title;
      continue;
    }

    if (type === 'llm/retry-started') {
      retries += 1;
      continue;
    }

    if (type === 'step/start') {
      if (typeof event.data?.turn === 'number') turns.add(event.data.turn);
      continue;
    }

    if (type === 'assistant/attempt') {
      attempts += 1;
      const stream = Array.isArray(event.data?.stream) ? event.data.stream : [];
      for (const item of stream) {
        const reason = item?.chunk?.reason;
        if (!reason || reason.kind !== 'error') continue;
        const failure = reason.failure ?? {};
        const code = String(failure.code ?? 'UNKNOWN');
        const message = String(failure.message ?? '');
        failures.push({
          code,
          message,
          status: typeof failure.status === 'number' ? failure.status : undefined,
          at: Number(event.time ?? 0),
        });
        codeCounts.set(code, (codeCounts.get(code) ?? 0) + 1);
      }
    }
  }

  const byCode = [...codeCounts.entries()]
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count);

  return {
    selections,
    attempts,
    failures,
    byCode,
    lastModel: selections.length > 0 ? selections[selections.length - 1] : null,
    lastFailure: failures.length > 0 ? failures[failures.length - 1] : null,
    turns: turns.size,
    retries,
    title,
  };
}

/**
 * 按关键词找会话（标题、目录名、或内容里出现过的字符串）。
 *
 * @param {string} home
 * @param {string} keyword
 * @param {{limit?: number, scanContent?: boolean}} [options]
 * @returns {Array<object>}
 */
export function findSessions(home, keyword, options = {}) {
  const limit = Number.isFinite(options.limit) ? options.limit : 5;
  const scanContent = options.scanContent !== false;
  const needle = String(keyword || '').trim();
  const all = listSessions(home);
  if (needle.length === 0) return all.slice(0, limit);

  const hits = [];
  const lower = needle.toLowerCase();

  for (const session of all) {
    // 先看目录名/项目名，命中就不用解压
    if (session.id.toLowerCase().includes(lower) || session.project.toLowerCase().includes(lower)) {
      hits.push({ ...session, matchedBy: 'name' });
      if (hits.length >= limit) break;
      continue;
    }
    if (!scanContent) continue;
    // 再扫内容（解压后找字符串）
    const { text } = readSessionLines(session.file);
    if (text.toLowerCase().includes(lower)) {
      hits.push({ ...session, matchedBy: 'content' });
      if (hits.length >= limit) break;
    }
  }
  return hits;
}

/**
 * 完整分析一个会话：读文件、解析事件、给出诊断。
 *
 * @param {string} file
 * @returns {object}
 */
export function diagnoseSession(file) {
  const read = readSessionLines(file);
  if (read.error) return { ok: false, error: read.error };

  const events = [];
  let parseFailed = 0;
  for (const line of read.lines) {
    const text = line.trim();
    if (text.length === 0) continue;
    try {
      events.push(JSON.parse(text));
    } catch {
      parseFailed += 1;
    }
  }

  const analysis = analyzeSessionEvents(events);
  return {
    ok: true,
    file,
    frames: read.frames,
    badFrames: read.badFrames,
    events: events.length,
    parseFailed,
    bytes: read.bytes,
    ...analysis,
  };
}

/**
 * 把会话诊断压成给模型读的纯文本。
 *
 * 重点不是列数据，而是**给结论**：这次失败是什么性质、能不能靠换渠道解决、
 * 还是得改请求本身。
 *
 * @param {object} result  diagnoseSession 的返回值
 * @param {{file?: string, project?: string, mtime?: number}} [meta]
 * @returns {string}
 */
export function describeSession(result, meta = {}) {
  if (!result?.ok) return `读不了这个会话：${result?.error || '未知原因'}`;

  const lines = [];
  if (meta.project) lines.push(`项目：${meta.project}`);
  if (meta.mtime) lines.push(`最后活动：${new Date(meta.mtime).toISOString()}`);
  if (result.title) lines.push(`标题：${result.title}`);
  lines.push(`规模：${result.frames} 帧 / ${result.events} 个事件 / ${Math.round(result.bytes / 1024)}KB`);
  if (result.badFrames > 0) lines.push(`（${result.badFrames} 个帧解不开，通常是还在写入的尾巴，可忽略）`);
  lines.push(`轮次：${result.turns} 轮，模型调用 ${result.attempts} 次，重试 ${result.retries} 次`);

  if (result.lastModel) {
    lines.push('');
    lines.push(`最后用的模型：${result.lastModel.provider} / ${result.lastModel.model}`);
  }
  if (result.selections.length > 1) {
    const used = [];
    const seen = new Set();
    for (const sel of result.selections) {
      const key = `${sel.provider}/${sel.model}`;
      if (seen.has(key)) continue;
      seen.add(key);
      used.push(key);
    }
    if (used.length > 1) {
      lines.push(`这个会话换过 ${used.length} 个模型：`);
      for (const key of used.slice(-8)) lines.push(`  · ${key}`);
      lines.push('（换过这么多次通常说明用户在手动试，而不是某一个渠道坏了）');
    }
  }

  if (result.failures.length === 0) {
    lines.push('');
    lines.push('✓ 没有记录到任何模型调用失败。');
    return lines.join('\n');
  }

  lines.push('');
  lines.push(`失败 ${result.failures.length} 次，按错误码分布：`);
  for (const row of result.byCode) {
    lines.push(`  ${String(row.count).padStart(4)} × ${row.code}${explainCode(row.code)}`);
  }

  const last = result.lastFailure;
  if (last) {
    lines.push('');
    lines.push(`最后一次失败（${new Date(last.at).toISOString()}）：`);
    lines.push(`  错误码：${last.code}${last.status ? ` (HTTP ${last.status})` : ''}`);
    if (last.message) lines.push(`  原文：${String(last.message).slice(0, 400)}`);
  }

  // 每种错误码各给一条原文样本：只看最后一次会漏掉别的性质的问题
  // （比如最后一次是 400，但前面还有一堆额度问题）。
  const samples = new Map();
  for (const failure of result.failures) {
    if (!samples.has(failure.code) && failure.message) samples.set(failure.code, failure.message);
  }
  if (samples.size > 1) {
    lines.push('');
    lines.push('每种错误的一条原文样本：');
    for (const [code, message] of samples) {
      lines.push(`  [${code}] ${String(message).slice(0, 220)}`);
    }
  }

  // 结论：这些失败该不该靠换渠道解决
  const verdict = verdictOf(result);
  lines.push('');
  lines.push(`判断：${verdict}`);

  return lines.join('\n');
}

/** 给错误码加一句人话注解。 */
function explainCode(code) {
  const table = {
    RATE_LIMIT: '（限流：换渠道有用）',
    RATE_LIMITED: '（限流：换渠道有用）',
    QUOTA: '（额度用尽：换渠道有用，或等重置）',
    QUOTA_EXCEEDED: '（额度用尽：换渠道有用，或等重置）',
    INSUFFICIENT_QUOTA: '（额度不足：换渠道有用）',
    BALANCE_INSUFFICIENT: '（余额不足：需要充值或换渠道）',
    LANE_LOCKED: '（车道被锁：换渠道有用）',
    NO_ACCOUNT: '（没有可用账号：换渠道有用）',
    ACCOUNT_UNAVAILABLE: '（账号不可用：换渠道有用）',
    SERVER: '（上游故障：换渠道有用）',
    SERVICE_UNAVAILABLE: '（上游不可用：换渠道有用）',
    EAC_UPSTREAM_FAILED: '（上游失败：换渠道有用）',
    TIMEOUT: '（超时：可能是网络或上下文太大）',
    TRANSPORT: '（连接错误：网络问题）',
    EMPTY_RESPONSE: '（空响应：上游 200 但没内容，换渠道常能解决）',
    INVALID_REQUEST: '（请求本身有问题：换渠道没用，要改请求）',
    INVALID_CREDENTIAL: '（密钥错：换渠道可能有用，别的渠道有自己的密钥）',
    MISSING_CREDENTIAL: '（没配密钥：需要配）',
    AUTHORIZATION_REQUIRED: '（需要授权：要去登录）',
    UNKNOWN_MODEL: '（模型不存在：换渠道可能有用）',
    NO_ADAPTER: '（没有适配器：这个渠道不支持该模型）',
  };
  return table[code] ? ` ${table[code]}` : '';
}

/**
 * 根据失败构成给出结论。
 *
 * 这是整个工具的价值所在：不是把数据丢给模型让它自己看，而是先按"能不能
 * 靠换渠道解决"分好类——因为用户真正想知道的是"我该怎么办"。
 *
 * @param {object} result
 * @returns {string}
 */
export function verdictOf(result) {
  const failures = Array.isArray(result?.failures) ? result.failures : [];
  if (failures.length === 0) return '没有失败，不需要处理。';

  const RETRYABLE = new Set([
    'RATE_LIMIT', 'RATE_LIMITED', 'QUOTA', 'QUOTA_EXCEEDED', 'INSUFFICIENT_QUOTA',
    'BALANCE_INSUFFICIENT', 'LANE_LOCKED', 'NO_ACCOUNT', 'ACCOUNT_UNAVAILABLE',
    'SERVER', 'SERVICE_UNAVAILABLE', 'BAD_GATEWAY', 'OVERLOADED',
    'EAC_UPSTREAM_FAILED', 'UPSTREAM_FAILED', 'PROVIDER_ERROR',
    'TIMEOUT', 'TRANSPORT', 'CONNECTION_ERROR', 'NETWORK',
    'EMPTY_RESPONSE', 'EMPTY_STREAM',
  ]);
  const FATAL = new Set([
    'INVALID_REQUEST', 'UNSUPPORTED_OPTION', 'MISSING_CREDENTIAL',
    'AUTHORIZATION_REQUIRED', 'NO_ADAPTER',
  ]);

  let retryable = 0;
  let fatal = 0;
  let billing = 0;
  for (const failure of failures) {
    if (RETRYABLE.has(failure.code)) retryable += 1;
    if (FATAL.has(failure.code)) fatal += 1;
    if (/QUOTA|BALANCE|LANE_LOCKED|NO_ACCOUNT/.test(failure.code)) billing += 1;
  }

  const total = failures.length;
  const parts = [];

  if (retryable === total) {
    parts.push('全部是"换渠道能解决"的失败。');
  } else if (fatal === total) {
    parts.push('全部是"换渠道也解决不了"的失败——问题在请求本身或凭据，不是渠道。');
  } else if (retryable > fatal) {
    parts.push(`大部分（${retryable}/${total}）能靠换渠道解决，但有 ${fatal} 次是请求或凭据问题。`);
  } else {
    parts.push(`请求/凭据问题（${fatal} 次）比渠道问题（${retryable} 次）更多，先查请求本身。`);
  }

  if (billing > 0) {
    parts.push(`其中 ${billing} 次是额度类，需要充值、等重置或换渠道。`);
  }

  // 模型换过多次 = 用户在手动试
  if (Array.isArray(result.selections)) {
    const distinct = new Set(result.selections.map((s) => `${s.provider}/${s.model}`));
    if (distinct.size >= 3) {
      parts.push(
        `这个会话手动换过 ${distinct.size} 个模型，说明自动降级没有生效或用户不知道它在降级——` +
        '要么链路里没有同规格备胎，要么错误码没被识别。',
      );
    }
  }

  return parts.join('');
}

/**
 * 找"最近失败的会话"，不需要用户指名。
 *
 * @param {string} home
 * @param {{limit?: number, since?: number}} [options]
 * @returns {Array<object>}
 */
export function recentFailures(home, options = {}) {
  const limit = Number.isFinite(options.limit) ? options.limit : 3;
  const since = Number.isFinite(options.since) ? options.since : Date.now() - 7 * 24 * 3600 * 1000;
  const out = [];

  for (const session of listSessions(home)) {
    if (session.mtime < since) break;
    const result = diagnoseSession(session.file);
    if (!result.ok || result.failures.length === 0) continue;
    out.push({ session, result });
    if (out.length >= limit) break;
  }
  return out;
}
