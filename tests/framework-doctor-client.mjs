/**
 * 框架医生 —— 浏览器端自测
 *
 * 在 Node 里桩出 `window.__ModuleLoader__`、`document`、`react`，
 * 把 client.js 加载起来，然后把三个区真的渲染一遍。
 *
 * 目的：抓住"插件一注册就白屏"这类问题 —— 组件崩溃会连累整个设置页，
 * 必须在安装前用桩跑通渲染，而不是装完等用户发现。
 *
 * 用法：node tests/framework-doctor-client.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let failures = 0;
let checks = 0;

function ok(condition, label, detail) {
  checks += 1;
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${String(JSON.stringify(detail)).slice(0, 600)}`}`);
  }
}

function eq(actual, expected, label) {
  ok(Object.is(actual, expected), label, { actual, expected });
}

/* ------------------------------------------------------------------ *
 * 桩：React
 *
 * 只需要让 createElement 产出可遍历的普通对象、hooks 能跑。
 * 不模拟真实渲染，但足以验证"组件函数执行时不抛错"。
 * ------------------------------------------------------------------ */

let hookCursor = 0;
const hookStore = [];

function makeReactStub() {
  /** 极简 class 组件基类：error boundary 会 extends React.Component。 */
  class Component {
    constructor(props) {
      this.props = props ?? {};
      this.state = {};
      this.context = undefined;
    }
    setState(next, callback) {
      const patch = typeof next === 'function' ? next(this.state, this.props) : next;
      this.state = { ...this.state, ...(patch ?? {}) };
      if (typeof callback === 'function') callback();
    }
    forceUpdate(callback) {
      if (typeof callback === 'function') callback();
    }
    componentDidMount() {}
    componentDidUpdate() {}
    componentWillUnmount() {}
    render() {
      return null;
    }
  }

  class PureComponent extends Component {}

  return {
    Component,
    PureComponent,
    createElement(type, props, ...children) {
      return { type, props: { ...(props ?? {}), children: children.length === 1 ? children[0] : children } };
    },
    Fragment: Symbol.for('react.fragment'),
    useState(initial) {
      const index = hookCursor;
      hookCursor += 1;
      if (!(index in hookStore)) hookStore[index] = typeof initial === 'function' ? initial() : initial;
      const set = (next) => {
        hookStore[index] = typeof next === 'function' ? next(hookStore[index]) : next;
      };
      return [hookStore[index], set];
    },
    useReducer(reducer, initial) {
      const index = hookCursor;
      hookCursor += 1;
      if (!(index in hookStore)) hookStore[index] = initial;
      const dispatch = (action) => {
        hookStore[index] = reducer(hookStore[index], action);
      };
      return [hookStore[index], dispatch];
    },
    useEffect(fn) {
      // 不执行副作用：渲染期不该依赖它们
      void fn;
    },
    useLayoutEffect(fn) {
      void fn;
    },
    useMemo(fn, deps) {
      void deps;
      return fn();
    },
    useCallback(fn) {
      return fn;
    },
    useRef(initial) {
      return { current: initial };
    },
    useId() {
      return 'test-id';
    },
    useSyncExternalStore(_subscribe, getSnapshot) {
      return getSnapshot();
    },
    createContext(defaultValue) {
      return { _currentValue: defaultValue, Provider: 'Provider', Consumer: 'Consumer' };
    },
    memo(component) {
      return component;
    },
    forwardRef(render) {
      return (props) => render(props, { current: null });
    },
    Children: {
      map(children, fn) {
        if (Array.isArray(children)) return children.map((child, index) => fn(child, index));
        return children === undefined || children === null ? [] : [fn(children, 0)];
      },
      toArray(children) {
        if (children === undefined || children === null) return [];
        return Array.isArray(children) ? children : [children];
      },
      only(children) {
        return children;
      },
      count(children) {
        if (children === undefined || children === null) return 0;
        return Array.isArray(children) ? children.length : 1;
      },
    },
    isValidElement(value) {
      return Boolean(value) && typeof value === 'object' && 'props' in value;
    },
    cloneElement(element, props) {
      return { ...element, props: { ...element.props, ...props } };
    },
  };
}

/* ------------------------------------------------------------------ *
 * 桩：document / window / fetch
 * ------------------------------------------------------------------ */

const styleTags = [];

const documentStub = {
  baseURI: 'http://127.0.0.1:58814/',
  head: {
    appendChild(node) {
      styleTags.push(node);
      return node;
    },
  },
  body: {
    appendChild() {
      throw new Error('插件不应该往 document.body 追加节点');
    },
  },
  createElement(tag) {
    return { tagName: tag, dataset: {}, textContent: '', setAttribute() {}, appendChild() {} };
  },
  querySelector() {
    return null;
  },
  querySelectorAll() {
    return [];
  },
  addEventListener() {},
  removeEventListener() {},
  getElementById() {
    return null;
  },
};

const fetchCalls = [];

function makeFetchStub() {
  return async function fetchStub(input, init) {
    const url = typeof input === 'string' ? input : String(input?.url ?? input);
    fetchCalls.push({ url, method: init?.method ?? 'GET' });
    const path = String(url);
    let payload = { ok: true };

    if (path.includes('/state')) {
      payload = {
        ok: true,
        providers: [
          {
            route: 'demo-gateway',
            displayName: '演示网关',
            api: 'openai-completions',
            baseURL: 'https://api.example.com/v1',
            hasApiKeyEnv: true,
            apiKeyEnv: 'DEMO_API_KEY',
            modelCount: 2,
            models: [
              {
                id: 'deepseek-reasoner',
                name: 'DeepSeek Reasoner',
                input: ['text'],
                contextWindow: 131072,
                maxTokens: 65536,
                hasReasoningEfforts: true,
                reasoningEfforts: { off: null, low: 'low', medium: 'medium', high: 'high' },
              },
              { id: 'gpt-4o', name: 'GPT-4o', input: ['text', 'image'], contextWindow: 128000, maxTokens: 16384, hasReasoningEfforts: true, reasoningEfforts: false },
            ],
          },
        ],
        defaultSelection: { provider: 'demo-gateway', model: 'gpt-4o', reasoningEffort: null },
        credentialState: { DEMO_API_KEY: { configured: true, source: 'store' } },
        llmProviders: [{ id: 'demo-gateway', name: '演示网关' }],
        plugins: [{ entryId: 'demo-gateway', moduleName: 'x', enabled: true, fiberPhase: 'active' }],
        lastScanAt: null,
        health: null,
        summary: null,
        config: { autoScan: true, scanIntervalMs: 600000 },
      };
    } else if (path.includes('/probe')) {
      payload = {
        ok: true,
        endpoint: 'https://api.example.com/v1/models',
        triedEndpoints: ['https://api.example.com/v1/models'],
        hasKey: true,
        warnings: [],
        models: [
          {
            id: 'qwen3-max',
            name: 'Qwen3 Max',
            input: ['text'],
            contextWindow: 262144,
            maxTokens: 32768,
            reasoningEfforts: { off: null, low: 'low', medium: 'medium', high: 'high' },
            compat: { thinkingFormat: 'qwen-chat-template', supportsReasoningEffort: true },
            confidence: 'inferred',
            notes: ['按家族推测'],
          },
        ],
      };
    } else if (path.includes('/diagnose')) {
      payload = {
        ok: true,
        health: 76,
        summary: { fatal: 1, warn: 1, info: 1, total: 3, repairable: 2 },
        scannedAt: new Date().toISOString(),
        warnings: [],
        checked: { config: true, runtime: true, credentials: true },
        findings: [
          {
            id: 'no-credential/demo-gateway',
            severity: 'fatal',
            scope: 'provider',
            route: 'demo-gateway',
            title: '没有可用凭据',
            detail: '这个提供方既没有 apiKeyEnv 也没有 Authorization 头，请求会在构造阶段直接失败。',
            repair: { kind: 'set-credential-ref', payload: { route: 'demo-gateway' } },
          },
          {
            id: 'missing-input/demo-gateway/gpt-4o',
            severity: 'warn',
            scope: 'model',
            route: 'demo-gateway',
            modelId: 'gpt-4o',
            title: '没声明输入模态',
            detail: '会回退到纯文本，模型支持看图的话图片会在本地被拦。',
            repair: { kind: 'infer-input', payload: { route: 'demo-gateway', modelId: 'gpt-4o' } },
          },
          {
            id: 'missing-max-tokens/demo-gateway/gpt-4o',
            severity: 'info',
            scope: 'model',
            route: 'demo-gateway',
            modelId: 'gpt-4o',
            title: '没有声明输出上限',
            detail: '会回退到默认值。',
            repair: { kind: 'infer-max-tokens', payload: { route: 'demo-gateway', modelId: 'gpt-4o' } },
          },
        ],
      };
    } else if (path.includes('/repair')) {
      payload = {
        ok: true,
        dryRun: false,
        planned: 2,
        applied: [{ findingId: 'missing-input/demo-gateway/gpt-4o', status: 'applied' }],
        skipped: [{ findingId: 'no-credential/demo-gateway', title: '没有可用凭据', reason: '请到凭据页填写密钥' }],
        failed: [],
        probeErrors: {},
      };
    } else if (path.includes('/apply')) {
      payload = { ok: true, route: 'demo-gateway', written: 1, models: ['qwen3-max'], note: '密钥已存入凭据服务' };
    }

    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify(payload);
      },
      async json() {
        return payload;
      },
    };
  };
}

/* ------------------------------------------------------------------ *
 * 装配全局环境并加载 client.js
 * ------------------------------------------------------------------ */

const loaded = { module: null };

globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      loaded.module = definition;
    },
  },
  fetch: makeFetchStub(),
  location: { href: 'http://127.0.0.1:58814/' },
  addEventListener() {},
  removeEventListener() {},
  matchMedia() {
    return { matches: false, addEventListener() {}, removeEventListener() {} };
  },
  setTimeout,
  clearTimeout,
};
globalThis.document = documentStub;
globalThis.fetch = globalThis.window.fetch;
globalThis.AbortController = AbortController;
globalThis.setTimeout = setTimeout;
globalThis.clearTimeout = clearTimeout;

console.log('=== 加载 client.js ===');
const CLIENT = fileURLToPath(new URL('../client.js', import.meta.url));
const source = readFileSync(CLIENT, 'utf8');

// 编码与硬约束静态检查
{
  const mojibake = (source.match(/[鍏銆鐢閰瑕鏄涓浜]/g) || []).length;
  eq(mojibake, 0, 'client.js 没有编码损坏');
  const cjk = (source.match(/[\u4e00-\u9fff]/g) || []).length;
  ok(cjk > 100, '中文文案充足', cjk);
  ok(!/\bimport\s+.*from\s+['"]@deepseek-ai/.test(source), '没有 import @deepseek-ai 包');
  ok(!/require\(\s*['"]@deepseek-ai/.test(source), '没有 require @deepseek-ai 包');
  ok(!/document\.body\.appendChild/.test(source), '没有往 document.body 追加节点');
  // 硬编码颜色检查（图标/白色文字除外，只查十六进制色值出现在 CSS 里）
  const hexColors = (source.match(/#[0-9a-fA-F]{6}\b/g) || []).filter((c) => !/^#(fff|ffffff|000|000000)$/i.test(c));
  ok(hexColors.length === 0, 'CSS 里没有硬编码颜色（只用主题 token）', hexColors.slice(0, 8));
}

try {
  await import(`file:///${CLIENT.replace(/\\/g, '/')}`);
  ok(true, 'client.js 可被加载');
} catch (error) {
  ok(false, 'client.js 可被加载', error.message);
  process.exit(1);
}

ok(Boolean(loaded.module), '调用了 window.__ModuleLoader__.load');
eq(loaded.module?.id, 'dsh-framework-doctor', '模块 id 正确');
ok(typeof loaded.module?.factory === 'function', 'factory 是函数');

/* ------------------------------------------------------------------ *
 * factory 产物
 * ------------------------------------------------------------------ */

console.log('=== factory 产物 ===');
const reactStub = makeReactStub();
const requireStub = (id) => {
  if (id === 'react') return reactStub;
  throw new Error(`不允许 require(${JSON.stringify(id)})`);
};

let plugin;
try {
  plugin = loaded.module.factory(requireStub);
  ok(true, 'factory 执行不抛错');
} catch (error) {
  ok(false, 'factory 执行不抛错', error.message);
  process.exit(1);
}

eq(plugin?.name, 'framework-doctor', 'name 正确');
ok(Array.isArray(plugin?.inject), 'inject 是数组', plugin?.inject);
ok(plugin?.inject?.includes('slots'), 'inject 含 slots');
ok(plugin?.inject?.includes('locale'), 'inject 含 locale');
ok(typeof plugin?.apply === 'function', 'apply 是函数');

/* ------------------------------------------------------------------ *
 * apply：槽位注册
 * ------------------------------------------------------------------ */

console.log('=== apply：槽位注册 ===');
const registrations = [];
const dictionaries = [];
let styleInserted = 0;

const ctx = {
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  effect(fn, label) {
    void label;
    const dispose = typeof fn === 'function' ? fn() : undefined;
    return () => {
      if (typeof dispose === 'function') dispose();
    };
  },
  on() {
    return () => {};
  },
  get() {
    return undefined;
  },
  locale: {
    register(ns, dicts) {
      dictionaries.push({ ns, dicts });
      return () => {};
    },
    getLocale() {
      return { id: 'zh-CN', locale: 'zh' };
    },
    getSnapshot() {
      return { id: 'zh-CN', locale: 'zh' };
    },
    subscribe() {
      return () => {};
    },
    bind() {
      return (key) => key;
    },
  },
  slots: {
    inject(key, callback) {
      const effect = callback();
      registrations.push({ key, effect });
      return () => {};
    },
    register(options, component) {
      registrations.push({ kind: 'register', options, component });
      return () => {};
    },
  },
};

try {
  plugin.apply(ctx);
  ok(true, 'apply 执行不抛错');
} catch (error) {
  ok(false, 'apply 执行不抛错', error.message);
  process.exit(1);
}

const sectionReg = registrations.find((r) => r.kind === 'register' && r.options?.name === 'settings.section');
ok(Boolean(sectionReg), '注册了 settings.section 槽位', registrations.map((r) => r.options?.name ?? r.key));
eq(sectionReg?.options?.id, 'framework-doctor', '槽位 id 正确');
eq(sectionReg?.options?.order, 42, '槽位 order 是 42');
ok(typeof sectionReg?.options?.label === 'function', 'label 是函数（走 locale）');
ok(typeof sectionReg?.component === 'function', '槽位注册了组件');

ok(dictionaries.length > 0, '注册了 locale 词典', dictionaries.length);
const dict = dictionaries[0]?.dicts;
ok(Boolean(dict?.zh), '有中文词典');
ok(Boolean(dict?.en), '有英文词典');
ok(Object.keys(dict?.zh ?? {}).length > 20, '中文词典条目充足', Object.keys(dict?.zh ?? {}).length);

ok(styleTags.length <= 1, 'CSS 只注入了一次', styleTags.length);

/* ------------------------------------------------------------------ *
 * 渲染：真的把组件跑一遍
 * ------------------------------------------------------------------ */

console.log('=== 渲染主组件 ===');

/** 递归渲染，遇到函数组件就调用它。深度受限，避免死循环。 */
function renderTree(node, depth = 0) {
  if (depth > 40) return { rendered: true, depth: 'max' };
  if (node === null || node === undefined || typeof node === 'boolean') return node;
  if (typeof node === 'string' || typeof node === 'number') return node;
  if (Array.isArray(node)) return node.map((child) => renderTree(child, depth + 1));
  if (typeof node === 'function') {
    return renderTree(node({}), depth + 1);
  }
  if (typeof node === 'object' && node.type) {
    // class 组件：实例化并调用 render
    if (typeof node.type === 'function' && node.type.prototype && typeof node.type.prototype.render === 'function') {
      const instance = new node.type(node.props ?? {});
      instance.props = node.props ?? {};
      instance.state = typeof instance.state === 'object' && instance.state !== null ? instance.state : {};
      instance.setState = (next) => {
        instance.state = { ...instance.state, ...(typeof next === 'function' ? next(instance.state) : next) };
      };
      if (typeof instance.componentDidMount === 'function') {
        try {
          instance.componentDidMount();
        } catch {
          /* 挂载钩子失败不该算渲染失败 */
        }
      }
      return renderTree(instance.render(), depth + 1);
    }
    if (typeof node.type === 'function') {
      hookCursor = 0;
      return renderTree(node.type(node.props ?? {}), depth + 1);
    }
    return { host: node.type, props: node.props };
  }
  return node;
}

{
  hookCursor = 0;
  hookStore.length = 0;
  let tree;
  try {
    const props = {
      // 常见的槽位 props：给一份最小集合，缺的由组件自己兜底
      sessionId: undefined,
      locale: 'zh',
      ctx,
    };
    tree = sectionReg.component(props);
    ok(true, '主组件函数执行不抛错');
    const rendered = renderTree(tree);
    ok(rendered !== undefined, '主组件产出了可渲染的树');
  } catch (error) {
    ok(false, '主组件函数执行不抛错', `${error.message}\n${error.stack?.split('\n').slice(0, 6).join('\n')}`);
  }
}

/* ------------------------------------------------------------------ *
 * 渲染：三个区分别跑
 *
 * 组件是内部闭包，从外部拿不到。所以这里改成"从注册的组件出发，
 * 递归渲染整棵树"，任何一层抛错都会在这里暴露。
 * ------------------------------------------------------------------ */

console.log('=== 渲染完整树（含三个区） ===');
{
  hookCursor = 0;
  hookStore.length = 0;
  let error = null;
  try {
    const tree = sectionReg.component({ sessionId: undefined, locale: 'zh', ctx });
    // 深度遍历所有节点，把每个函数组件都真的调用一次
    // 深度遍历所有节点，把每个函数组件都真的调用一次。
    //
    // 关键：hook 槽位必须**按组件实例**隔离。真实 React 里每个组件有自己的
    // hook 链表；这里如果所有组件共用一个 cursor，B 组件会读到 A 组件的 state，
    // 出现"models 是 undefined"这类假失败。所以每个组件调用前重置 cursor，
    // 并把该组件自己的槽位存进 map，保证同一组件的多次调用看到同一份 state。
    const hookChains = new Map();
    const visited = new Set();
    const walk = (node, depth) => {
      if (depth > 30 || node === null || node === undefined || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        for (const child of node) walk(child, depth + 1);
        return;
      }
      if (node.type && typeof node.type === 'function' && !visited.has(node.type)) {
        visited.add(node.type);
        if (node.type.prototype && typeof node.type.prototype.render === 'function') {
          const instance = new node.type(node.props ?? {});
          instance.props = node.props ?? {};
          instance.state = instance.state ?? {};
          instance.setState = () => {};
          walk(instance.render(), depth + 1);
        } else {
          const key = node.type;
          if (!hookChains.has(key)) hookChains.set(key, { store: [], cursor: 0 });
          const chain = hookChains.get(key);
          const previousStore = hookStore.slice();
          const previousCursor = hookCursor;
          hookStore.length = 0;
          hookStore.push(...chain.store);
          hookCursor = 0;
          try {
            const rendered = node.type(node.props ?? {});
            chain.store = hookStore.slice();
            walk(rendered, depth + 1);
          } catch (inner) {
            if (!error) error = inner;
          } finally {
            hookStore.length = 0;
            hookStore.push(...previousStore);
            hookCursor = previousCursor;
          }
        }
        return;
      }
      if (node.props) walk(node.props.children, depth + 1);
    };
    walk(tree, 0);
    ok(true, `深度遍历了 ${visited.size} 个组件`);
  } catch (outer) {
    error = outer;
  }
  if (error) {
    ok(false, '完整树遍历无致命错误', `${error.message}\n${error.stack?.split('\n').slice(0, 6).join('\n')}`);
  } else {
    ok(true, '完整树遍历无致命错误');
  }
}

/* ------------------------------------------------------------------ *
 * 静态检查：三区与 API 端点都在
 * ------------------------------------------------------------------ */

console.log('=== 静态检查：三区与端点 ===');
{
  for (const endpoint of ['/state', '/probe', '/diagnose', '/apply', '/repair', '/chat']) {
    ok(source.includes(endpoint), `代码里引用了 ${endpoint}`);
  }
  ok(/sectionChat/.test(source), '注册了对话区');
  ok(/__fd_chatInput/.test(source), '有对话框输入区');
  ok(/settings\.section/.test(source), '注册了 settings.section');
  ok(/componentDidCatch/.test(source), '有 error boundary');
  const boundaryCount = (source.match(/componentDidCatch/g) || []).length;
  ok(boundaryCount >= 1, 'error boundary 存在', boundaryCount);
  ok(/AbortController/.test(source), 'fetch 带 AbortController 超时');
  ok(/(--dsw-alias-[a-z0-9-]+)/.test(source), '使用了主题 token');
  const tokens = new Set((source.match(/--dsw-alias-[a-z0-9-]+/g) || []));
  const allowed = new Set([
    '--dsw-alias-bg-base',
    '--dsw-alias-bg-layer-1',
    '--dsw-alias-bg-layer-2',
    '--dsw-alias-bg-layer-3',
    '--dsw-alias-bg-overlay',
    '--dsw-alias-border-l1',
    '--dsw-alias-border-l2',
    '--dsw-alias-brand-primary',
    '--dsw-alias-label-primary',
    '--dsw-alias-label-secondary',
    '--dsw-alias-label-tertiary',
    '--dsw-alias-label-caption',
    '--dsw-alias-state-error-primary',
    '--dsw-alias-state-warn-primary',
    '--dsw-alias-state-success-primary',
    '--dsw-alias-state-idle-primary',
    '--dsw-specific-sidebar-fill',
  ]);
  const unknown = [...tokens].filter((t) => !allowed.has(t));
  ok(unknown.length === 0, '没有使用契约之外的主题 token', unknown);
}

console.log(`\n${failures === 0 ? '全部通过' : '有失败'}：${checks - failures}/${checks} 项通过`);
if (failures > 0) process.exitCode = 1;
