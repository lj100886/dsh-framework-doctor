/**
 * 真 agent 通道的测试。
 *
 * 重点不是"能不能连上模型"（那需要真环境），而是：
 *   - 会话 id 稳定且带前缀（不会和用户会话混）
 *   - transcript 投影正确（页面看到的就是 session 记下的）
 *   - agent 不可用时**必须降级**到简易对话，而不是整个页面废掉
 *   - 中断、状态查询这些辅助路径不抛
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

const mod = await import(pathToFileURL(`${ROOT}/lib/doctor-agent.js`).href);

console.log('\n=== 会话身份 ===');
{
  eq(mod.SESSION_PREFIX, 'framework-doctor:', '前缀固定');
  ok(mod.isDoctorSession('framework-doctor:d-loowaworkspeas'), '认得自己的会话');
  ok(mod.isDoctorSession('framework-doctor:default'), '认得 default');
  ok(!mod.isDoctorSession('session-abc'), '不认别人的会话');
  ok(!mod.isDoctorSession(''), '空串不算');
  ok(!mod.isDoctorSession(null), 'null 不算');

  const a = mod.doctorSessionId('D:\\loowaworkspeas');
  const b = mod.doctorSessionId('D:\\loowaworkspeas');
  eq(a, b, '同一目录 → 同一会话（保留上下文）');

  const c = mod.doctorSessionId('D:\\other');
  ok(a !== c, '不同目录 → 不同会话');

  ok(a.startsWith('framework-doctor:'), '生成 id 带前缀');
  ok(!/[:\\/]/.test(a.slice('framework-doctor:'.length)), 'id 主体不含路径分隔符', a);

  eq(mod.doctorSessionId(''), 'framework-doctor:default', '空目录退化成 default');
  eq(mod.doctorSessionId(undefined), 'framework-doctor:default', 'undefined 退化成 default');

  // 超长路径要截断
  const long = mod.doctorSessionId('D:\\' + 'a'.repeat(200));
  ok(long.length < 80, '超长路径被截断', long.length);
}

console.log('\n=== transcript 投影 ===');
{
  const events = [
    { type: 'message/user', time: 1, data: { message: { role: 'user', content: [{ type: 'text', text: '框架有什么问题？' }] } } },
    { type: 'tool/call', time: 2, data: { message: { source: { name: 'diagnose' } } } },
    { type: 'message/assistant', time: 3, data: { message: { role: 'assistant', content: [{ type: 'text', text: '有两个警告。' }] } } },
  ];
  const rows = mod.projectTranscript(events);
  eq(rows.length, 3, '三条都投影出来');
  eq(rows[0].role, 'user', '第一条是用户');
  eq(rows[0].text, '框架有什么问题？', '用户文字正确');
  eq(rows[1].role, 'tool', '第二条是工具');
  eq(rows[1].tool, 'diagnose', '工具名正确');
  eq(rows[2].role, 'assistant', '第三条是助手');
  eq(rows[2].text, '有两个警告。', '助手文字正确');

  // 空/坏数据不炸
  eq(mod.projectTranscript(null).length, 0, 'null 返回空');
  eq(mod.projectTranscript([]).length, 0, '空数组返回空');
  eq(mod.projectTranscript([null, 'x', 42]).length, 0, '坏条目被跳过');

  // 没有文字的消息不占一行
  const noText = mod.projectTranscript([
    { type: 'message/user', data: { message: { content: [] } } },
  ]);
  eq(noText.length, 0, '没有文字的消息不显示');

  // 多块文本拼接
  const multi = mod.projectTranscript([
    { type: 'message/assistant', data: { message: { content: [
      { type: 'text', text: '第一段。' },
      { type: 'text', text: '第二段。' },
    ] } } },
  ]);
  eq(multi[0].text, '第一段。第二段。', '多块文本拼接');
}

console.log('\n=== describeAgent ===');
{
  const absent = mod.describeAgent(null);
  eq(absent.exists, false, 'null → 不存在');
  eq(absent.busy, false, 'null → 不忙');

  const idle = mod.describeAgent({ id: 'framework-doctor:x', phase: 'idle' });
  eq(idle.exists, true, '有 id → 存在');
  eq(idle.busy, false, 'idle → 不忙');

  const running = mod.describeAgent({ id: 'x', phase: 'streaming' });
  eq(running.busy, true, 'streaming → 忙');

  const stepping = mod.describeAgent({ id: 'x', phase: { kind: 'running' } });
  eq(stepping.busy, true, 'phase 是对象时也能判断');
}

console.log('\n=== Host：agent 不可用时降级 ===');
{
  const host = await import(pathToFileURL(`${ROOT}/index.js`).href);
  const routes = [];
  const ctx = {
    logger: { info() {}, warn() {}, debug() {}, error() {} },
    settings: {
      describe: () => [
        { ns: 'llm-pi-ai', applies: 'live', revision: 1, value: { providers: {} }, user: { providers: {} } },
      ],
      mutate: async () => {},
    },
    effect(fn) { const d = fn(); return () => { if (typeof d === 'function') d(); }; },
    on() { return () => {}; },
    get(name) {
      if (name === 'llm') {
        return {
          listProviders: () => [],
          stream: () => (async function* () {
            yield { type: 'text-delta', index: 0, text: '兜底回答。' };
            yield { type: 'finish', reason: { kind: 'stop' } };
          })(),
        };
      }
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'def', model: 'dm' }) };
      if (name === 'credentials') return { describe: async () => ({ configured: true }) };
      // 故意不给 agents：模拟 agent 服务缺失
      return undefined;
    },
    inject(deps, cb) {
      if (deps.includes('webServer')) {
        cb({ webServer: { register: (r) => { routes.push(r); return () => {}; } }, effect: (fn) => { fn(); return () => {}; } });
      }
    },
  };
  host.apply(ctx, { enabled: true });

  const route = routes.find((r) => r.kind === 'prefix');
  ok(Boolean(route), '路由已注册');

  /** 发一个请求并等响应。 */
  async function call(method, path, body) {
    const res = { state: { status: 0, body: '' }, writeHead(s) { this.state.status = s; }, end(b) { this.state.body = String(b ?? ''); } };
    const listeners = new Map();
    const req = {
      method, url: path, headers: { host: '127.0.0.1:55580' },
      on(e, f) {
        listeners.set(e, f);
        if (e === 'end') {
          setTimeout(() => {
            if (body !== undefined) listeners.get('data')?.(Buffer.from(JSON.stringify(body)));
            listeners.get('end')?.();
          }, 0);
        }
        return req;
      },
      destroy() {},
    };
    route.handler(req, res);
    for (let i = 0; i < 400 && !res.state.body; i += 1) await new Promise((r) => setTimeout(r, 10));
    return { status: res.state.status, json: (() => { try { return JSON.parse(res.state.body); } catch { return null; } })() };
  }

  const chat = await call('POST', '/api/framework-doctor/chat', { message: '有什么问题' });
  eq(chat.status, 200, 'agent 不可用时仍返回 200（降级成功）');
  eq(chat.json?.ok, true, '降级后 ok:true');
  eq(chat.json?.degraded, true, '标记为降级模式');
  ok(typeof chat.json?.degradedReason === 'string' && chat.json.degradedReason.length > 0, '带上降级原因', chat.json?.degradedReason);
  ok(String(chat.json?.reply || '').length > 0, '兜底仍然回答了内容');

  // /chat/state 在没有 agent 时应该安静返回 exists:false
  const state = await call('GET', '/api/framework-doctor/chat/state');
  eq(state.status, 200, 'state 接口 200');
  eq(state.json?.agent?.exists, false, '没有会话时 exists:false');
  eq(Array.isArray(state.json?.transcript), true, 'transcript 是数组');

  // /chat/stop 在没有会话时不应该报错
  const stop = await call('POST', '/api/framework-doctor/chat/stop', {});
  eq(stop.status, 200, 'stop 接口 200');
  eq(stop.json?.stopped, false, '没有会话时 stopped:false');
}

console.log('\n=== Host：agent 可用时走真通道 ===');
{
  const host = await import(pathToFileURL(`${ROOT}/index.js`).href);
  const routes = [];
  const created = [];
  const sent = [];
  const fakeAgent = {
    id: 'framework-doctor:d-loowaworkspeas',
    phase: 'idle',
    session: {
      snapshotEvents: () => [
        { type: 'message/user', time: 1, data: { message: { content: [{ type: 'text', text: '问' }] } } },
        { type: 'message/assistant', time: 2, data: { message: { content: [{ type: 'text', text: '答' }] } } },
      ],
    },
    async send(content) { sent.push(content); },
    async whenIdle() { return undefined; },
    cancel() {},
  };
  const ctx = {
    logger: { info() {}, warn() {}, debug() {}, error() {} },
    settings: {
      describe: () => [
        { ns: 'llm-pi-ai', applies: 'live', revision: 1, value: { providers: {} }, user: { providers: {} } },
      ],
      mutate: async () => {},
    },
    effect(fn) { const d = fn(); return () => { if (typeof d === 'function') d(); }; },
    on() { return () => {}; },
    get(name) {
      if (name === 'agents') {
        return {
          get: () => undefined,
          list: () => [],
          async create(options) { created.push(options); return fakeAgent; },
        };
      }
      if (name === 'llm') return { listProviders: () => [] };
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'def', model: 'dm' }) };
      if (name === 'credentials') return { describe: async () => ({ configured: true }) };
      return undefined;
    },
    inject(deps, cb) {
      if (deps.includes('webServer')) {
        cb({
          webServer: { register: (r) => { routes.push(r); return () => {}; } },
          effect: (fn) => { const d = fn(); return () => { if (typeof d === 'function') d(); }; },
        });
      }
    },
  };
  host.apply(ctx, { enabled: true });
  const route = routes.find((r) => r.kind === 'prefix');

  async function call(method, path, body) {
    const res = { state: { status: 0, body: '' }, writeHead(s) { this.state.status = s; }, end(b) { this.state.body = String(b ?? ''); } };
    const listeners = new Map();
    const req = {
      method, url: path, headers: { host: '127.0.0.1:55580' },
      on(e, f) {
        listeners.set(e, f);
        if (e === 'end') {
          setTimeout(() => {
            if (body !== undefined) listeners.get('data')?.(Buffer.from(JSON.stringify(body)));
            listeners.get('end')?.();
          }, 0);
        }
        return req;
      },
      destroy() {},
    };
    route.handler(req, res);
    for (let i = 0; i < 400 && !res.state.body; i += 1) await new Promise((r) => setTimeout(r, 10));
    return { status: res.state.status, json: (() => { try { return JSON.parse(res.state.body); } catch { return null; } })() };
  }

  const reply = await call('POST', '/api/framework-doctor/chat', { message: '框架有什么问题' });
  eq(reply.status, 200, '真 agent 通道返回 200');
  eq(reply.json?.ok, true, 'ok:true');
  eq(reply.json?.degraded, undefined, '不是降级模式');
  eq(created.length, 1, '创建了一个会话');
  // 会话 id 由 cwd 派生；这里没传 cwd，所以用 process.cwd()（即插件目录）。
  ok(
    String(created[0].sessionId).startsWith('framework-doctor:'),
    '会话 id 带正确前缀',
    created[0].sessionId,
  );
  eq(created[0].sessionId, mod.doctorSessionId(process.cwd()), '会话 id 与 cwd 派生一致');
  ok(Array.isArray(created[0].seed) && created[0].seed.length > 0, '带上了身份说明 seed');
  eq(sent.length, 1, '投递了一条消息');
  eq(reply.json?.transcript?.length, 2, 'transcript 来自 session 事件');
  eq(reply.json?.transcript?.[0]?.role, 'user', '第一条是用户');
  eq(reply.json?.transcript?.[1]?.role, 'assistant', '第二条是助手');
}

console.log(`\n${failures === 0 ? '全部通过' : '有失败'}：${checks - failures}/${checks} 项通过`);
if (failures > 0) process.exitCode = 1;