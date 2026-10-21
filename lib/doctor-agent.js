/**
 * 把框架医生的对话框接到**真正的 agent** 上。
 *
 * 之前那个 chat 是我手搓的：自己拼 system prompt、自己解析 TOOL 行、自己跑
 * 循环。它能用，但和正式对话栏比是残废的——没有真工具、没有真流式、没有
 * 上下文压缩、没有审批、也没有故障转移之外的重试策略。
 *
 * 现在改成开一个**真 agent**：它跑在 harness 自己的 agent loop 上，
 * 工具、流式、压缩、审批、故障转移全部继承，我们只负责
 *
 *   1. 创建（或复用）一个专用会话；
 *   2. 把用户输入投递进去；
 *   3. 把 session 事件转发给页面。
 *
 * 关键 API（运行时反射确认，不是猜的）：
 *   ctx.agents.create({ sessionId, seed, meta, agentOptions, setup, parentAgent })
 *   ctx.agents.resume({ ... })
 *   ctx.agents.get(sessionId) / list()
 *   agent.send / inject / followup / steer / kick / turn / step / whenIdle / cancel
 *   agent.session.snapshotEvents() / ownEvents() / deriveMessages()
 *
 * 会话身份用固定前缀 `framework-doctor:`，这样我们能认出自己的会话，
 * 不会和用户正经对话混在一起。
 */

/** 框架医生会话的 id 前缀。 */
export const SESSION_PREFIX = 'framework-doctor:';

/** 这个 agent 的身份说明，作为会话 seed 的一部分。 */
export const DOCTOR_BRIEF = [
  '你是 DSH「框架医生」页面里的诊断助手。',
  '',
  '你的职责：帮用户看护这个 harness 的模型配置与运行健康。',
  '',
  '工作方式：',
  '1. 先用只读工具查证，再下结论。不要凭印象猜配置长什么样。',
  '2. 你能看到：providers 配置、插件加载状态、工具清单、渠道健康档案、',
  '   渠道插件的本地缓存（失效原因、限流状态）、Our Free Model 的 combo 链。',
  '3. 发现问题的价值在于**说清楚该怎么办**，而不只是报告"有问题"。',
  '4. 写操作要么给出可点击的动作，要么明确告诉用户去哪个页面改；',
  '   不要假装已经改好了。',
  '5. 用大白话。先讲最要紧的，再讲细节。',
].join('\n');

/**
 * 这个 sessionId 是不是框架医生自己的会话。
 *
 * @param {unknown} id
 * @returns {boolean}
 */
export function isDoctorSession(id) {
  return typeof id === 'string' && id.startsWith(SESSION_PREFIX);
}

/**
 * 为一个工作目录生成稳定的会话 id。
 *
 * 同一个工作目录复用同一个会话，这样用户上次问过的内容还在；
 * 想重新开始就换目录或者显式重置。
 *
 * @param {string} [cwd]
 * @returns {string}
 */
export function doctorSessionId(cwd) {
  const key = typeof cwd === 'string' && cwd.length > 0 ? cwd : 'default';
  // 只保留安全字符，避免路径里的冒号/反斜杠弄坏 id
  const slug = key
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `${SESSION_PREFIX}${slug || 'default'}`;
}

/**
 * 从 session 事件里抽出给页面显示的对话行。
 *
 * 不自己维护消息数组：直接读 session 的事件流，这样页面看到的就是
 * agent 真正记录下来的东西，刷新/重连也不会丢。
 *
 * 只保留能展示的部分：用户输入、助手文字、工具调用与结果摘要。
 *
 * @param {object[]} events
 * @returns {Array<{role: string, text: string, tool?: string, at?: number}>}
 */
export function projectTranscript(events) {
  if (!Array.isArray(events)) return [];
  const rows = [];
  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    const type = event.type ?? event.kind;
    const data = event.data ?? event;

    if (type === 'message/user' || type === 'user/message') {
      const text = textOf(data.message ?? data);
      if (text) rows.push({ role: 'user', text, at: event.time });
      continue;
    }
    if (type === 'message/assistant' || type === 'assistant/message') {
      const text = textOf(data.message ?? data);
      if (text) rows.push({ role: 'assistant', text, at: event.time });
      continue;
    }
    if (type === 'tool/call') {
      const name = data.message?.source?.name ?? data.name ?? data.toolName ?? 'tool';
      rows.push({ role: 'tool', text: '', tool: String(name), at: event.time });
      continue;
    }
  }
  return rows;
}

/** 从消息对象里取纯文本（content 可能是块数组）。 */
function textOf(message) {
  if (!message || typeof message !== 'object') return '';
  const content = message.content;
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('').trim();
}

/**
 * 给页面用的状态摘要：这个会话现在在干什么。
 *
 * @param {object|null} agent
 * @returns {{exists: boolean, id: string, phase: string, busy: boolean}}
 */
export function describeAgent(agent) {
  if (!agent) return { exists: false, id: '', phase: 'absent', busy: false };
  const phase = typeof agent.phase === 'string' ? agent.phase : String(agent.phase?.kind ?? 'unknown');
  return {
    exists: true,
    id: String(agent.id ?? ''),
    phase,
    // phase 里出现这些说明还在跑
    busy: /running|stepping|thinking|streaming|waiting/i.test(phase),
  };
}
