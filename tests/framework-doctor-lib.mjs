/**
 * 框架医生 —— lib 层 + 端到端探测验收测试
 *
 * 覆盖两件事：
 *   1. lib/infer.js、lib/diagnose.js、lib/repair.js 三个模块的契约形状与关键行为
 *   2. 起一个假的 OpenAI 兼容端点，让 Host 的 /probe 真的走一遍网络探测，
 *      验证"给个网址就配好模型"这条主路径能跑通
 *
 * 用法：node tests/framework-doctor-lib.mjs
 */

import http from 'node:http';
import { pathToFileURL } from 'node:url';

import { fileURLToPath } from 'node:url';

/** 仓库根：本文件在 <repo>/tests/ 下，所以往上一层。 */
const ROOT = fileURLToPath(new URL('..', import.meta.url));

let failures = 0;
let checks = 0;
let skipped = 0;

function ok(condition, label, detail) {
  checks += 1;
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail).slice(0, 500)}`}`);
  }
}

function eq(actual, expected, label) {
  ok(Object.is(actual, expected), label, { actual, expected });
}

function skip(label, reason) {
  skipped += 1;
  console.log(`  SKIP ${label}（${reason}）`);
}

async function load(rel) {
  try {
    return await import(pathToFileURL(`${ROOT}/${rel}`).href);
  } catch (error) {
    return { __error: error.message };
  }
}

/* ================================================================== *
 * 1. lib/infer.js
 * ================================================================== */

console.log('\n=== lib/infer.js ===');
const infer = await load('lib/infer.js');
if (infer.__error) {
  skip('infer 全部检查', `模块未就位：${infer.__error}`);
} else {
  for (const symbol of ['inferModel', 'inferProvider', 'readListing', 'probeEndpoint', 'FAMILIES', 'VISION_HINTS', 'REASONING_HINTS']) {
    ok(symbol in infer, `导出 ${symbol}`);
  }

  // --- readListing 三种形态 ---
  const openaiShape = {
    data: [
      { id: 'deepseek-reasoner', object: 'model' },
      { id: 'gpt-4o', context_length: 128000, architecture: { input_modalities: ['text', 'image'] } },
    ],
  };
  const mapShape = {
    models: {
      'qwen3-max': { name: 'Qwen3 Max', context_window: 262144, max_output_tokens: 32768 },
      'glm-4-plus': { name: 'GLM-4 Plus' },
    },
  };
  const bareShape = [{ id: 'claude-sonnet-4-20250514' }, { id: 'gemini-2.5-pro' }];

  for (const [label, body, expectedIds] of [
    ['{data:[]}', openaiShape, ['deepseek-reasoner', 'gpt-4o']],
    ['{models:{}}', mapShape, ['qwen3-max', 'glm-4-plus']],
    ['裸数组', bareShape, ['claude-sonnet-4-20250514', 'gemini-2.5-pro']],
  ]) {
    try {
      const rows = infer.readListing(body);
      eq(rows.length, expectedIds.length, `readListing ${label} 条目数`);
      eq(rows.map((r) => r.id).join(','), expectedIds.join(','), `readListing ${label} id 顺序`);
    } catch (error) {
      ok(false, `readListing ${label} 不抛错`, error.message);
    }
  }

  // --- inferModel 关键判定 ---
  const cases = [
    {
      label: 'deepseek-reasoner 应是推理模型且给档位',
      entry: { id: 'deepseek-reasoner' },
      check: (m) => m.reasoningEfforts !== false && typeof m.reasoningEfforts === 'object' && m.reasoningEfforts !== null,
    },
    {
      label: 'deepseek-reasoner 的 thinkingFormat 应是 deepseek',
      entry: { id: 'deepseek-reasoner' },
      check: (m) => m.compat?.thinkingFormat === 'deepseek',
    },
    {
      label: 'gpt-4o 应支持看图',
      entry: { id: 'gpt-4o' },
      check: (m) => Array.isArray(m.input) && m.input.includes('image'),
    },
    {
      label: 'gpt-4o 不应被当成推理模型',
      entry: { id: 'gpt-4o' },
      check: (m) => m.reasoningEfforts === false,
    },
    {
      label: 'qwen3-max 应是推理模型',
      entry: { id: 'qwen3-max' },
      check: (m) => m.reasoningEfforts !== false && typeof m.reasoningEfforts === 'object',
    },
    {
      label: '完全陌生的模型 id 不瞎编思考档位',
      entry: { id: 'zzz-unknown-model-9000' },
      check: (m) => m.reasoningEfforts === undefined || m.reasoningEfforts === false,
    },
    {
      label: '陌生模型至少有 text 输入',
      entry: { id: 'zzz-unknown-model-9000' },
      check: (m) => Array.isArray(m.input) && m.input.includes('text'),
    },
    {
      label: '端点声明的上下文优先于家族推测',
      entry: { id: 'gpt-4o', context_length: 999999 },
      check: (m) => m.contextWindow === 999999,
    },
    {
      label: '模型 id 被保留',
      entry: { id: 'some-model' },
      check: (m) => m.id === 'some-model',
    },
    {
      label: '每条结果都带 confidence',
      entry: { id: 'some-model' },
      check: (m) => ['declared', 'inferred', 'unknown'].includes(m.confidence),
    },
  ];

  for (const { label, entry, check } of cases) {
    let model;
    try {
      model = infer.inferModel(entry, {});
    } catch (error) {
      ok(false, label, error.message);
      continue;
    }
    ok(check(model), label, model);
  }

  // input 只能有 text/image
  {
    const model = infer.inferModel({ id: 'x', input_modalities: ['text', 'audio', 'video', 'image'] }, {});
    ok(
      Array.isArray(model.input) && model.input.every((v) => v === 'text' || v === 'image'),
      'audio/video 被丢弃，只留 text/image',
      model.input,
    );
  }

  // 家族表
  ok(Array.isArray(infer.FAMILIES), 'FAMILIES 是数组（有序）');
  ok(infer.FAMILIES.length >= 10, 'FAMILIES 至少 10 个家族', infer.FAMILIES.length);
  // 兜底条目（key === 'unknown'）本来就没有匹配正则，它的存在是为了让"查不到家族"
  // 也有上下文窗口/档位等字段可读，所以这里只要求"有正则的条目"字段完整。
  const matchable = infer.FAMILIES.filter((f) => f && f.match !== null && f.match !== undefined);
  ok(matchable.length >= 10, '可匹配家族至少 10 个', matchable.length);
  ok(
    matchable.every((f) => typeof f.label === 'string' && f.match instanceof RegExp),
    '每个可匹配家族都有 label 和 match 正则',
    matchable.filter((f) => typeof f.label !== 'string' || !(f.match instanceof RegExp)),
  );
  ok(
    infer.FAMILIES.every((f) => f && typeof f.key === 'string'),
    '每个家族都有 key',
  );
  const unknownFamily = infer.FAMILIES.find((f) => f.key === 'unknown');
  ok(Boolean(unknownFamily), '存在 unknown 兜底家族');
  eq(unknownFamily?.match, null, 'unknown 兜底条目的 match 为 null（不参与匹配）');

  // inferProvider
  if (typeof infer.inferProvider === 'function') {
    const provider = infer.inferProvider({
      baseURL: 'https://api.anthropic.com',
      models: [{ id: 'claude-sonnet-4' }],
    });
    ok(typeof provider === 'object' && provider !== null, 'inferProvider 返回对象');
    eq(provider?.api, 'anthropic-messages', 'anthropic 网址推断出 anthropic-messages 协议');
    ok(Array.isArray(provider?.models) && provider.models.length === 1, 'inferProvider 透传模型');
  }
}

/* ================================================================== *
 * 2. lib/diagnose.js
 * ================================================================== */

console.log('\n=== lib/diagnose.js ===');
const diagnose = await load('lib/diagnose.js');
if (diagnose.__error) {
  skip('diagnose 全部检查', `模块未就位：${diagnose.__error}`);
} else {
  for (const symbol of ['diagnoseConfig', 'diagnoseRuntime', 'SEVERITY']) {
    ok(symbol in diagnose, `导出 ${symbol}`);
  }

  const brokenProviders = {
    // 缺 baseURL + 缺凭据
    'no-base-url': { api: 'openai-completions', models: [{ id: 'a-model' }] },
    // 有 apiKeyEnv 但凭据未配置
    'unresolved-key': {
      apiKeyEnv: 'MISSING_KEY',
      baseURL: 'https://a.example/v1',
      models: [{ id: 'b-model' }],
    },
    // 明文密钥
    'plaintext-key': {
      baseURL: 'https://b.example/v1',
      headers: { Authorization: 'Bearer sk-not-a-real-key-used-to-test-the-detector' },
      models: [{ id: 'c-model' }],
    },
    // 手写协议但模型为空
    'empty-models': { api: 'openai-completions', baseURL: 'https://c.example/v1', models: [] },
    // 推理模型没写档位 + 没写 input/context/maxTokens
    'reasoning-bare': {
      apiKeyEnv: 'OK_KEY',
      baseURL: 'https://d.example/v1',
      models: [{ id: 'deepseek-reasoner' }],
    },
    // 非推理模型却写了档位
    'plain-with-efforts': {
      apiKeyEnv: 'OK_KEY',
      baseURL: 'https://e.example/v1',
      models: [{ id: 'gpt-4o', reasoningEfforts: { high: 'high' }, input: ['text', 'image'], contextWindow: 128000, maxTokens: 16384 }],
    },
    // 重复 id
    'duplicate': {
      apiKeyEnv: 'OK_KEY',
      baseURL: 'https://f.example/v1',
      models: [
        { id: 'same', input: ['text'], contextWindow: 8000, maxTokens: 1000 },
        { id: 'same', input: ['text'], contextWindow: 8000, maxTokens: 1000 },
      ],
    },
    // 模型 id 是文件路径
    'file-path-model': {
      apiKeyEnv: 'OK_KEY',
      baseURL: 'http://127.0.0.1:8080/v1',
      models: [{ id: 'C:\\models\\qwen.gguf', input: ['text'], contextWindow: 8000, maxTokens: 1000 }],
    },
  };

  const credentialState = {
    MISSING_KEY: { configured: false },
    OK_KEY: { configured: true, source: 'store' },
  };
  const defaultSelection = { provider: 'ghost-provider', model: 'ghost-model', reasoningEffort: null };
  const llmProviders = [{ id: 'plain-with-efforts', name: 'plain' }];

  let findings = [];
  try {
    findings = diagnose.diagnoseConfig({
      providers: brokenProviders,
      defaultSelection,
      credentialState,
      llmProviders,
    });
  } catch (error) {
    ok(false, 'diagnoseConfig 不抛错', error.message);
  }

  ok(Array.isArray(findings), 'diagnoseConfig 返回数组');
  ok(findings.length > 0, '在坏配置上确实查出了问题', findings.length);

  const ids = findings.map((f) => String(f.id));
  ok(ids.every((id) => id.length > 0), '每条 finding 都有非空 id');
  eq(new Set(ids).size, ids.length, 'finding id 不重复');
  ok(
    findings.every((f) => ['fatal', 'warn', 'info'].includes(f.severity)),
    'severity 只用 fatal/warn/info',
  );
  ok(findings.every((f) => typeof f.title === 'string' && f.title.length > 0), '每条都有 title');
  ok(findings.every((f) => typeof f.detail === 'string' && f.detail.length > 0), '每条都有 detail');

  // 具体规则必须命中
  const requiredRules = [
    ['no-base-url', /no-base-url/],
    ['no-credential', /no-credential/],
    ['credential-unresolved', /credential-unresolved/],
    ['plaintext-secret', /plaintext-secret/],
    ['missing-models', /missing-models/],
    ['reasoning-missing-efforts', /reasoning-missing-efforts/],
    ['reasoning-on-plain-model', /reasoning-on-plain-model/],
    ['duplicate-model', /duplicate-model/],
    ['model-file-path', /model-file-path/],
    ['default-model-missing', /default-model-missing/],
    ['route-unregistered', /route-unregistered/],
  ];
  for (const [label, pattern] of requiredRules) {
    ok(ids.some((id) => pattern.test(id)), `规则命中：${label}`, ids);
  }

  // 稳定性
  const again = diagnose.diagnoseConfig({
    providers: brokenProviders,
    defaultSelection,
    credentialState,
    llmProviders,
  });
  eq(
    JSON.stringify(again.map((f) => f.id).sort()),
    JSON.stringify([...ids].sort()),
    '同样输入两次结果完全一致（id 稳定）',
  );

  // 外部插件注册的 provider（如 our-free-model 动态注册的 buddy）：不误报"不存在"。
  {
    const externalFindings = diagnose.diagnoseConfig({
      providers: brokenProviders,
      // 默认模型指向的 provider 不在 llm-pi-ai 配置里，但已注册到模型服务（外部插件提供）
      defaultSelection: { provider: 'buddy', model: 'step-5-preview', reasoningEffort: null },
      credentialState,
      llmProviders: [
        { id: 'plain-with-efforts', name: 'plain' },
        { id: 'buddy', name: 'Buddy' },
      ],
    });
    const externalIds = externalFindings.map((f) => String(f.id));
    ok(
      !externalIds.some((id) => /default-model-missing/.test(id)),
      '外部插件注册的默认模型 provider 不报 default-model-missing',
      externalIds.filter((id) => /default-model-missing/.test(id)),
    );
    ok(
      externalIds.some((id) => /external-provider\/buddy/.test(id)),
      '识别出 buddy 是外部插件提供的 provider（info 级）',
      externalIds,
    );
    const buddyFinding = externalFindings.find((f) => /external-provider\/buddy/.test(String(f.id)));
    eq(buddyFinding?.severity, 'info', '外部 provider 是 info 级（不是错误）');
    // 独立场景：默认模型指向"既不在配置、也没注册"的 provider，仍要报 fatal
    const missingFindings = diagnose.diagnoseConfig({
      providers: brokenProviders,
      defaultSelection: { provider: 'ghost-provider', model: 'ghost-model', reasoningEffort: null },
      credentialState,
      llmProviders: [
        { id: 'plain-with-efforts', name: 'plain' },
        { id: 'buddy', name: 'Buddy' },
      ],
    });
    const missingIds = missingFindings.map((f) => String(f.id));
    ok(
      missingIds.some((id) => /default-model-missing\/ghost-provider/.test(id)),
      '真正不存在的默认模型仍然会报（ghost-provider）',
      missingIds,
    );
  }

  // 已注册 provider 即使不在配置里，也应进入修复候选（不把 buddy 排除）
  if (typeof diagnose.diagnoseConfig === 'function') {
    // 通过 repair 的 planRepair 验证候选里包含外部 provider
    const repairMod = await load('lib/repair.js');
    if (!repairMod.__error) {
      const plan = repairMod.planRepair(
        [{
          id: 'default-model-missing/ghost/ghost',
          severity: 'fatal',
          scope: 'default-model',
          title: '默认模型不存在',
          detail: 'x',
          repair: {
            kind: 'set-default-model',
            payload: {
              provider: 'ghost',
              model: 'ghost',
              candidates: [{ provider: 'buddy', model: '' }],
            },
          },
        }],
        { providers: brokenProviders, defaultSelection: { provider: 'ghost', model: 'ghost' }, probed: {} },
      );
      const step = plan?.steps?.find((s) => s.kind === 'set-default-model');
      ok(step && step.payload && Array.isArray(step.payload.candidates), 'set-default-model 步骤保留候选');
    }
  }

  // runtime
  if (typeof diagnose.diagnoseRuntime === 'function') {
    const runtimeFindings = diagnose.diagnoseRuntime({
      plugins: [
        { entryId: 'broken', moduleName: 'x', enabled: true, fiberPhase: 'failed' },
        { entryId: 'stuck', moduleName: 'y', enabled: true, fiberPhase: 'pending' },
        { entryId: 'fine', moduleName: 'z', enabled: true, fiberPhase: 'active' },
      ],
      llmProviders,
      defaultSelection,
      providers: brokenProviders,
    });
    ok(Array.isArray(runtimeFindings), 'diagnoseRuntime 返回数组');
    const runtimeIds = runtimeFindings.map((f) => String(f.id));
    ok(runtimeIds.some((id) => /plugin-row-failed/.test(id)), '规则命中：plugin-row-failed', runtimeIds);
    ok(
      runtimeIds.some((id) => /default-model-not-live|no-default-model|default-model-missing/.test(id)),
      '默认模型问题被运行时体检抓到',
      runtimeIds,
    );
  }
}

/* ================================================================== *
 * 3. lib/repair.js
 * ================================================================== */

console.log('\n=== lib/repair.js ===');
const repair = await load('lib/repair.js');
if (repair.__error) {
  skip('repair 全部检查', `模块未就位：${repair.__error}`);
} else {
  for (const symbol of ['planRepair', 'describeRepair']) {
    ok(symbol in repair, `导出 ${symbol}`);
  }

  const providers = {
    'needs-input': {
      apiKeyEnv: 'OK_KEY',
      baseURL: 'https://a.example/v1',
      models: [{ id: 'gpt-4o' }],
    },
    'dup': {
      apiKeyEnv: 'OK_KEY',
      baseURL: 'https://b.example/v1',
      models: [{ id: 'same' }, { id: 'same' }],
    },
  };
  const findings = [
    {
      id: 'missing-input/needs-input/gpt-4o',
      severity: 'info',
      scope: 'model',
      route: 'needs-input',
      modelId: 'gpt-4o',
      title: '没声明输入模态',
      detail: 'x',
      repair: { kind: 'infer-input', payload: {} },
    },
    {
      id: 'duplicate-model/dup/same',
      severity: 'warn',
      scope: 'model',
      route: 'dup',
      modelId: 'same',
      title: '重复 id',
      detail: 'x',
      repair: { kind: 'drop-duplicate', payload: {} },
    },
  ];

  // 不带 probed：需要探测的步骤应标 needsProbe 且 op 为 null
  let plan;
  try {
    plan = repair.planRepair(findings, { providers, defaultSelection: null, probed: {} });
  } catch (error) {
    ok(false, 'planRepair 不抛错', error.message);
  }
  ok(plan && Array.isArray(plan.steps), 'planRepair 返回 { steps: [] }', plan);
  ok(plan && Array.isArray(plan.skipped), 'planRepair 返回 skipped');

  const inferStep = plan?.steps?.find((s) => s.findingId === 'missing-input/needs-input/gpt-4o');
  ok(Boolean(inferStep), '找到了 infer-input 步骤');
  ok(inferStep?.needsProbe === true, '没有探测结果时标记 needsProbe');
  eq(inferStep?.op, null, '没有探测结果时 op 为 null');

  const dupStep = plan?.steps?.find((s) => s.findingId === 'duplicate-model/dup/same');
  ok(Boolean(dupStep), '找到了 drop-duplicate 步骤');
  ok(dupStep?.op && dupStep.op.op === 'set', 'drop-duplicate 生成 set op');
  ok(
    Array.isArray(dupStep?.op?.value) && dupStep.op.value.length === 1,
    'drop-duplicate 后只剩一个模型',
    dupStep?.op?.value,
  );

  // 带 probed：应生成具体 op
  const probed = {
    'needs-input': [
      {
        id: 'gpt-4o',
        name: 'GPT-4o',
        input: ['text', 'image'],
        contextWindow: 128000,
        maxTokens: 16384,
        reasoningEfforts: false,
      },
    ],
  };
  let plan2;
  try {
    plan2 = repair.planRepair(findings, { providers, defaultSelection: null, probed });
  } catch (error) {
    ok(false, 'planRepair(带 probed) 不抛错', error.message);
  }
  const inferStep2 = plan2?.steps?.find((s) => s.findingId === 'missing-input/needs-input/gpt-4o');
  ok(inferStep2?.op && inferStep2.op.op === 'set', '有探测结果时生成具体 set op');
  const written = inferStep2?.op?.value;
  const writtenModel = Array.isArray(written) ? written.find((m) => m.id === 'gpt-4o') : null;
  ok(Boolean(writtenModel), 'op.value 是模型数组且含 gpt-4o', written);
  ok(
    Array.isArray(writtenModel?.input) && writtenModel.input.includes('image'),
    '探测到的 image 模态被合并进去',
    writtenModel,
  );

  // 幂等
  const plan2b = repair.planRepair(findings, { providers, defaultSelection: null, probed });
  eq(JSON.stringify(plan2), JSON.stringify(plan2b), 'planRepair 幂等（同输入同输出）');

  // 绝不生成 unset（删数据）
  const allOps = [...(plan?.steps ?? []), ...(plan2?.steps ?? [])]
    .map((s) => s.op)
    .filter(Boolean);
  ok(allOps.every((op) => op.op === 'set'), '所有 op 都是 set，没有 unset（不删用户数据）', allOps.map((o) => o.op));

  // describeRepair
  if (typeof repair.describeRepair === 'function') {
    const manual = {
      findingId: 'x',
      kind: 'open-credential',
      op: null,
      needsProbe: false,
      payload: { hint: '请到凭据页填写该密钥' },
    };
    const text = repair.describeRepair(manual);
    ok(typeof text === 'string' && text.length > 0, 'describeRepair 返回非空说明', text);
  }
}

/* ================================================================== *
 * 4. 端到端：起假端点 → /probe 真的探测
 * ================================================================== */

console.log('\n=== 端到端：假端点 + /probe ===');

const LISTING = {
  data: [
    {
      id: 'deepseek-reasoner',
      object: 'model',
      context_length: 131072,
      max_output_tokens: 8192,
    },
    {
      id: 'gpt-4o',
      object: 'model',
      context_length: 128000,
      max_output_tokens: 16384,
      architecture: { input_modalities: ['text', 'image'] },
    },
    {
      id: 'qwen3-max',
      object: 'model',
      context_window: 262144,
      max_output_tokens: 32768,
    },
  ],
};

let server;
let baseURL;
try {
  server = http.createServer((req, res) => {
    if (req.url === '/v1/models' && req.method === 'GET') {
      const auth = req.headers.authorization ?? '';
      if (!auth.startsWith('Bearer ')) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'no key' }));
        return;
      }
      const body = Buffer.from(JSON.stringify(LISTING), 'utf8');
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(body.length) });
      res.end(body);
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  baseURL = `http://127.0.0.1:${port}/v1`;
  ok(true, `假端点已启动：${baseURL}`);
} catch (error) {
  ok(false, '假端点启动', error.message);
}

if (baseURL) {
  // 直接用 infer.probeEndpoint 打一遍
  if (!infer.__error && typeof infer.probeEndpoint === 'function') {
    try {
      const result = await infer.probeEndpoint({ baseURL, apiKey: 'sk-fake' }, AbortSignal.timeout(8000));
      eq(result.models.length, 3, 'probeEndpoint 拿到 3 个模型');
      ok(typeof result.endpoint === 'string' && result.endpoint.includes('/models'), 'endpoint 是 models 地址', result.endpoint);
      eq(result.hasKey, true, 'hasKey 为 true');
      const gpt = result.models.find((m) => m.id === 'gpt-4o');
      ok(Array.isArray(gpt?.input) && gpt.input.includes('image'), 'gpt-4o 的 image 模态来自端点声明');
      const reasoner = result.models.find((m) => m.id === 'deepseek-reasoner');
      ok(reasoner?.reasoningEfforts !== false, 'deepseek-reasoner 被识别为推理模型');
      const qwen = result.models.find((m) => m.id === 'qwen3-max');
      eq(qwen?.contextWindow, 262144, 'qwen3-max 的上下文来自端点');
    } catch (error) {
      ok(false, 'probeEndpoint 端到端成功', error.message);
    }

    // 无密钥应报错且信息可读
    try {
      await infer.probeEndpoint({ baseURL, api: 'openai-completions' }, AbortSignal.timeout(8000));
      ok(false, '无密钥时应该失败', '居然成功了');
    } catch (error) {
      const text = String(error?.message ?? error);
      ok(text.length > 0, '无密钥时抛出的错误有中文说明', text);
      ok(/401|密钥|凭据|key/i.test(text), '错误信息提示了密钥问题', text);
    }

    // 连不上的地址
    try {
      await infer.probeEndpoint({ baseURL: 'http://127.0.0.1:1/v1' }, AbortSignal.timeout(3000));
      ok(false, '连不上时应该失败', '居然成功了');
    } catch (error) {
      ok(String(error?.message ?? '').length > 0, '连不上时也有可读错误', String(error?.message ?? ''));
    }
  }

  // 通过 Host 的 /probe 走一遍
  const host = await load('index.js');
  if (!host.__error && typeof host.apply === 'function') {
    const captured = { routes: [] };
    const ctx = {
      logger: { info() {}, warn() {}, debug() {}, error() {} },
      settings: {
        describe: () => [
          {
            ns: 'llm-pi-ai',
            applies: 'live',
            revision: 1,
            value: { providers: {} },
            user: { providers: {} },
          },
        ],
        mutate: async () => {},
      },
      effect(fn) {
        captured.effects ??= [];
        captured.effects.push(fn());
        return () => {};
      },
      on: () => () => {},
      get(name) {
        if (name === 'credentials') {
          return { resolve: async () => undefined, describe: async () => ({ configured: false }) };
        }
        return undefined;
      },
      inject(deps, callback) {
        if (deps.includes('webServer')) {
          callback({
            webServer: {
              register(route) {
                captured.routes.push(route);
                return () => {};
              },
            },
            effect: (fn) => {
              captured.effects ??= [];
              captured.effects.push(fn());
              return () => {};
            },
          });
        }
      },
    };

    host.apply(ctx, { enabled: true, autoScan: false, probeTimeoutMs: 8000 });
    const route = captured.routes[0];
    ok(Boolean(route), 'Host 注册了路由');

    if (route) {
      const res = {
        state: { status: 0, body: '' },
        writeHead(status) {
          this.state.status = status;
        },
        end(body) {
          this.state.body = String(body ?? '');
        },
      };
      const listeners = new Map();
      const req = {
        method: 'POST',
        url: '/api/framework-doctor/probe',
        headers: { host: '127.0.0.1:58814' },
        on(event, fn) {
          listeners.set(event, fn);
          if (event === 'end') {
            setTimeout(() => {
              listeners.get('data')?.(Buffer.from(JSON.stringify({ baseURL, apiKey: 'sk-fake' }), 'utf8'));
              listeners.get('end')?.();
            }, 0);
          }
          return req;
        },
        destroy() {},
      };
      route.handler(req, res);
      for (let i = 0; i < 300 && !res.state.body; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      let payload = null;
      try {
        payload = JSON.parse(res.state.body);
      } catch {
        /* 保持 null */
      }
      eq(res.state.status, 200, 'POST /probe 返回 200');
      ok(payload?.ok === true, 'POST /probe ok:true', payload);
      eq(payload?.models?.length, 3, 'POST /probe 返回 3 个模型');
      ok(!res.state.body.includes('sk-fake'), '/probe 响应里没有密钥明文');
    }
  } else {
    skip('Host /probe 端到端', host.__error ?? 'apply 不可用');
  }
}

if (server) await new Promise((resolve) => server.close(resolve));

console.log(
  `\n${failures === 0 ? '全部通过' : '有失败'}：${checks - failures}/${checks} 项通过` +
    (skipped > 0 ? `，${skipped} 项跳过` : ''),
);
if (failures > 0) process.exitCode = 1;
