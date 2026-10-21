/**
 * 会话日志读取的测试。
 *
 * 这个模块的价值全在"能不能真的从磁盘里把失败原因挖出来"，所以测试重点：
 *   - 多帧 zstd 切帧正确（这是踩过的坑）
 *   - **帧边界 ≠ 行边界**（第二个坑：把帧当行会导致大量事件解析失败）
 *   - 失败从 assistant/attempt 的 stream 里提取
 *   - 错误码分布 + 判断（能不能靠换渠道解决）
 *   - 找不到/坏文件时安静降级
 */
import { pathToFileURL } from 'node:url';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

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

const mod = await import(pathToFileURL(`${ROOT}/lib/session-log.js`).href);

/** 造一个多帧 zstd 会话文件。frames 是字符串数组，每个压成一帧。 */
function writeSession(dir, frames) {
  mkdirSync(path.join(dir, 'sessions', '--proj--', 'session-test'), { recursive: true });
  const file = path.join(dir, 'sessions', '--proj--', 'session-test', 'session.v4.jsonl.zstd');
  const buffers = frames.map((text) => zlib.zstdCompressSync(Buffer.from(text, 'utf8')));
  writeFileSync(file, Buffer.concat(buffers));
  return file;
}

console.log('\n=== 多帧 zstd 切帧 ===');
{
  const home = mkdtempSync(path.join(tmpdir(), 'fd-log-'));
  // 两帧，各含一整行
  const file = writeSession(home, [
    '{"type":"a","seq":1}\n',
    '{"type":"b","seq":2}\n',
  ]);
  const read = mod.readSessionLines(file);
  eq(read.frames, 2, '切出 2 帧');
  eq(read.badFrames, 0, '没有坏帧');
  eq(read.lines.length, 2, '解出 2 行');
  eq(read.lines[0], '{"type":"a","seq":1}', '第一行内容正确');
  ok(read.text.includes('{"type":"b"'), 'text 包含两帧内容');

  // **关键**：一帧里含多行
  const multi = writeSession(mkdtempSync(path.join(tmpdir(), 'fd-log2-')), [
    '{"type":"a"}\n{"type":"b"}\n',
  ]);
  const readMulti = mod.readSessionLines(multi);
  eq(readMulti.frames, 1, '只有 1 帧');
  eq(readMulti.lines.length, 2, '但解出 2 行（帧≠行）');

  // **关键**：一行被拆到两帧
  const split = writeSession(mkdtempSync(path.join(tmpdir(), 'fd-log3-')), [
    '{"type":"a","da',
    'ta":123}\n',
  ]);
  const readSplit = mod.readSessionLines(split);
  eq(readSplit.frames, 2, '切出 2 帧');
  eq(readSplit.lines.length, 1, '拼接后只有 1 行');
  eq(readSplit.lines[0], '{"type":"a","data":123}', '跨帧的行被正确拼回来');

  // 坏文件
  const missing = mod.readSessionLines(path.join(home, 'nope.zstd'));
  eq(missing.lines.length, 0, '文件不存在时返回空');
  ok(typeof missing.error === 'string', '带错误原因');

  rmSync(home, { recursive: true, force: true });
}

console.log('\n=== 事件分析：失败提取 ===');
{
  const events = [
    { type: 'session/title', data: { title: '测试会话' }, time: 1 },
    { type: 'model/selection', data: { provider: 'chan-a', model: 'model-x' }, time: 2 },
    { type: 'step/start', data: { turn: 1, step: 1 }, time: 3 },
    {
      type: 'assistant/attempt',
      time: 4,
      data: {
        stream: [
          { type: 'chunk', chunk: { type: 'finish', reason: { kind: 'error', failure: {
            message: 'rate limit exceeded', code: 'RATE_LIMIT', status: 429,
          } } } },
        ],
      },
    },
    {
      type: 'assistant/attempt',
      time: 5,
      data: {
        stream: [
          { type: 'chunk', chunk: { type: 'finish', reason: { kind: 'error', failure: {
            message: 'quota exhausted', code: 'QUOTA_EXCEEDED',
          } } } },
        ],
      },
    },
    { type: 'model/selection', data: { provider: 'chan-b', model: 'model-y' }, time: 6 },
    { type: 'llm/retry-started', data: { retry: 1 }, time: 7 },
    {
      type: 'assistant/attempt',
      time: 8,
      data: {
        stream: [
          { type: 'chunk', chunk: { type: 'finish', reason: { kind: 'error', failure: {
            message: 'bad request', code: 'INVALID_REQUEST', status: 400,
          } } } },
        ],
      },
    },
  ];

  const analysis = mod.analyzeSessionEvents(events);
  eq(analysis.title, '测试会话', '读到标题');
  eq(analysis.attempts, 3, '3 次模型调用');
  eq(analysis.failures.length, 3, '3 次失败');
  eq(analysis.retries, 1, '1 次重试');
  eq(analysis.turns, 1, '1 轮');
  eq(analysis.lastModel.provider, 'chan-b', '最后用的是 chan-b');
  eq(analysis.lastModel.model, 'model-y', '最后模型是 model-y');
  eq(analysis.lastFailure.code, 'INVALID_REQUEST', '最后一次失败是 INVALID_REQUEST');
  eq(analysis.lastFailure.status, 400, '带上 HTTP 400');

  // 错误码分布按次数降序
  const codes = analysis.byCode.map((r) => r.code);
  eq(analysis.byCode.length, 3, '3 种错误码');
  ok(codes.includes('RATE_LIMIT') && codes.includes('QUOTA_EXCEEDED') && codes.includes('INVALID_REQUEST'), '三种码都在', codes);

  // 没有失败
  const clean = mod.analyzeSessionEvents([{ type: 'model/selection', data: { provider: 'a', model: 'b' } }]);
  eq(clean.failures.length, 0, '没有失败时为空');
  eq(clean.attempts, 0, '没有调用');
  eq(mod.analyzeSessionEvents(null).failures.length, 0, 'null 安全');
}

console.log('\n=== 判断：能不能靠换渠道解决 ===');
{
  // 全是可换渠道的
  const retryable = mod.verdictOf({
    failures: [{ code: 'RATE_LIMIT' }, { code: 'QUOTA_EXCEEDED' }, { code: 'SERVER' }],
    selections: [],
  });
  ok(retryable.includes('换渠道能解决'), '全是可换的', retryable);

  // 全是不可换的
  const fatal = mod.verdictOf({
    failures: [{ code: 'INVALID_REQUEST' }, { code: 'MISSING_CREDENTIAL' }],
    selections: [],
  });
  ok(fatal.includes('换渠道也解决不了'), '全是不可换的', fatal);

  // 混合
  const mixed = mod.verdictOf({
    failures: [{ code: 'RATE_LIMIT' }, { code: 'RATE_LIMIT' }, { code: 'INVALID_REQUEST' }],
    selections: [],
  });
  ok(mixed.includes('大部分'), '混合时说明比例', mixed);

  // 额度类单独提示
  const billing = mod.verdictOf({ failures: [{ code: 'QUOTA_EXCEEDED' }], selections: [] });
  ok(billing.includes('额度'), '额度类单独提示', billing);

  // 换过很多模型
  const manyModels = mod.verdictOf({
    failures: [{ code: 'RATE_LIMIT' }],
    selections: [
      { provider: 'a', model: 'x' },
      { provider: 'b', model: 'y' },
      { provider: 'c', model: 'z' },
    ],
  });
  ok(manyModels.includes('手动换过'), '识别出用户手动试过多个模型', manyModels);

  eq(mod.verdictOf({ failures: [] }), '没有失败，不需要处理。', '没有失败时的判断');
}

console.log('\n=== describeSession ===');
{
  const result = {
    ok: true,
    frames: 10,
    badFrames: 0,
    events: 20,
    parseFailed: 0,
    bytes: 5000,
    title: '出问题的会话',
    turns: 2,
    attempts: 5,
    retries: 1,
    selections: [
      { provider: 'chan-a', model: 'm1', at: 1 },
      { provider: 'chan-b', model: 'm2', at: 2 },
      { provider: 'chan-c', model: 'm3', at: 3 },
    ],
    failures: [
      { code: 'QUOTA_EXCEEDED', message: '额度已用尽', at: 4 },
      { code: 'RATE_LIMIT', message: 'rpm exhausted', at: 5 },
    ],
    byCode: [{ code: 'QUOTA_EXCEEDED', count: 1 }, { code: 'RATE_LIMIT', count: 1 }],
    lastModel: { provider: 'chan-c', model: 'm3' },
    lastFailure: { code: 'RATE_LIMIT', message: 'rpm exhausted', at: 5 },
  };
  const text = mod.describeSession(result, { project: 'my-proj', mtime: 1_700_000_000_000 });
  ok(text.includes('出问题的会话'), '包含标题', text.slice(0, 80));
  ok(text.includes('my-proj'), '包含项目名');
  ok(text.includes('chan-c / m3'), '包含最后用的模型');
  ok(text.includes('QUOTA_EXCEEDED'), '包含错误码');
  ok(text.includes('额度已用尽'), '包含错误原文');
  ok(text.includes('判断：'), '包含判断');

  // 没失败
  const clean = mod.describeSession({ ...result, failures: [], byCode: [], lastFailure: null });
  ok(clean.includes('没有记录到任何模型调用失败'), '没失败时明确说没有');

  // 读不了
  ok(mod.describeSession({ ok: false, error: '文件损坏' }).includes('文件损坏'), '失败时给出原因');
}

console.log('\n=== listSessions / findSessions ===');
{
  const home = mkdtempSync(path.join(tmpdir(), 'fd-find-'));
  // 造两个会话
  mkdirSync(path.join(home, 'sessions', '--proj-a--', 'session-aaa'), { recursive: true });
  mkdirSync(path.join(home, 'sessions', '--proj-b--', 'session-bbb'), { recursive: true });
  const fileA = path.join(home, 'sessions', '--proj-a--', 'session-aaa', 'session.v4.jsonl.zstd');
  const fileB = path.join(home, 'sessions', '--proj-b--', 'session-bbb', 'session.v4.jsonl.zstd');
  writeFileSync(fileA, zlib.zstdCompressSync(Buffer.from('{"type":"x","data":{"text":"苹果香蕉"}}\n')));
  writeFileSync(fileB, zlib.zstdCompressSync(Buffer.from('{"type":"x","data":{"text":"橙子"}}\n')));

  const all = mod.listSessions(home);
  eq(all.length, 2, '列出 2 个会话');
  ok(all.every((s) => s.file.endsWith('session.v4.jsonl.zstd')), '每个都有文件路径');

  // 按目录名找
  const byName = mod.findSessions(home, 'proj-a', { limit: 5 });
  eq(byName.length, 1, '按项目名找到 1 个');
  eq(byName[0].matchedBy, 'name', '匹配方式是名字');

  // 按内容找
  const byContent = mod.findSessions(home, '苹果', { limit: 5 });
  eq(byContent.length, 1, '按内容找到 1 个');
  eq(byContent[0].matchedBy, 'content', '匹配方式是内容');

  // 找不到
  eq(mod.findSessions(home, '不存在的词', { limit: 5 }).length, 0, '找不到时返回空');

  // 空关键词返回最近的
  eq(mod.findSessions(home, '', { limit: 1 }).length, 1, '空关键词返回最近的 N 个');

  rmSync(home, { recursive: true, force: true });
}

console.log('\n=== recentFailures ===');
{
  const home = mkdtempSync(path.join(tmpdir(), 'fd-recent-'));
  mkdirSync(path.join(home, 'sessions', '--p--', 'session-fail'), { recursive: true });
  const file = path.join(home, 'sessions', '--p--', 'session-fail', 'session.v4.jsonl.zstd');
  const events = [
    { type: 'assistant/attempt', time: Date.now(), data: { stream: [
      { chunk: { type: 'finish', reason: { kind: 'error', failure: { code: 'QUOTA_EXCEEDED', message: 'no quota' } } } },
    ] } },
  ];
  writeFileSync(file, zlib.zstdCompressSync(Buffer.from(events.map((e) => JSON.stringify(e)).join('\n') + '\n')));

  const recent = mod.recentFailures(home, { limit: 3 });
  eq(recent.length, 1, '找到 1 个有失败的会话');
  eq(recent[0].result.failures.length, 1, '里面确实有失败');

  // 时间窗口外的不算
  eq(mod.recentFailures(home, { limit: 3, since: Date.now() + 10_000 }).length, 0, '窗口外的不算');

  rmSync(home, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? '全部通过' : '有失败'}：${checks - failures}/${checks} 项通过`);
if (failures > 0) process.exitCode = 1;