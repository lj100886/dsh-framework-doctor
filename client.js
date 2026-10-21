/**
 * dsh-framework-doctor — 框架医生（浏览器端设置页）
 *
 * 这是一个**独立设置页**，不进入任何会话框：
 *   1. 接入：粘贴一个 baseURL（+ 可选 key）→ 探测端点 → 勾选模型 → 一键写入。
 *      用户不需要理解 contextWindow / reasoningEfforts，表格里用「思考档位：关/低/中/高」
 *      这种人话展示推导结果；置信度低的行灰一档并打「推测」标。
 *   2. 体检：POST /diagnose，致命在最上，按 scope 分组，健康分克制展示。
 *   3. 修复：全部自动修复 / 单条修复，逐条展示 已修复 / 需人工 / 失败原因。
 *
 * 硬约束（照 CONTRACT.md「C. client.js」）：
 *   - 只 require('react')，无 JSX，不 import 任何 @deepseek-ai/* 包
 *   - 只用 --dsw-alias-* 主题 token，无硬编码颜色（暗色模式不瞎）
 *   - CSS 只往 document.head 注入一次 <style data-plugin-css="...">
 *   - 所有 fetch 带 AbortController 超时（默认 8s），失败显示人话而不是白屏
 *   - 每个区各包一层 error boundary（class 组件 componentDidCatch）
 *
 * 参考实现：D:\loomy\dsh-model-console\client.js（同构页面：CSS 注入 / locale / 表格 /
 * 诊断列表 / 无 JSX 写法）与 D:\loomy\dsh-our-free-model\client.js（settings.section
 * 注册、document.baseURI 拼后端地址、带超时的 api()）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-framework-doctor',
  factory: function (require) {
    var react = require('react');
    var h = react.createElement;

    /* ------------------------------------------------------------------ *
     * 样式：只注入一次。全部颜色走 --dsw-alias-* token；token 缺失时只在
     * token 之间回退（不回退到硬编码色值），保证暗色模式不出现白底黑字。
     * ------------------------------------------------------------------ */
    var CSS = `
.__fd_root{width:100%;max-width:960px;display:flex;flex-direction:column;gap:16px;font-size:13px;line-height:1.65;color:var(--dsw-alias-label-primary);--fd-border:var(--dsw-alias-border-l2,var(--dsw-alias-border-l1));--fd-accent:var(--dsw-alias-brand-primary,var(--dsw-alias-label-primary));--fd-ok:var(--dsw-alias-state-success-primary,var(--dsw-alias-label-secondary));--fd-warn:var(--dsw-alias-state-warn-primary,var(--dsw-alias-label-secondary));--fd-bad:var(--dsw-alias-state-error-primary,var(--dsw-alias-label-secondary));--fd-idle:var(--dsw-alias-state-idle-primary,var(--dsw-alias-label-tertiary))}
.__fd_root *{box-sizing:border-box;min-width:0}
.__fd_root p{margin:0}
.__fd_root h3{margin:0;font-size:15px;font-weight:600}
.__fd_root .__fd_head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap}
.__fd_root .__fd_stats{display:flex;gap:14px;flex-wrap:wrap;color:var(--dsw-alias-label-secondary);font-size:12px}
.__fd_root .__fd_stats b{color:var(--dsw-alias-label-primary);font-weight:600;font-variant-numeric:tabular-nums}
.__fd_root .__fd_hint{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.__fd_root .__fd_url{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;color:var(--dsw-alias-label-tertiary);word-break:break-all}
.__fd_root .__fd_muted{color:var(--dsw-alias-label-tertiary)}
.__fd_root .__fd_error{font-size:12px;color:var(--fd-bad)}
.__fd_root .__fd_okText{font-size:12px;color:var(--fd-ok)}
.__fd_root .__fd_section{border:1px solid var(--fd-border);border-radius:10px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}
.__fd_root .__fd_secHead{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:11px 14px;border-bottom:1px solid var(--fd-border);background:var(--dsw-alias-bg-layer-1)}
.__fd_root .__fd_secTitle{font-weight:600;font-size:13px}
.__fd_root .__fd_secBody{padding:14px;display:flex;flex-direction:column;gap:12px}
.__fd_root .__fd_grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px}
.__fd_root .__fd_existing{padding:10px 12px;margin-bottom:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);display:flex;flex-direction:column;gap:6px}
.__fd_root .__fd_existing select{width:100%;max-width:520px}
.__fd_root .__fd_field{display:flex;flex-direction:column;gap:4px}
.__fd_root .__fd_field>span{font-size:11px;color:var(--dsw-alias-label-secondary)}
.__fd_root .__fd_field>em{font-style:normal;font-size:11px;color:var(--dsw-alias-label-caption)}
.__fd_root .__fd_actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.__fd_root button{border:1px solid var(--fd-border);background:var(--dsw-alias-bg-layer-1);color:inherit;border-radius:6px;min-height:30px;padding:5px 12px;font:inherit;font-size:12px;cursor:pointer}
.__fd_root button:hover:not(:disabled){border-color:var(--dsw-alias-label-tertiary)}
.__fd_root button:disabled{opacity:.5;cursor:default}
.__fd_root button.__fd_primary{border-color:var(--fd-accent);background:var(--fd-accent);color:var(--dsw-alias-bg-base);font-weight:600}
.__fd_root input[type=text],.__fd_root input[type=password],.__fd_root input[type=number],.__fd_root select{width:100%;border:1px solid var(--fd-border);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:inherit;font:inherit;font-size:12px;padding:6px 9px;min-height:32px}
.__fd_root input[type=checkbox]{accent-color:var(--fd-accent);width:15px;height:15px;margin:0;cursor:pointer}
.__fd_root table{width:100%;border-collapse:collapse}
.__fd_root th,.__fd_root td{text-align:left;padding:7px 9px;border-bottom:1px solid var(--fd-border);vertical-align:top}
.__fd_root th{font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1)}
.__fd_root tr:last-child td{border-bottom:none}
.__fd_root tr.__fd_lowConf td{opacity:.72}
.__fd_root td.__fd_num{font-variant-numeric:tabular-nums;white-space:nowrap}
.__fd_root .__fd_mid{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px}
.__fd_root .__fd_pill{display:inline-block;margin:1px 4px 1px 0;padding:0 6px;border-radius:999px;border:1px solid var(--fd-border);color:var(--dsw-alias-label-secondary);font-size:11px;white-space:nowrap}
.__fd_root .__fd_pill.__fd_pillOn{border-color:var(--fd-accent);color:var(--fd-accent)}
.__fd_root .__fd_chip{display:inline-block;padding:0 8px;border-radius:999px;border:1px solid var(--fd-border);color:var(--dsw-alias-label-secondary);font-size:11px;white-space:nowrap}
.__fd_root .__fd_chipBad{border-color:var(--fd-bad);color:var(--fd-bad)}
.__fd_root .__fd_chipWarn{border-color:var(--fd-warn);color:var(--fd-warn)}
.__fd_root .__fd_chipInfo{border-color:var(--fd-idle);color:var(--dsw-alias-label-secondary)}
.__fd_root .__fd_chipOk{border-color:var(--fd-ok);color:var(--fd-ok)}
.__fd_root .__fd_health{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
.__fd_root .__fd_assist{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);padding:10px 12px;margin-bottom:10px;display:flex;flex-direction:column;gap:8px}
.__fd_root .__fd_assistHead{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
.__fd_root .__fd_assistTitle{font-weight:600;font-size:12px}
.__fd_root .__fd_chain{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.__fd_root .__fd_chainItem{display:inline-flex;align-items:center;gap:6px;padding:3px 9px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;font-size:11px;background:var(--dsw-alias-bg-layer-3)}
.__fd_root .__fd_chainItemFirst{border-color:var(--dsw-alias-brand-primary)}
.__fd_root .__fd_chainItemBad{opacity:.55;border-style:dashed}
.__fd_root .__fd_chainIdx{font-weight:600;color:var(--dsw-alias-label-tertiary)}
.__fd_root .__fd_chainEdit{display:flex;flex-direction:column;gap:6px}
.__fd_root .__fd_chainRow{display:flex;align-items:center;gap:8px}
.__fd_root .__fd_chainRowBad .__fd_select{opacity:.55;border-style:dashed}
.__fd_root .__fd_chainRow .__fd_chainIdx{min-width:14px;text-align:right}
.__fd_root select.__fd_select{flex:1;min-width:0;font-size:12px;padding:4px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-3);color:inherit}
.__fd_root .__fd_chainRemove{width:22px;height:22px;line-height:1;padding:0;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.__fd_root .__fd_chainRemove:hover{color:var(--fd-bad);border-color:var(--fd-bad)}
.__fd_root .__fd_check{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer}
.__fd_root .__fd_saved{font-size:12px;color:var(--fd-ok);margin:0}
.__fd_root .__fd_billing{border-top:1px dashed var(--dsw-alias-border-l1);padding-top:8px;display:flex;flex-direction:column;gap:6px}
.__fd_root .__fd_billingText{font-size:12px;color:var(--dsw-alias-state-warn-primary);margin:0}
.__fd_root .__fd_billingRow{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px}
.__fd_root .__fd_billingLabel{font-weight:600}
.__fd_root .__fd_cache{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);padding:10px 12px;margin-bottom:10px;display:flex;flex-direction:column;gap:8px}
.__fd_root .__fd_cacheRow{display:flex;gap:8px;align-items:flex-start;font-size:12px}
.__fd_root .__fd_chatActions{display:flex;gap:6px;align-items:center}
.__fd_root .__fd_toolRow{display:flex;align-items:center;gap:6px;padding:2px 10px;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.__fd_root .__fd_toolDot{width:5px;height:5px;border-radius:50%;background:var(--dsw-alias-brand-primary);opacity:.6}
.__fd_root .__fd_toolName{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.__fd_root .__fd_report{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;overflow:hidden;margin-bottom:10px}
.__fd_root .__fd_chat{display:flex;flex-direction:column;gap:10px}
.__fd_root .__fd_chatList{display:flex;flex-direction:column;gap:10px;max-height:460px;overflow-y:auto;padding:4px 2px}
.__fd_root .__fd_bubbleRow{display:flex;justify-content:flex-start}
.__fd_root .__fd_bubbleRowMine{justify-content:flex-end}
.__fd_root .__fd_bubble{max-width:82%;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2);padding:8px 12px;display:flex;flex-direction:column;gap:6px}
.__fd_root .__fd_bubbleMine{background:var(--dsw-alias-bg-layer-3)}
.__fd_root .__fd_bubbleWho{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.__fd_root .__fd_bubbleText{font-size:13px;line-height:1.7;white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-primary)}
.__fd_root .__fd_consulted{font-size:11px;color:var(--dsw-alias-label-caption);border-top:1px dashed var(--dsw-alias-border-l1);padding-top:6px}
.__fd_root .__fd_bubbleActions{display:flex;flex-direction:column;gap:6px;border-top:1px solid var(--dsw-alias-border-l1);padding-top:8px}
.__fd_root .__fd_actionRow{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.__fd_root .__fd_chatInput{display:flex;gap:8px;align-items:flex-end}
.__fd_root .__fd_chatInput textarea{flex:1;resize:vertical;min-height:52px}
.__fd_root .__fd_reportHead{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);font-weight:600;font-size:12px}
.__fd_root .__fd_reportBody{padding:12px 14px;font-size:13px;line-height:1.7;white-space:pre-wrap;color:var(--dsw-alias-label-primary)}
.__fd_root .__fd_score{font-size:26px;font-weight:600;line-height:1.1;font-variant-numeric:tabular-nums}
.__fd_root .__fd_scoreOk{color:var(--fd-ok)}
.__fd_root .__fd_scoreWarn{color:var(--fd-warn)}
.__fd_root .__fd_scoreBad{color:var(--fd-bad)}
.__fd_root .__fd_group{display:flex;flex-direction:column;gap:2px}
.__fd_root .__fd_groupHead{font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary);padding:2px 0 4px}
.__fd_root .__fd_finding{display:flex;gap:9px;align-items:flex-start;padding:8px 0;border-bottom:1px dashed var(--fd-border)}
.__fd_root .__fd_finding:last-child{border-bottom:none}
.__fd_root .__fd_findingBody{flex:1;display:flex;flex-direction:column;gap:2px}
.__fd_root .__fd_findingTitle{font-size:12px;font-weight:600;display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.__fd_root .__fd_dot{flex:none;width:7px;height:7px;border-radius:50%;margin-top:6px;background:var(--fd-idle)}
.__fd_root .__fd_dotBad{background:var(--fd-bad)}
.__fd_root .__fd_dotWarn{background:var(--fd-warn)}
.__fd_root .__fd_dotInfo{background:var(--dsw-alias-label-tertiary)}
.__fd_root .__fd_crash{background:var(--dsw-alias-bg-layer-2)}
.__fd_root .__fd_crashTitle{font-weight:600;color:var(--fd-bad)}
`;

    var TAG_ID = 'dsh-framework-doctor/main.css';
    if (typeof document !== 'undefined' && document.head &&
      !document.querySelector('style[data-plugin-css="' + TAG_ID + '"]')) {
      var styleTag = document.createElement('style');
      styleTag.setAttribute('data-plugin-css', TAG_ID);
      styleTag.textContent = CSS;
      document.head.appendChild(styleTag);
    }

    /* ------------------------------------------------------------------ *
     * 文案
     * ------------------------------------------------------------------ */
    var NS = 'frameworkDoctor';
    var zh = {
      nav: '框架医生',
      title: '框架医生',
      intro: '接入模型、检查框架健康度、一键修复。这里是独立设置页，不会占用任何会话。',
      statProviders: '提供方',
      statModels: '模型',
      statHealth: '健康分',
      statLastScan: '上次体检',
      currentRoutes: '已配置 {n} 个提供方',
      loading: '正在读取配置…',
      stateError: '读不到配置',
      retry: '重试',
      boundaryTitle: '这个区块出错了',
      boundaryBody: '已隔离，其余区块照常可用。可以点重试再渲染一次。',
      boundaryRetry: '重试',
      sectionOnboard: '① 接入模型',
      sectionOnboardHint: '给个调用网址，自动配好模型；已有的提供方也能一键探测补齐',
      sectionDiagnose: '② 框架体检',
      sectionDiagnoseHint: '有问题的地方按严重度排在最上',
      sectionChat: '③ 和框架医生对话',
      sectionChatHint: '跟它说你想要什么，它会自己查框架的真实状态再回答；它给的动作要点一下才执行',
      chatPlaceholder: '说说你想要什么…（Enter 发送，Shift+Enter 换行）',
      chatSend: '发送',
      chatSending: '思考中…',
      chatEmpty: '还没有对话。可以直接问，比如「现在框架有什么问题？」或「帮我看下能不能换个模型」。',
      chatIam: '我',
      chatBot: '框架医生',
      chatConsulted: '它查了',
      chatAction: '可执行动作（点一下才执行）',
      chatActionGo: '执行',
      chatActionDone: '已执行',
      chatActionRunning: '执行中…',
      chatActionFailed: '执行失败',
      chatClear: '清空对话',
      chatStop: '中断',
      chatTimedOut: '这一轮还没跑完（已等 3 分钟）。它可能还在调工具；可以继续等，或按「中断」。',
      chatFail: '对话失败',
      sectionRepair: '③ 一键修复',
      sectionRepairHint: '能自动修的交给它，修不了的给出人话指引',
      baseURL: '调用网址',
      baseURLHint: '服务商给的接口地址，通常以 /v1 结尾',
      apiKey: '密钥',
      apiKeyHint: '本地服务可以不填',
      api: '协议',
      apiAuto: '自动判断',
      displayName: '显示名',
      route: '配置名',
      routeHint: '内部标识：小写字母、数字、连字符',
      existingProvider: '已有提供方',
      existingPick: '选一个已配置的提供方来探测补齐…',
      existingFill: '已回填：直接「探测端点」即可用原有密钥补齐已有模型，也可以换网址配新的。',
      existingNew: '＋ 新建提供方',
      existingProbe: '探测并补齐',
      existingMergeNote: '合并写入：已有模型保留，端点公布的新模型追加，能力字段按端点补齐',
      probe: '探测端点',
      probing: '正在探测…',
      probeFail: '探测失败',
      probeTried: '已尝试的清单地址',
      probeEmpty: '端点没有公布任何模型，可以手工在原生设置页添加。',
      probeOk: '探测到 {n} 个模型',
      selectAll: '全选',
      selectNone: '取消全选',
      colModel: '模型',
      colInput: '输入',
      colContext: '上下文',
      colMaxTokens: '输出上限',
      colReasoning: '思考档位',
      colConfidence: '置信度',
      text: '文本',
      image: '图片',
      reasoningNone: '不推理',
      reasoningUnknown: '未识别',
      effortOff: '关',
      effortMinimal: '最低',
      effortLow: '低',
      effortMedium: '中',
      effortHigh: '高',
      effortXHigh: '很高',
      effortMax: '最高',
      confidenceDeclared: '端点声明',
      confidenceInferred: '推测',
      confidenceUnknown: '未识别',
      apply: '写入配置',
      applying: '正在写入…',
      applyOk: '已写入 {route}（{n} 个模型）',
      applyPick: '先勾选要写入的模型',
      applyFail: '写入失败',
      needURL: '先填调用网址',
      withKey: '已带密钥',
      withoutKey: '未带密钥',
      run: '重新体检',
      running: '体检中…',
      fatal: '致命',
      warn: '警告',
      info: '提示',
      health: '健康分',
      healthRule: '健康分 = 100 − 致命×18 − 警告×6 − 提示×1（最低 0）',
      assistantModel: '框架医生用的模型',
      assistantModelConfig: '按你配置的链降级，上一跳失败自动换下一跳',
      assistantModelDefault: '当前跟随默认模型（未单独配置）',
      assistantModelEmpty: '还没有可用模型，请先选一个默认模型',
      chainCooling: '这个渠道刚失败过，暂时跳过',
      chainFallback: '兜底的默认模型',
      chainAdd: '＋ 加一跳',
      chainRemove: '删掉这一跳',
      chainSave: '保存',
      chainSaving: '保存中…',
      chainFallbackLabel: '链都失败时退回默认模型',
      billingHint: '检测到 {n} 个渠道出现额度/限流问题——这类问题重试没用，需要你去充值或换套餐。',
      openBilling: '去处理额度',
      billingWhere: '余额、积分、账号都在「设置 → Our Free Model」这类渠道插件页里；框架医生读不到别家的账单，只能把你送过去。',
      billingLoading: '正在查询余额…',
      billingUnavailable: '暂时读不到余额',
      billingRefresh: '刷新',
      billingCredits: '剩余积分 {n}',
      billingDollars: '剩余余额 ${n}',
      billingAccounts: '{n} 个账号',
      billingLow: '{n} 个已耗尽',
      channelCacheTitle: '渠道自称的失效原因',
      channelCacheHint: '读自渠道插件落在本地的缓存，是端点自己的判定，比看错误码准',
      cacheAbuse: '被判定滥用流量、拒绝服务（{n} 个模型）',
      cacheRegional: '当前地区不可用（{n} 个模型）',
      cacheOther: '其它不可用（{n} 个模型）',
      cacheEgress: '出口 {ip}',
      allGood: '没有发现问题，框架是健康的。',
      diagFail: '体检失败',
      autoFixable: '可自动修复',
      scopeFramework: '框架',
      scopeCredential: '凭据',
      scopeProvider: '提供方',
      scopeModel: '模型',
      scopeDefaultModel: '默认模型',
      fixOne: '修复',
      repairAll: '全部自动修复',
      repairing: '修复中…',
      repairFail: '修复失败',
      applied: '已修复',
      skipped: '需人工',
      failed: '失败',
      nothingToFix: '没有可自动修复的问题。',
      repairDone: '修复完成：{a} 项已修复，{s} 项需人工，{f} 项失败',
      repairHint: '修复只写配置，不删除你的数据；需要人工的项会给出指引。',
      errTimeout: '请求超时（8 秒）：插件后端没有响应，Host 端可能还没加载。',
      errNetwork: '连不上插件后端，检查 Host 端是否已加载。',
      errUnknown: '未知错误',
    };
    var en = {
      nav: 'Framework doctor',
      title: 'Framework doctor',
      intro: 'Connect a model, check framework health, and repair in one click. This is a standalone settings page — it never takes over a conversation.',
      statProviders: 'providers',
      statModels: 'models',
      statHealth: 'Health',
      statLastScan: 'Last check',
      currentRoutes: '{n} provider(s) configured',
      loading: 'Reading configuration…',
      stateError: 'Cannot read configuration',
      retry: 'Retry',
      boundaryTitle: 'This section crashed',
      boundaryBody: 'It is isolated; the rest of the page still works. Retry to render it again.',
      boundaryRetry: 'Retry',
      sectionOnboard: '① Connect a model',
      sectionOnboardHint: 'Paste an endpoint URL and the models configure themselves; existing providers can be probed and filled in too',
      sectionDiagnose: '② Framework checkup',
      sectionDiagnoseHint: 'Worst findings first',
      sectionChat: '③ Talk to the doctor',
      sectionChatHint: 'Say what you want; it looks up the real framework state before answering, and any action it offers runs only when you click it',
      chatPlaceholder: 'Say what you want… (Enter to send, Shift+Enter for a newline)',
      chatSend: 'Send',
      chatSending: 'Thinking…',
      chatEmpty: 'No conversation yet. Try asking “what is wrong with the framework right now?”',
      chatIam: 'You',
      chatBot: 'Framework doctor',
      chatConsulted: 'Looked up',
      chatAction: 'Suggested actions (run only when clicked)',
      chatActionGo: 'Run',
      chatActionDone: 'Done',
      chatActionRunning: 'Running…',
      chatActionFailed: 'Failed',
      chatClear: 'Clear',
      chatStop: 'Stop',
      chatTimedOut: 'This turn is still running (waited 3 minutes). It may still be calling tools; keep waiting, or press Stop.',
      chatFail: 'Chat failed',
      sectionRepair: '③ Repair',
      sectionRepairHint: 'Auto-fix what can be fixed; the rest gets plain-language guidance',
      baseURL: 'Base URL',
      baseURLHint: 'The endpoint your provider gave you, usually ending in /v1',
      apiKey: 'API key',
      apiKeyHint: 'Leave empty for a local server',
      api: 'Protocol',
      apiAuto: 'Detect automatically',
      displayName: 'Display name',
      route: 'Route name',
      routeHint: 'Internal id: lowercase letters, digits and dashes',
      existingProvider: 'Existing providers',
      existingPick: 'Pick a configured provider to probe and fill in…',
      existingFill: 'Filled in: hit Probe to refresh existing models with the stored key, or change the URL to add a new one.',
      existingNew: '＋ New provider',
      existingProbe: 'Probe & fill',
      existingMergeNote: 'Merge write: keep existing models, append newly advertised ones, fill capability fields from the endpoint',
      probe: 'Probe endpoint',
      probing: 'Probing…',
      probeFail: 'Probe failed',
      probeTried: 'Tried listing endpoints',
      probeEmpty: 'The endpoint published no models. You can add them in the native settings page.',
      probeOk: 'Found {n} models',
      selectAll: 'Select all',
      selectNone: 'Clear',
      colModel: 'Model',
      colInput: 'Input',
      colContext: 'Context',
      colMaxTokens: 'Max output',
      colReasoning: 'Thinking levels',
      colConfidence: 'Confidence',
      text: 'text',
      image: 'image',
      reasoningNone: 'no reasoning',
      reasoningUnknown: 'unknown',
      effortOff: 'off',
      effortMinimal: 'minimal',
      effortLow: 'low',
      effortMedium: 'medium',
      effortHigh: 'high',
      effortXHigh: 'xhigh',
      effortMax: 'max',
      confidenceDeclared: 'declared',
      confidenceInferred: 'inferred',
      confidenceUnknown: 'unknown',
      apply: 'Write configuration',
      applying: 'Writing…',
      applyOk: 'Written to {route} ({n} models)',
      applyPick: 'Select at least one model',
      applyFail: 'Write failed',
      needURL: 'Enter a base URL first',
      withKey: 'with key',
      withoutKey: 'without key',
      run: 'Re-check',
      running: 'Checking…',
      fatal: 'fatal',
      warn: 'warn',
      info: 'info',
      health: 'Health',
      healthRule: 'Health = 100 − fatal×18 − warn×6 − info×1 (floor 0)',
      assistantModel: "The doctor's model",
      assistantModelConfig: 'Falls back along your configured chain when a hop fails',
      assistantModelDefault: 'Following the default model (not configured separately)',
      assistantModelEmpty: 'No usable model yet — pick a default model first',
      chainCooling: 'This channel just failed and is being skipped',
      chainFallback: 'Default model, used as the last resort',
      chainAdd: '+ Add hop',
      chainRemove: 'Remove this hop',
      chainSave: 'Save',
      chainSaving: 'Saving…',
      chainFallbackLabel: 'Fall back to the default model when every hop fails',
      billingHint: '{n} channel(s) hit quota or rate limits — retrying will not help; this needs a top-up or a plan change.',
      openBilling: 'Handle quota',
      billingWhere: 'Balance, credits and accounts live in channel plugins such as Settings → Our Free Model; the doctor cannot read their billing, so it only takes you there.',
      billingLoading: 'Checking balance…',
      billingUnavailable: 'Balance not readable right now',
      billingRefresh: 'Refresh',
      billingCredits: 'Credits left {n}',
      billingDollars: 'Balance left ${n}',
      billingAccounts: '{n} account(s)',
      billingLow: '{n} exhausted',
      channelCacheTitle: 'What the channel itself says',
      channelCacheHint: 'Read from the channel plugin cache on disk — the endpoint\'s own verdict, not an error code',
      cacheAbuse: 'Flagged as abusive traffic, refused service ({n} models)',
      cacheRegional: 'Not available in this region ({n} models)',
      cacheOther: 'Otherwise unavailable ({n} models)',
      cacheEgress: 'egress {ip}',
      allGood: 'No findings — the framework is healthy.',
      diagFail: 'Check failed',
      autoFixable: 'auto-fixable',
      scopeFramework: 'Framework',
      scopeCredential: 'Credentials',
      scopeProvider: 'Providers',
      scopeModel: 'Models',
      scopeDefaultModel: 'Default model',
      fixOne: 'Fix',
      repairAll: 'Auto-fix all',
      repairing: 'Repairing…',
      repairFail: 'Repair failed',
      applied: 'Fixed',
      skipped: 'Needs a human',
      failed: 'Failed',
      nothingToFix: 'Nothing to auto-fix.',
      repairDone: 'Repair finished: {a} fixed, {s} need a human, {f} failed',
      repairHint: 'Repairs only write configuration; nothing is deleted. Manual items come with guidance.',
      errTimeout: 'Request timed out (8s): the plugin backend did not respond. The host plugin may not be loaded.',
      errNetwork: 'Cannot reach the plugin backend. Check that the host plugin is loaded.',
      errUnknown: 'Unknown error',
    };

    /* ------------------------------------------------------------------ *
     * HTTP：基址随 document.baseURI 走（反向代理子路径下也不会打到站点根）
     * ------------------------------------------------------------------ */
    var API = (function () {
      try { return new URL('api/framework-doctor', document.baseURI).pathname; }
      catch (error) { return '/api/framework-doctor'; }
    })();

    function api(path, options) {
      var opts = options || {};
      var timeout = typeof opts.timeout === 'number' ? opts.timeout : 8000;
      var controller = new AbortController();
      var timer = setTimeout(function () { controller.abort(); }, timeout);
      var init = {
        method: opts.method || 'GET',
        signal: controller.signal,
        redirect: 'error',
        headers: {},
      };
      if (opts.body !== undefined) {
        init.headers['content-type'] = 'application/json';
        init.body = JSON.stringify(opts.body);
      }
      return fetch(API + path, init).then(function (response) {
        return response.text().then(function (text) {
          var payload;
          try { payload = text === '' ? {} : JSON.parse(text); }
          catch (error) { payload = { ok: false, error: text.slice(0, 200) }; }
          if (!response.ok || (payload && payload.ok === false)) {
            var message = payload && payload.error ? payload.error : 'HTTP ' + response.status;
            var failure = new Error(message);
            failure.payload = payload;
            failure.status = response.status;
            throw failure;
          }
          return payload;
        });
      }).catch(function (error) {
        if (error && (error.name === 'AbortError' || /abort/i.test(String(error.message || '')))) {
          var timeoutError = new Error('timeout');
          timeoutError.code = 'timeout';
          throw timeoutError;
        }
        if (error && error.payload) throw error;
        if (error && error.code) throw error;
        var networkError = new Error(error && error.message ? error.message : 'network');
        networkError.code = 'network';
        throw networkError;
      }).then(function (payload) {
        clearTimeout(timer);
        return payload;
      }, function (error) {
        clearTimeout(timer);
        throw error;
      });
    }

    function humanError(t, error) {
      var err = error || {};
      if (err.code === 'timeout') return t('errTimeout');
      if (err.code === 'network') return t('errNetwork') + (err.message && err.message !== 'network' ? '（' + err.message + '）' : '');
      if (err.message) return String(err.message);
      return t('errUnknown');
    }

    /* ------------------------------------------------------------------ *
     * 小工具
     * ------------------------------------------------------------------ */
    var NUM = new Intl.NumberFormat('en-US');
    function fmtNum(value) {
      return typeof value === 'number' && isFinite(value) ? NUM.format(value) : '—';
    }
    function num(value) {
      return typeof value === 'number' && isFinite(value) ? value : 0;
    }
    function clampScore(value) {
      var score = Math.round(num(value));
      return score < 0 ? 0 : score > 100 ? 100 : score;
    }
    function timeText(value) {
      if (!value) return '—';
      var date = new Date(value);
      if (isNaN(date.getTime())) return '—';
      try { return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
      catch (error) { return date.toISOString().slice(11, 16); }
    }
    function scoreClass(score) {
      if (score >= 85) return '__fd_scoreOk';
      if (score >= 60) return '__fd_scoreWarn';
      return '__fd_scoreBad';
    }

    /* 从网址里给一个稳定的配置名：api.deepseek.com/v1 → deepseek，
     * openrouter.ai → openrouter，127.0.0.1:8000 → r-127-0-0-1。 */
    function deriveRoute(baseURL) {
      var text = String(baseURL || '').trim();
      if (!text) return 'custom';
      var host = '';
      try {
        host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : 'https://' + text).hostname;
      } catch (error) { host = ''; }
      if (!host) {
        host = text.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split('/')[0].split('@').pop().split(':')[0];
      }
      var name = host.toLowerCase()
        .replace(/^www\./, '')
        .replace(/^api\./, '')
        .replace(/^[a-z0-9-]+\.(com|cn|io|ai|net|org|dev|app|co)$/, function (whole) {
          /* 只剩站点后缀时保留主域，例如 deepseek.com → deepseek */
          return whole.split('.')[0];
        })
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
      /* api.deepseek.com 这类：去前缀后剩下 deepseek.com，再剥一层后缀。 */
      name = name.replace(/-(com|cn|io|ai|net|org|dev|app|co)$/, '');
      if (!name) name = 'custom';
      if (/^[0-9]/.test(name)) name = 'r-' + name;
      return name.slice(0, 48);
    }

    /* 写回时只保留配置 schema 认识的字段，推导过程的 notes / confidence 不外泄。 */
    var MODEL_FIELDS = ['id', 'name', 'input', 'contextWindow', 'maxTokens', 'reasoningEfforts', 'compat'];
    function cleanModel(model) {
      var out = {};
      MODEL_FIELDS.forEach(function (key) {
        if (model && model[key] !== undefined) out[key] = model[key];
      });
      return out;
    }

    var EFFORT_ORDER = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
    var EFFORT_KEY = {
      off: 'effortOff',
      minimal: 'effortMinimal',
      low: 'effortLow',
      medium: 'effortMedium',
      high: 'effortHigh',
      xhigh: 'effortXHigh',
      max: 'effortMax',
    };
    function effortKeys(reasoningEfforts) {
      if (!reasoningEfforts || typeof reasoningEfforts !== 'object') return [];
      return EFFORT_ORDER.filter(function (key) {
        return Object.prototype.hasOwnProperty.call(reasoningEfforts, key);
      });
    }
    /* 「思考档位」用人话展示：关 / 低 / 中 / 高，而不是 {"off":null,"high":"high"}。 */
    function reasoningCell(t, model) {
      var efforts = model ? model.reasoningEfforts : undefined;
      if (efforts === false) return h('span', { className: '__fd_muted' }, t('reasoningNone'));
      var keys = effortKeys(efforts);
      if (keys.length === 0) return h('span', { className: '__fd_muted' }, t('reasoningUnknown'));
      return h('span', null, keys.map(function (key) {
        return h('span', {
          key: key,
          className: '__fd_pill' + (key === 'off' ? '' : ' __fd_pillOn'),
        }, t(EFFORT_KEY[key]));
      }));
    }

    function confidenceOf(model) {
      var value = model && model.confidence;
      if (value === 'declared') return 'declared';
      if (value === 'unknown') return 'unknown';
      return 'inferred';
    }
    function confidenceCell(t, model) {
      var confidence = confidenceOf(model);
      var className = confidence === 'declared' ? '__fd_chip __fd_chipOk'
        : confidence === 'inferred' ? '__fd_chip __fd_chipWarn'
          : '__fd_chip';
      var label = confidence === 'declared' ? t('confidenceDeclared')
        : confidence === 'inferred' ? t('confidenceInferred')
          : t('confidenceUnknown');
      return h('span', { className: className }, label);
    }

    var SCOPE_ORDER = ['framework', 'credential', 'provider', 'model', 'default-model'];
    var SCOPE_KEY = {
      framework: 'scopeFramework',
      credential: 'scopeCredential',
      provider: 'scopeProvider',
      model: 'scopeModel',
      'default-model': 'scopeDefaultModel',
    };
    function scopeIndex(scope) {
      var index = SCOPE_ORDER.indexOf(scope);
      return index < 0 ? SCOPE_ORDER.length : index;
    }
    function severityRank(severity) {
      return severity === 'fatal' ? 0 : severity === 'warn' ? 1 : 2;
    }
    function countFindings(findings, summary) {
      var counts = { fatal: 0, warn: 0, info: 0 };
      (findings || []).forEach(function (finding) {
        var severity = finding && finding.severity;
        if (severity === 'fatal') counts.fatal += 1;
        else if (severity === 'warn') counts.warn += 1;
        else if (severity === 'info') counts.info += 1;
      });
      if ((!findings || findings.length === 0) && summary && typeof summary === 'object') {
        counts.fatal = num(summary.fatal);
        counts.warn = num(summary.warn);
        counts.info = num(summary.info);
      }
      return counts;
    }
    /* 后端给健康分就用后端的；没给就按同一套规则在前端算一遍（规则在 UI 里写明）。 */
    function healthScore(diag, stateData) {
      var raw = diag && diag.health != null ? diag.health
        : stateData && stateData.health != null ? stateData.health
          : null;
      if (typeof raw === 'number' && isFinite(raw)) return clampScore(raw);
      if (raw && typeof raw === 'object' && typeof raw.score === 'number') return clampScore(raw.score);
      var counts = countFindings(diag && diag.findings, diag && diag.summary);
      /* 与 Host 端 scoreOf() 保持同一套扣分规则（致命 18 / 警告 6 / 提示 1）。 */
      return clampScore(100 - counts.fatal * 18 - counts.warn * 6 - counts.info);
    }
    /* 致命在最上，其次按 scope 聚组。 */
    function groupFindings(findings) {
      var sorted = (findings || []).slice().sort(function (left, right) {
        return severityRank(left && left.severity) - severityRank(right && right.severity)
          || scopeIndex(left && left.scope) - scopeIndex(right && right.scope)
          || String(left && left.id).localeCompare(String(right && right.id));
      });
      var order = [];
      var groups = {};
      sorted.forEach(function (finding) {
        var scope = (finding && finding.scope) || 'framework';
        if (!groups[scope]) { groups[scope] = []; order.push(scope); }
        groups[scope].push(finding);
      });
      return order.map(function (scope) { return { scope: scope, items: groups[scope] }; });
    }
    /* Host 的 /repair 三种行形状各不相同：
     *   applied: { findingId, op, status } 或 { findingId, selection, status }
     *   skipped: { findingId, title, reason }
     *   failed : { scope, error, ops? }
     * 这里统一折算成「标题 + 细节」两行，任何一种都不会渲染成空白行。 */
    function describeOp(op) {
      if (!op || typeof op !== 'object') return '';
      var path = Array.isArray(op.path) ? op.path.join('.') : '';
      if (op.op === 'set') return 'set ' + path + ' = ' + JSON.stringify(op.value);
      if (op.op === 'unset') return 'unset ' + path;
      return String(op.op || '');
    }
    function describeSelection(selection) {
      if (!selection || typeof selection !== 'object') return '';
      var parts = [selection.provider, selection.model].filter(Boolean);
      if (selection.reasoningEffort) parts.push('effort=' + selection.reasoningEffort);
      return parts.join(' / ');
    }
    function stepText(t, item, key) {
      if (item == null) return '';
      if (typeof item === 'string') return item;
      if (item.title) return item.title;
      if (item.findingId) return String(item.findingId);
      if (item.scope) return String(item.scope);
      if (key === 'applied') return t('applied');
      if (key === 'skipped') return t('skipped');
      if (key === 'failed') return t('failed');
      return '';
    }
    function stepDetail(item, key) {
      if (!item || typeof item === 'string') return '';
      if (item.reason) return item.reason;
      if (item.error) return item.error;
      if (item.detail) return item.detail;
      if (item.note) return item.note;
      if (item.guidance) return item.guidance;
      if (item.message) return item.message;
      if (item.op) return describeOp(item.op);
      if (item.selection) return describeSelection(item.selection);
      if (key === 'applied' && item.findingId) return String(item.findingId);
      return '';
    }

    /* ------------------------------------------------------------------ *
     * Error boundary：一个区崩了不能带走整个设置页
     * ------------------------------------------------------------------ */
    class Boundary extends react.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
        this.retry = this.retry.bind(this);
      }
      static getDerivedStateFromError(error) {
        return { error: error || new Error('render failed') };
      }
      componentDidCatch(error, info) {
        if (typeof console !== 'undefined' && console.warn) {
          console.warn('[dsh-framework-doctor] section crashed', error, info);
        }
      }
      retry() {
        this.setState({ error: null });
      }
      render() {
        if (!this.state || !this.state.error) return this.props.children;
        var t = this.props.t || function (key) { return key; };
        var title = this.props.title ? this.props.title + ' · ' : '';
        return h('section', { className: '__fd_section __fd_crash' },
          h('div', { className: '__fd_secBody' },
            h('p', { className: '__fd_crashTitle' }, title + t('boundaryTitle')),
            h('p', { className: '__fd_hint' }, t('boundaryBody')),
            h('p', { className: '__fd_url' }, String((this.state.error && this.state.error.message) || this.state.error)),
            h('div', { className: '__fd_actions' },
              h('button', { type: 'button', onClick: this.retry }, t('boundaryRetry')))));
      }
    }

    /* 统一的区块外壳：标题 + 提示 + 右侧操作 + 内容。 */
    function Section(props) {
      return h('section', { className: '__fd_section' },
        h('div', { className: '__fd_secHead' },
          h('span', { className: '__fd_secTitle' }, props.title),
          props.hint ? h('span', { className: '__fd_hint' }, props.hint) : null,
          h('span', { style: { flex: 1 } }),
          props.right || null),
        h('div', { className: '__fd_secBody' }, props.children));
    }

    /* ------------------------------------------------------------------ *
     * 区 1：接入向导（主路径）
     * ------------------------------------------------------------------ */
    function OnboardSection(props) {
      var t = props.t;
      var formPair = react.useState({ baseURL: '', apiKey: '', api: '', displayName: '', route: '' });
      var form = formPair[0], setForm = formPair[1];
      var touchedPair = react.useState(false);
      var routeTouched = touchedPair[0], setRouteTouched = touchedPair[1];
      var existingPair = react.useState('');
      var existing = existingPair[0], setExisting = existingPair[1];
      var probePair = react.useState({
        status: 'idle', models: [], endpoint: '', tried: [], hasKey: false, warnings: [], error: '',
      });
      var probe = probePair[0], setProbe = probePair[1];
      var selPair = react.useState({});
      var selected = selPair[0], setSelected = selPair[1];
      var appliedPair = react.useState({ status: 'idle', error: '', note: '', written: 0 });
      var applied = appliedPair[0], setApplied = appliedPair[1];

      var route = routeTouched && form.route ? form.route : deriveRoute(form.baseURL);
      var isExisting = Boolean(existing) && existing !== '__new__';
      function patch(next) { setForm(Object.assign({}, form, next)); }

      /* 从 /state 的 providers 摘要里取出可回填的路由条目。 */
      var providersMap = props.providers && typeof props.providers === 'object' ? props.providers : {};
      var providerEntries = Object.keys(providersMap)
        .map(function (key) {
          var row = providersMap[key] || {};
          return {
            route: key,
            displayName: row.displayName || key,
            baseURL: typeof row.baseURL === 'string' ? row.baseURL : '',
            api: typeof row.api === 'string' ? row.api : '',
            apiKeyEnv: typeof row.apiKeyEnv === 'string' ? row.apiKeyEnv : '',
            hasAuth: Boolean(row.hasAuthHeader || row.apiKeyEnv),
            modelCount: typeof row.modelCount === 'number' ? row.modelCount : 0,
          };
        })
        .filter(function (row) { return row.baseURL.length > 0; })
        .sort(function (a, b) { return a.displayName.localeCompare(b.displayName); });

      /* 选中已有提供方：回填表单，走"探测补齐"路径。 */
      function pickExisting(key) {
        setExisting(key);
        if (!key || key === '__new__') {
          setProbe({
            status: 'idle', models: [], endpoint: '', tried: [], hasKey: false, warnings: [], error: '',
          });
          setApplied({ status: 'idle', error: '', note: '', written: 0 });
          return;
        }
        var row = providersMap[key] || {};
        var nextForm = {
          baseURL: typeof row.baseURL === 'string' ? row.baseURL : '',
          api: typeof row.api === 'string' ? row.api : '',
          apiKey: '',
          displayName: typeof row.displayName === 'string' ? row.displayName : key,
          route: key,
          apiKeyEnv: typeof row.apiKeyEnv === 'string' ? row.apiKeyEnv : '',
        };
        setForm(nextForm);
        setRouteTouched(true);
        setProbe({
          status: 'idle', models: [], endpoint: '', tried: [], hasKey: false, warnings: [], error: '',
        });
        setApplied({ status: 'idle', error: '', note: '', written: 0 });
      }

      function runProbe() {
        var baseURL = String(form.baseURL || '').trim();
        if (!baseURL) {
          setProbe({
            status: 'error', models: [], endpoint: '', tried: [], hasKey: false, warnings: [], error: t('needURL'),
          });
          return;
        }
        setProbe({
          status: 'running', models: [], endpoint: '', tried: [], hasKey: false, warnings: [], error: '',
        });
        setApplied({ status: 'idle', error: '', note: '', written: 0 });
        var body = { baseURL: baseURL };
        if (form.api) body.api = form.api;
        if (form.apiKey) body.apiKey = form.apiKey;
        /* 已有提供方：密钥走已存引用，不需要用户重新输入。 */
        if (isExisting && form.apiKeyEnv) body.apiKeyEnv = form.apiKeyEnv;
        /* 探测可能要多试几个清单地址（后端单次 15s 上限），这里放宽到 45s；
           其余路由保持 8s 兜底。 */
        api('/probe', { method: 'POST', body: body, timeout: 45000 }).then(function (result) {
          var models = Array.isArray(result.models) ? result.models : [];
          var picked = {};
          models.forEach(function (model) {
            if (model && model.id) picked[model.id] = true;
          });
          setSelected(picked);
          setProbe({
            status: 'ready',
            models: models,
            endpoint: result.endpoint || '',
            tried: Array.isArray(result.triedEndpoints) ? result.triedEndpoints : [],
            hasKey: Boolean(result.hasKey),
            warnings: Array.isArray(result.warnings) ? result.warnings : [],
            error: '',
          });
        }).catch(function (error) {
          var payload = error && error.payload ? error.payload : null;
          setProbe({
            status: 'error', models: [], endpoint: '', hasKey: false, warnings: [],
            tried: payload && Array.isArray(payload.triedEndpoints) ? payload.triedEndpoints : [],
            error: humanError(t, error),
          });
        });
      }

      function runApply() {
        var models = probe.models.filter(function (model) {
          return model && model.id && selected[model.id];
        }).map(cleanModel);
        if (models.length === 0) {
          setApplied({ status: 'error', error: t('applyPick'), note: '', written: 0 });
          return;
        }
        setApplied({ status: 'running', error: '', note: '', written: 0 });
        var body = { route: route, baseURL: String(form.baseURL || '').trim(), models: models };
        if (form.api) body.api = form.api;
        if (form.displayName) body.displayName = String(form.displayName).trim();
        if (form.apiKey) body.apiKey = form.apiKey;
        /* 已有提供方：合并写入，保留手写模型，不整组覆盖。 */
        if (isExisting) {
          body.mergeModels = true;
          if (form.apiKeyEnv) body.apiKeyEnv = form.apiKeyEnv;
        }
        api('/apply', { method: 'POST', body: body }).then(function (result) {
          setApplied({
            status: 'done', error: '', note: result.note || '',
            written: typeof result.written === 'number' ? result.written : models.length,
          });
          if (typeof props.onApplied === 'function') props.onApplied();
        }).catch(function (error) {
          setApplied({ status: 'error', error: humanError(t, error), note: '', written: 0 });
        });
      }

      var busy = probe.status === 'running';
      var applying = applied.status === 'running';
      var chosen = probe.models.filter(function (model) {
        return model && model.id && selected[model.id];
      });

      return h(Section, {
        title: t('sectionOnboard'),
        hint: t('sectionOnboardHint'),
        right: h('span', { className: '__fd_hint' }, t('currentRoutes').replace('{n}', String(props.providerCount || 0))),
      },
      providerEntries.length > 0
        ? h('div', { className: '__fd_existing' },
            h('label', { className: '__fd_field' },
              h('span', null, t('existingProvider')),
              h('select', {
                value: existing,
                onChange: function (event) { pickExisting(event.target.value); },
              },
              h('option', { value: '' }, t('existingNew')),
              providerEntries.map(function (row) {
                return h('option', { key: row.route, value: row.route },
                  row.displayName + ' · ' + row.route +
                  (row.modelCount ? ' (' + row.modelCount + ')' : '') +
                  (row.hasAuth ? '' : ' · 缺凭据'));
              }))),
            isExisting
              ? h('p', { className: '__fd_hint' }, t('existingFill'))
              : null,
            isExisting
              ? h('p', { className: '__fd_hint' }, t('existingMergeNote'))
              : null)
        : null,
      h('div', { className: '__fd_grid' },
        h('label', { className: '__fd_field' },
          h('span', null, t('baseURL')),
          h('input', {
            type: 'text', value: form.baseURL, placeholder: 'https://api.deepseek.com/v1',
            onChange: function (event) { patch({ baseURL: event.target.value }); },
          }),
          h('em', null, t('baseURLHint'))),
        h('label', { className: '__fd_field' },
          h('span', null, t('apiKey')),
          h('input', {
            type: 'password', value: form.apiKey, autoComplete: 'off',
            onChange: function (event) { patch({ apiKey: event.target.value }); },
          }),
          h('em', null, t('apiKeyHint')))),
      h('div', { className: '__fd_grid' },
        h('label', { className: '__fd_field' },
          h('span', null, t('api')),
          h('select', {
            value: form.api,
            onChange: function (event) { patch({ api: event.target.value }); },
          },
          h('option', { value: '' }, t('apiAuto')),
          h('option', { value: 'openai-completions' }, 'openai-completions'),
          h('option', { value: 'openai-responses' }, 'openai-responses'),
          h('option', { value: 'anthropic-messages' }, 'anthropic-messages'))),
        h('label', { className: '__fd_field' },
          h('span', null, t('displayName')),
          h('input', {
            type: 'text', value: form.displayName,
            onChange: function (event) { patch({ displayName: event.target.value }); },
          })),
        h('label', { className: '__fd_field' },
          h('span', null, t('route')),
          h('input', {
            type: 'text', value: route,
            onChange: function (event) {
              setRouteTouched(true);
              patch({ route: event.target.value });
            },
          }),
          h('em', null, t('routeHint')))),
      h('div', { className: '__fd_actions' },
        h('button', {
          type: 'button', className: '__fd_primary', disabled: busy, onClick: runProbe,
        }, t(busy ? 'probing' : (isExisting ? 'existingProbe' : 'probe'))),
        probe.status === 'ready'
          ? h('span', { className: '__fd_hint' }, t('probeOk').replace('{n}', String(probe.models.length)))
          : null,
        probe.status === 'ready' && probe.endpoint
          ? h('span', { className: '__fd_url' }, probe.endpoint + ' · ' + t(probe.hasKey ? 'withKey' : 'withoutKey'))
          : null),

      probe.status === 'error'
        ? h('div', null,
            h('p', { className: '__fd_error' }, t('probeFail') + '：' + probe.error),
            probe.tried.length
              ? h('p', { className: '__fd_url' }, t('probeTried') + '：' + probe.tried.join('  ·  '))
              : null)
        : null,

      probe.warnings.length
        ? h('div', null, probe.warnings.map(function (warning, index) {
            return h('p', { key: 'warn-' + index, className: '__fd_hint' }, '· ' + warning);
          }))
        : null,

      probe.status === 'ready' && probe.models.length === 0
        ? h('p', { className: '__fd_hint' }, t('probeEmpty'))
        : null,

      probe.status === 'ready' && probe.models.length > 0
        ? h('div', null,
            h('div', { className: '__fd_actions', style: { marginBottom: '6px' } },
              h('button', {
                type: 'button',
                onClick: function () {
                  var all = {};
                  probe.models.forEach(function (model) { if (model && model.id) all[model.id] = true; });
                  setSelected(all);
                },
              }, t('selectAll')),
              h('button', { type: 'button', onClick: function () { setSelected({}); } }, t('selectNone'))),
            h('table', null,
              h('thead', null, h('tr', null,
                h('th', { style: { width: '34px' } }, ''),
                h('th', null, t('colModel')),
                h('th', { style: { width: '110px' } }, t('colInput')),
                h('th', { style: { width: '96px' } }, t('colContext')),
                h('th', { style: { width: '96px' } }, t('colMaxTokens')),
                h('th', { style: { width: '180px' } }, t('colReasoning')),
                h('th', { style: { width: '104px' } }, t('colConfidence')))),
              h('tbody', null, probe.models.map(function (model) {
                var confidence = confidenceOf(model);
                var input = Array.isArray(model.input) ? model.input : null;
                return h('tr', {
                  key: model.id,
                  className: confidence === 'declared' ? undefined : '__fd_lowConf',
                },
                h('td', null, h('input', {
                  type: 'checkbox',
                  checked: Boolean(selected[model.id]),
                  'aria-label': model.id,
                  onChange: function () {
                    setSelected(function (previous) {
                      var next = Object.assign({}, previous);
                      if (next[model.id]) delete next[model.id];
                      else next[model.id] = true;
                      return next;
                    });
                  },
                })),
                h('td', null,
                  h('div', null, model.name || model.id),
                  h('div', { className: '__fd_mid __fd_hint' }, String(model.id || ''))),
                h('td', null, input === null
                  ? h('span', { className: '__fd_muted' }, '—')
                  : input.length === 0
                    ? h('span', { className: '__fd_muted' }, '—')
                    : input.map(function (kind) {
                        return h('span', { key: kind, className: '__fd_pill __fd_pillOn' },
                          kind === 'image' ? t('image') : t('text'));
                      })),
                h('td', { className: '__fd_num' }, fmtNum(model.contextWindow)),
                h('td', { className: '__fd_num' }, fmtNum(model.maxTokens)),
                h('td', null, reasoningCell(t, model)),
                h('td', null, confidenceCell(t, model)));
              }))),
            h('div', { className: '__fd_actions' },
              h('button', {
                type: 'button', className: '__fd_primary',
                disabled: applying || chosen.length === 0, onClick: runApply,
              }, t(applying ? 'applying' : 'apply') + (chosen.length ? ' (' + chosen.length + ')' : '')),
              applied.status === 'done'
                ? h('span', { className: '__fd_okText' },
                    t('applyOk').replace('{route}', route).replace('{n}', String(applied.written)) +
                    (applied.note ? ' · ' + applied.note : ''))
                : null,
              applied.status === 'error'
                ? h('span', { className: '__fd_error' }, t('applyFail') + '：' + applied.error)
                : null))
        : null);
    }

    /* ------------------------------------------------------------------ *
     * 区 2：体检
     * ------------------------------------------------------------------ */
    function findingRow(t, finding, repair, onRepairOne) {
      var severity = finding && finding.severity === 'fatal' ? 'fatal'
        : finding && finding.severity === 'warn' ? 'warn' : 'info';
      var fixable = Boolean(finding && finding.repair && finding.repair.kind);
      var busy = repair && repair.status === 'running' && repair.busyId === finding.id;
      var where = [finding && finding.route, finding && finding.modelId].filter(Boolean).join(' / ');
      return h('div', { key: (finding && finding.id) || (finding && finding.title) || 'finding', className: '__fd_finding' },
        h('span', { className: '__fd_dot __fd_dot' + (severity === 'fatal' ? 'Bad' : severity === 'warn' ? 'Warn' : 'Info') }),
        h('div', { className: '__fd_findingBody' },
          h('div', { className: '__fd_findingTitle' },
            h('span', null, (finding && (finding.title || finding.id)) || ''),
            severity === 'fatal' ? h('span', { className: '__fd_chip __fd_chipBad' }, t('fatal')) : null,
            fixable ? h('span', { className: '__fd_chip __fd_chipOk' }, t('autoFixable')) : null),
          finding && finding.detail ? h('div', { className: '__fd_hint' }, finding.detail) : null,
          where ? h('div', { className: '__fd_url' }, where) : null),
        fixable && onRepairOne
          ? h('button', {
              type: 'button', disabled: busy,
              onClick: function () { onRepairOne(finding.id); },
            }, t(busy ? 'repairing' : 'fixOne'))
          : null);
    }

    function DiagnoseSection(props) {
      var t = props.t;
      var diag = props.diag || { status: 'idle', findings: [] };
      var counts = props.counts || { fatal: 0, warn: 0, info: 0 };
      var score = props.score;
      var running = diag.status === 'running' || diag.status === 'refreshing';
      var groups = groupFindings(diag.findings);

      return h(Section, {
        title: t('sectionDiagnose'),
        hint: t('sectionDiagnoseHint'),
        right: h('button', {
          type: 'button', className: '__fd_primary', disabled: running, onClick: props.onRun,
        }, t(running ? 'running' : 'run')),
      },
      h('div', { className: '__fd_health' },
        h('span', { className: '__fd_score ' + scoreClass(score) }, String(score)),
        h('span', { className: '__fd_hint' }, t('health')),
        h('span', { className: '__fd_chip __fd_chipBad' }, t('fatal') + ' ' + counts.fatal),
        h('span', { className: '__fd_chip __fd_chipWarn' }, t('warn') + ' ' + counts.warn),
        h('span', { className: '__fd_chip __fd_chipInfo' }, t('info') + ' ' + counts.info),
        h('span', { style: { flex: 1 } }),
        h('span', { className: '__fd_hint' }, t('healthRule'))),

      /* 框架医生自己用哪个模型 + 渠道健康（含额度问题跳转）。 */
      h(AssistantModelPanel, {
        t: t,
        data: props.data,
        billing: props.billing,
        onOpenBilling: props.onOpenBilling,
        onRefreshBilling: props.onRefreshBilling,
        onSaved: props.onSavedModel,
      }),

      /* 渠道插件磁盘缓存里的真实失效原因（区域封锁 / 滥用流量）。 */
      h(ChannelCachePanel, { t: t, channelCache: props.channelCache }),

      diag.status === 'idle' ? h('p', { className: '__fd_hint' }, t('loading')) : null,
      diag.error ? h('p', { className: '__fd_error' }, t('diagFail') + '：' + diag.error) : null,
      diag.status === 'ready' && (diag.findings || []).length === 0
        ? h('p', { className: '__fd_okText' }, t('allGood'))
        : null,

      groups.map(function (group) {
        return h('div', { key: group.scope, className: '__fd_group' },
          h('div', { className: '__fd_groupHead' },
            t(SCOPE_KEY[group.scope] || 'scopeFramework') + ' · ' + group.items.length),
          group.items.map(function (finding) {
            return findingRow(t, finding, props.repair, props.onRepairOne);
          }));
      }));
    }

    /**
     * 渠道插件磁盘缓存里的可用性状态。
     *
     * 这是 Host 直接读文件拿到的（不需要鉴权），内容是端点自己给的判定：
     * 「该 IP 被判定滥用流量」「地区受限」等。比 429 有用得多——
     * 429 只说明"这次被拒了"，这里说明"为什么、还能不能救"。
     */
    function ChannelCachePanel(props) {
      var t = props.t;
      var caches = Array.isArray(props.channelCache) ? props.channelCache : [];

      var rows = [];
      caches.forEach(function (cache) {
        var abuse = [];
        var regional = [];
        var other = [];
        (cache.models || []).forEach(function (row) {
          if (row.state === 'available' || row.state === 'ok') return;
          var detail = String(row.detail || '').toLowerCase();
          if (detail.indexOf('abusive traffic') >= 0 || detail.indexOf('abuse') >= 0) abuse.push(row);
          else if (row.state === 'region-blocked' || detail.indexOf('your country') >= 0) regional.push(row);
          else other.push(row);
        });
        if (abuse.length) rows.push({ kind: 'abuse', cache: cache, items: abuse });
        if (regional.length) rows.push({ kind: 'regional', cache: cache, items: regional });
        if (other.length) rows.push({ kind: 'other', cache: cache, items: other });
      });

      if (rows.length === 0) return null;

      return h('div', { className: '__fd_cache' },
        h('div', { className: '__fd_assistHead' },
          h('span', { className: '__fd_assistTitle' }, t('channelCacheTitle')),
          h('span', { className: '__fd_hint' }, t('channelCacheHint'))),
        rows.map(function (group, index) {
          var kindText = group.kind === 'abuse' ? t('cacheAbuse')
            : group.kind === 'regional' ? t('cacheRegional')
              : t('cacheOther');
          var first = group.items[0];
          return h('div', { key: 'cache-' + index, className: '__fd_cacheRow' },
            h('span', {
              className: '__fd_dot ' + (group.kind === 'other' ? '__fd_dotInfo' : '__fd_dotWarn'),
            }),
            h('div', { className: '__fd_findingBody' },
              h('div', { className: '__fd_findingTitle' },
                kindText.replace('{n}', String(group.items.length)),
                group.cache.egress && group.cache.egress.ip
                  ? h('span', { className: '__fd_tag' }, t('cacheEgress').replace('{ip}', group.cache.egress.ip))
                  : null),
              first && first.detail
                ? h('div', { className: '__fd_hint __fd_mid' }, String(first.detail).slice(0, 220))
                : null,
              group.items.length > 1
                ? h('div', { className: '__fd_url' },
                    group.items.map(function (row) { return row.id; }).slice(0, 6).join('、') +
                    (group.items.length > 6 ? ' …' : ''))
                : null));
        }));
    }

    /* ------------------------------------------------------------------ *
     * 框架医生的模型 + 渠道健康面板
     *
     * 两件事：
     *   1. 告诉用户"框架医生现在用哪个模型"，以及这条链的降级顺序；
     *   2. 渠道出问题时给出可操作提示——额度类问题直接给跳转，
     *      因为我们读不到别家插件的余额，只能把用户送到他自己的账单页。
     * ------------------------------------------------------------------ */
    /**
     * 框架医生自己的模型：可增删的候选链 +「跟随默认模型」开关。
     *
     * 为什么做成可选而不是只读：这条链原来只能改 cordis.patch.yml 才动得了，
     * 而用户对一个设置页的期待就是"在这儿能改"。机制直接复用主对话那套——
     * 读宿主 `agentDefaultModel` 拿当前默认模型（`data.defaultSelection`），
     * 写的时候走 configEditor 通道落到 profile patch，由 Loader reconcile 生效。
     *
     * 选项来自 `data.llmProviders`（宿主 `llm.listProviders()` 的真实注册表），
     * 所以 Our Free Model 这类渠道注册进来的 provider 会直接出现在下拉里。
     */
    function AssistantModelPanel(props) {
      var t = props.t;
      var data = props.data || {};
      var info = data.assistantModel || { chain: [], explicit: false, fallbackToDefaultModel: true };
      var providers = Array.isArray(data.llmProviders) ? data.llmProviders : [];
      var rows = Array.isArray(data.channelHealth) ? data.channelHealth : [];

      // 已配置的链（不含"跟随默认"那一跳，它是开关不是条目）。
      var configured = (Array.isArray(info.chain) ? info.chain : [])
        .filter(function (entry) { return entry && entry.source !== 'default'; });
      // 编辑中的链：本地副本，保存时才落盘。
      var draft = react.useState(function () {
        return configured.map(function (e) { return { provider: e.provider, model: e.model }; });
      });
      var chainDraft = draft[0];
      var setChainDraft = draft[1];
      var fallbackState = react.useState(info.fallbackToDefaultModel !== false);
      var fallbackDraft = fallbackState[0];
      var setFallbackDraft = fallbackState[1];
      var busyState = react.useState(false);
      var busy = busyState[0];
      var setBusy = busyState[1];
      var errorState = react.useState('');
      var error = errorState[0];
      var setError = errorState[1];
      var savedState = react.useState('');
      var saved = savedState[0];
      var setSaved = savedState[1];

      // 脏检查：和落盘值一致就不让按保存，避免无效写入触发 Loader reconcile。
      var dirty = JSON.stringify(chainDraft) !== JSON.stringify(configured) ||
        fallbackDraft !== (info.fallbackToDefaultModel !== false);

      // 只看这一轮（框架医生自己）的失败记录，别的会话的不混进来。
      var mine = rows.filter(function (row) { return String(row.sessionId || '').indexOf('framework-doctor:') === 0; });
      var coolingNow = mine.filter(function (row) { return row.cooling; });
      var billing = mine.filter(function (row) { return row.billing; });

      // 把 provider/model 摊平成 "provider/model" 选项，主对话的选择器也是这个形状。
      var options = [];
      providers.forEach(function (provider) {
        var models = Array.isArray(provider.models) ? provider.models : [];
        models.forEach(function (model) {
          options.push({
            value: provider.id + '/' + model.id,
            label: (model.name || model.id) + '  ·  ' + provider.id + '/' + model.id,
            provider: provider.id,
            model: model.id,
          });
        });
      });
      var optionByValue = {};
      options.forEach(function (o) { optionByValue[o.value] = o; });

      function save() {
        setBusy(true); setError(''); setSaved('');
        api('/assistant-model', {
          method: 'POST',
          body: { chain: chainDraft, fallbackToDefaultModel: fallbackDraft },
          timeout: 15000,
        }).then(function (result) {
          setSaved('已保存，' + ((result && result.chain) || []).length + ' 跳');
          if (props.onSaved) props.onSaved(result);
        }).catch(function (err) {
          setError(err && err.message ? err.message : String(err));
        }).then(function () { setBusy(false); });
      }

      function addHop() {
        // 默认挑第一个还没进链的选项；全加了就静默不动。
        for (var i = 0; i < options.length; i++) {
          var o = options[i];
          var exists = chainDraft.some(function (e) { return e.provider === o.provider && e.model === o.model; });
          if (!exists) {
            setChainDraft(chainDraft.concat([{ provider: o.provider, model: o.model }]));
            return;
          }
        }
      }

      function removeHop(index) {
        setChainDraft(chainDraft.filter(function (_, i) { return i !== index; }));
      }

      function changeHop(index, value) {
        var picked = optionByValue[value];
        if (!picked) return;
        var next = chainDraft.slice();
        next[index] = { provider: picked.provider, model: picked.model };
        setChainDraft(next);
      }

      return h('div', { className: '__fd_assist' },
        h('div', { className: '__fd_assistHead' },
          h('span', { className: '__fd_assistTitle' }, t('assistantModel')),
          h('span', { className: '__fd_hint' },
            chainDraft.length > 0 ? t('assistantModelConfig') : t('assistantModelDefault'))),

        /* 候选链编辑区 */
        chainDraft.length === 0
          ? h('p', { className: '__fd_hint' }, t('assistantModelEmpty'))
          : h('div', { className: '__fd_chainEdit' },
              chainDraft.map(function (entry, index) {
                var isCooling = coolingNow.some(function (row) { return row.route === entry.provider; });
                return h('div', {
                  key: entry.provider + '/' + entry.model + '#' + index,
                  className: '__fd_chainRow' + (isCooling ? ' __fd_chainRowBad' : ''),
                },
                  h('span', { className: '__fd_chainIdx' }, String(index + 1)),
                  h('select', {
                    className: '__fd_select',
                    value: entry.provider + '/' + entry.model,
                    title: isCooling ? t('chainCooling') : '',
                    onChange: function (event) { changeHop(index, event.target.value); },
                  }, options
                    .filter(function (o) {
                      return o.provider === entry.provider && o.model === entry.model;
                    })
                    .concat(options.filter(function (o) {
                      return !(o.provider === entry.provider && o.model === entry.model);
                    }))
                    .map(function (o) {
                      return h('option', { key: o.value, value: o.value }, o.label);
                    })),
                  h('button', {
                    type: 'button',
                    className: '__fd_chainRemove',
                    title: t('chainRemove'),
                    onClick: function () { removeHop(index); },
                  }, '×'));
              })),

        /* 操作行 */
        h('div', { className: '__fd_actions' },
          h('button', {
            type: 'button',
            disabled: busy || options.length === 0,
            onClick: addHop,
          }, t('chainAdd')),
          h('label', { className: '__fd_check' },
            h('input', {
              type: 'checkbox',
              checked: fallbackDraft,
              onChange: function (event) { setFallbackDraft(event.target.checked); },
            }),
            t('chainFallbackLabel')),
          h('button', {
            type: 'button',
            className: '__fd_primary',
            disabled: busy || !dirty,
            onClick: save,
          }, busy ? t('chainSaving') : t('chainSave'))),

        error === '' ? null : h('p', { className: '__fd_error' }, error),
        saved === '' ? null : h('p', { className: '__fd_saved' }, saved),

        billing.length
          ? h('div', { className: '__fd_billing' },
              h('p', { className: '__fd_billingText' },
                t('billingHint').replace('{n}', String(billing.length))),
              /* 从渠道插件那儿真实读来的余额/积分——浏览器侧直接取，
                 因为那些接口认的是浏览器会话，Host 拿不到。 */
              h(BillingPanel, { t: t, billing: props.billing, onRefresh: props.onRefreshBilling }),
              h('div', { className: '__fd_actions' },
                h('button', {
                  type: 'button',
                  onClick: function () {
                    if (props.onOpenBilling) props.onOpenBilling();
                  },
                }, t('openBilling')),
                h('span', { className: '__fd_hint' }, t('billingWhere'))))
          : null);
    }

    /**
     * 账单/积分小面板。
     *
     * 数据来自渠道插件自己的 API（客户端直接 fetch，带浏览器会话）。
     * 那个插件没装、没登录、或改了接口，这里都只是安静地不显示——
     * 框架医生的核心功能不该因为读不到别家的账单而受影响。
     */
    function BillingPanel(props) {
      var t = props.t;
      var billing = props.billing || { status: 'idle', snapshot: null, summary: null, error: '' };
      var summary = billing.summary;

      if (billing.status === 'loading') {
        return h('p', { className: '__fd_hint' }, t('billingLoading'));
      }
      if (billing.status === 'error' || !summary || !summary.hasData) {
        return h('div', { className: '__fd_actions' },
          h('span', { className: '__fd_hint' },
            t('billingUnavailable') + (summary && summary.error ? '：' + summary.error : '')),
          h('button', { type: 'button', onClick: props.onRefresh }, t('billingRefresh')));
      }

      var parts = [];
      if (summary.totalCredits !== null) {
        parts.push(t('billingCredits').replace('{n}', String(summary.totalCredits)));
      }
      if (summary.totalDollars !== null) {
        parts.push(t('billingDollars').replace('{n}', String(summary.totalDollars)));
      }
      if (parts.length === 0) {
        parts.push(t('billingAccounts').replace('{n}', String(summary.accounts)));
      }

      return h('div', { className: '__fd_billingRow' },
        h('span', { className: '__fd_billingLabel' }, summary.label || ''),
        h('span', null, parts.join(' · ')),
        summary.lowCount > 0
          ? h('span', { className: '__fd_chip __fd_chipWarn' },
              t('billingLow').replace('{n}', String(summary.lowCount)))
          : null,
        h('button', { type: 'button', onClick: props.onRefresh }, t('billingRefresh')));
    }

    /* ------------------------------------------------------------------ *
     * 区 3：对话框
     *
     * 用户在这里提需求；AI 自己 TOOL 取数后回答，并在末尾给出可点击动作。
     * 写操作只在用户按下按钮时执行。
     * ------------------------------------------------------------------ */
    function ChatSection(props) {
      var t = props.t;
      var chat = props.chat || { messages: [], status: 'idle', error: '', actionResults: {} };
      var messages = Array.isArray(chat.messages) ? chat.messages : [];
      var sending = chat.status === 'running';
      var inputPair = react.useState('');
      var input = inputPair[0], setInput = inputPair[1];
      var listRef = react.useRef(null);

      react.useEffect(function () {
        var node = listRef.current;
        if (node && typeof node.scrollTop === 'number') node.scrollTop = node.scrollHeight;
      }, [messages.length, sending]);

      function submit() {
        var text = String(input || '').trim();
        if (!text || sending) return;
        setInput('');
        props.onSend(text);
      }

      function onKeyDown(event) {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          submit();
        }
      }

      return h(Section, {
        title: t('sectionChat'),
        hint: t('sectionChatHint'),
        right: h('span', { className: '__fd_chatActions' },
          sending
            ? h('button', { type: 'button', onClick: props.onStop }, t('chatStop'))
            : null,
          messages.length
            ? h('button', { type: 'button', disabled: sending, onClick: props.onClear }, t('chatClear'))
            : null),
      },
      h('div', { className: '__fd_chat' },
        h('div', { className: '__fd_chatList', ref: listRef },
          messages.length === 0
            ? h('p', { className: '__fd_hint' }, t('chatEmpty'))
            : messages.map(function (message, index) {
                // 工具调用行：显示 agent 正在/曾经调了什么工具
                if (message.role === 'tool') {
                  return h('div', { key: 'msg-' + index, className: '__fd_toolRow' },
                    h('span', { className: '__fd_toolDot' }),
                    h('span', { className: '__fd_toolName' }, String(message.tool || 'tool')));
                }
                var mine = message.role === 'user';
                return h('div', {
                  key: 'msg-' + index,
                  className: '__fd_bubbleRow' + (mine ? ' __fd_bubbleRowMine' : ''),
                },
                h('div', { className: '__fd_bubble' + (mine ? ' __fd_bubbleMine' : '') },
                  h('div', { className: '__fd_bubbleWho' }, t(mine ? 'chatIam' : 'chatBot')),
                  h('div', { className: '__fd_bubbleText' }, String(message.text || '')),
                  !mine && Array.isArray(message.consulted) && message.consulted.length
                    ? h('div', { className: '__fd_consulted' },
                        t('chatConsulted') + '：' +
                        message.consulted.map(function (entry) {
                          return entry && entry.name ? entry.name : '?';
                        }).join('、'))
                    : null,
                  !mine && Array.isArray(message.actions) && message.actions.length
                    ? h('div', { className: '__fd_bubbleActions' },
                        h('div', { className: '__fd_hint' }, t('chatAction')),
                        message.actions.map(function (action, actionIndex) {
                          var key = index + '-' + actionIndex;
                          var result = (chat.actionResults || {})[key] || { status: 'idle', note: '' };
                          var busy = result.status === 'running';
                          return h('div', { key: 'act-' + key, className: '__fd_actionRow' },
                            h('button', {
                              type: 'button',
                              className: '__fd_primary',
                              disabled: busy || result.status === 'done',
                              onClick: function () { props.onAction(action, key); },
                            }, t(busy ? 'chatActionRunning' : 'chatActionGo') + ' · ' + String(action.label || action.type || '')),
                            result.status === 'done'
                              ? h('span', { className: '__fd_okText' }, t('chatActionDone') + (result.note ? '：' + result.note : ''))
                              : null,
                            result.status === 'error'
                              ? h('span', { className: '__fd_error' }, t('chatActionFailed') + '：' + result.note)
                              : null);
                        }))
                    : null));
              }),
          sending
            ? h('div', { className: '__fd_bubbleRow' },
                h('div', { className: '__fd_bubble' },
                  h('div', { className: '__fd_bubbleWho' }, t('chatBot')),
                  h('div', { className: '__fd_bubbleText __fd_hint' }, t('chatSending'))))
            : null),
        chat.timedOut
        ? h('p', { className: '__fd_hint' }, t('chatTimedOut'))
        : null,
      chat.error ? h('p', { className: '__fd_error' }, t('chatFail') + '：' + chat.error) : null,
        h('div', { className: '__fd_chatInput' },
          h('textarea', {
            value: input,
            placeholder: t('chatPlaceholder'),
            rows: 2,
            disabled: sending,
            onChange: function (event) { setInput(event.target.value); },
            onKeyDown: onKeyDown,
          }),
          h('button', {
            type: 'button', className: '__fd_primary', disabled: sending || !String(input || '').trim(), onClick: submit,
          }, t(sending ? 'chatSending' : 'chatSend')))));
    }

    /* ------------------------------------------------------------------ *
     * 区 4：修复结果
     * ------------------------------------------------------------------ */
    function resultGroup(t, key, items) {
      return h('div', { className: '__fd_group' },
        h('div', { className: '__fd_groupHead' }, t(key) + ' · ' + items.length),
        items.map(function (item, index) {
          var text = stepText(t, item, key);
          var detail = stepDetail(item, key);
          return h('div', { key: key + '-' + index, className: '__fd_finding' },
            h('span', {
              className: '__fd_dot ' + (key === 'applied' ? '__fd_dotInfo' : key === 'failed' ? '__fd_dotBad' : '__fd_dotWarn'),
            }),
            h('div', { className: '__fd_findingBody' },
              h('div', { className: '__fd_findingTitle' }, text),
              detail ? h('div', { className: '__fd_hint' }, detail) : null));
        }));
    }

    function RepairSection(props) {
      var t = props.t;
      var repair = props.repair || { status: 'idle', applied: [], skipped: [], failed: [], error: '', busyId: '' };
      var findings = (props.diag && props.diag.findings) || [];
      var fixable = findings.filter(function (finding) {
        return finding && finding.repair && finding.repair.kind;
      }).length;
      var running = repair.status === 'running';

      return h(Section, {
        title: t('sectionRepair'),
        hint: t('sectionRepairHint'),
        right: h('button', {
          type: 'button', className: '__fd_primary',
          disabled: running || fixable === 0, onClick: props.onRepairAll,
        }, t(running ? 'repairing' : 'repairAll')),
      },
      h('p', { className: '__fd_hint' }, t('repairHint')),
      fixable === 0 && repair.status === 'idle' ? h('p', { className: '__fd_hint' }, t('nothingToFix')) : null,
      repair.error ? h('p', { className: '__fd_error' }, t('repairFail') + '：' + repair.error) : null,
      repair.status === 'done'
        ? h('p', { className: '__fd_okText' },
            t('repairDone')
              .replace('{a}', String((repair.applied || []).length))
              .replace('{s}', String((repair.skipped || []).length))
              .replace('{f}', String((repair.failed || []).length)))
        : null,
      (repair.applied || []).length ? resultGroup(t, 'applied', repair.applied) : null,
      (repair.skipped || []).length ? resultGroup(t, 'skipped', repair.skipped) : null,
      (repair.failed || []).length ? resultGroup(t, 'failed', repair.failed) : null);
    }

    /* ------------------------------------------------------------------ *
     * 页面：持有全部数据状态，三个区各自包 error boundary
     * ------------------------------------------------------------------ */
    function Page(props) {
      var t = props.t || function (key) { return key; };
      var bump = react.useState(0)[1];
      var snapPair = react.useState({ status: 'loading', data: null, error: '' });
      var snapshot = snapPair[0], setSnapshot = snapPair[1];
      var diagPair = react.useState({ status: 'idle', findings: [], summary: null, health: null, error: '', at: 0 });
      var diag = diagPair[0], setDiag = diagPair[1];
      var repairPair = react.useState({ status: 'idle', applied: [], skipped: [], failed: [], error: '', busyId: '' });
      var repair = repairPair[0], setRepair = repairPair[1];
      var chatPair = react.useState({ messages: [], status: 'idle', error: '', actionResults: {} });
      var chat = chatPair[0], setChat = chatPair[1];
      var billingPair = react.useState({ status: 'idle', snapshot: null, summary: null, error: '' });
      var billing = billingPair[0], setBilling = billingPair[1];

      /**
       * 读渠道插件的余额/积分。
       *
       * 必须在**浏览器侧**做：那些插件的接口用 harness 的 connection 围栏
       * 鉴权，认的是浏览器会话 cookie（Host 端裸请求一律 401，我实测过）。
       * 我们这份代码本来就跑在浏览器里，直接 fetch 就能过。
       */
      function loadBilling() {
        setBilling(function (previous) {
          return Object.assign({}, previous, { status: 'loading' });
        });
        // 动态 import：这个模块只在需要时才解析，减少首屏体积。
        return import('./lib/billing-client.js')
          .then(function (mod) {
            var providers = Array.isArray(mod.BILLING_PROVIDERS) ? mod.BILLING_PROVIDERS : [];
            if (providers.length === 0) {
              setBilling({ status: 'idle', snapshot: null, summary: null, error: '' });
              return null;
            }
            return mod.readBilling(providers[0], { baseURI: document.baseURI }).then(function (snapshot) {
              setBilling({
                status: snapshot.ok ? 'ready' : 'error',
                snapshot: snapshot,
                summary: mod.summarizeBilling(snapshot),
                error: snapshot.error || '',
              });
              return null;
            });
          })
          .catch(function (error) {
            setBilling({ status: 'error', snapshot: null, summary: null, error: humanError(t, error) });
            return null;
          });
      }


      function refreshState() {
        return api('/state').then(function (data) {
          setSnapshot({ status: 'ready', data: data || {}, error: '' });
        }).catch(function (error) {
          setSnapshot({ status: 'error', data: null, error: humanError(t, error) });
        });
      }

      function runDiagnose() {
        setDiag(function (previous) {
          return Object.assign({}, previous, {
            status: (previous.findings || []).length ? 'refreshing' : 'running',
            error: '',
          });
        });
        return api('/diagnose', { method: 'POST', body: {} }).then(function (data) {
          setDiag({
            status: 'ready',
            findings: Array.isArray(data.findings) ? data.findings : [],
            summary: data.summary || null,
            health: data.health === undefined ? null : data.health,
            error: '',
            at: data.scannedAt || Date.now(),
          });
        }).catch(function (error) {
          setDiag(function (previous) {
            return Object.assign({}, previous, { status: 'error', error: humanError(t, error) });
          });
        });
      }

      function runRepair(ids) {
        var list = Array.isArray(ids) ? ids.filter(Boolean) : [];
        setRepair({
          status: 'running', applied: [], skipped: [], failed: [], error: '',
          busyId: list.length === 1 ? list[0] : '',
        });
        return api('/repair', { method: 'POST', body: list.length ? { findingIds: list } : {} }).then(function (data) {
          setRepair({
            status: 'done',
            applied: Array.isArray(data.applied) ? data.applied : [],
            skipped: Array.isArray(data.skipped) ? data.skipped : [],
            failed: Array.isArray(data.failed) ? data.failed : [],
            error: '',
            busyId: '',
          });
          refreshState();
          runDiagnose();
        }).catch(function (error) {
          setRepair({
            status: 'error', applied: [], skipped: [], failed: [],
            error: humanError(t, error), busyId: '',
          });
        });
      }

      /**
       * 跳到「充值/额度」该去的地方。
       *
       * 框架医生读不到别家插件的余额（它们的接口走浏览器凭据，Host 拿不到），
       * 所以这里只做跳转：把用户送到真正管这些的那一页。
       * 默认跳 Our Free Model——免费车道和十三个白嫖渠道的积分都在那儿。
       */
      function openBilling() {
        var layout = props.ctx && props.ctx.get ? props.ctx.get('layout') : null;
        if (layout && typeof layout.selectPanel === 'function') {
          try {
            layout.selectPanel('settings');
          } catch (error) {
            void error;
          }
        }
        // 通知用户去哪儿：设置里那个页面管这件事。
        if (typeof window !== 'undefined' && window.console) {
          window.console.info(
            '[framework-doctor] 余额/积分/账号在「设置 → Our Free Model」里（或你装的其他模型渠道插件）',
          );
        }
      }

      /**
       * 发一条消息给框架医生。
       *
       * 后端现在跑的是**真 agent**：它自己带工具、流式、压缩、故障转移。
       * 所以这里不再自己拼历史——会话在 Host 侧持久，返回的 transcript 就是
       * 完整记录。我们只负责把这条记录画出来。
       */
      function runChat(text) {
        setChat(function (previous) {
          return Object.assign({}, previous, { status: 'running', error: '' });
        });
        return api('/chat', { method: 'POST', body: { message: text }, timeout: 200000 })
          .then(function (data) {
            setChat(function (previous) {
              return Object.assign({}, previous, {
                status: 'idle',
                error: '',
                sessionId: data.sessionId || previous.sessionId,
                agent: data.agent || null,
                timedOut: data.timedOut === true,
                // 直接采用 Host 侧的记录：刷新也不会丢，且是 agent 真正写下的。
                messages: Array.isArray(data.transcript) ? data.transcript : previous.messages,
              });
            });
          })
          .catch(function (error) {
            setChat(function (previous) {
              return Object.assign({}, previous, { status: 'idle', error: humanError(t, error) });
            });
          });
      }

      /** 只读拉取当前会话状态（页面打开时用，不创建、不投消息）。 */
      function loadChatState() {
        return api('/chat/state', { timeout: 20000 })
          .then(function (data) {
            if (!data || !data.agent || !data.agent.exists) return null;
            setChat(function (previous) {
              return Object.assign({}, previous, {
                sessionId: data.sessionId || '',
                agent: data.agent,
                messages: Array.isArray(data.transcript) ? data.transcript : previous.messages,
              });
            });
            return null;
          })
          .catch(function () { return null; });
      }

      /** 中断正在跑的这一轮。 */
      function stopChat() {
        return api('/chat/stop', { method: 'POST', body: {}, timeout: 20000 })
          .then(function () {
            setChat(function (previous) {
              return Object.assign({}, previous, { status: 'idle' });
            });
            return null;
          })
          .catch(function () { return null; });
      }

      /** 执行 AI 建议的动作：写操作只有用户按下这个按钮才会发生。 */
      function runChatAction(action, key) {
        var type = action && action.type ? String(action.type) : '';
        var args = action && action.args && typeof action.args === 'object' ? action.args : {};
        setChat(function (previous) {
          var results = Object.assign({}, previous.actionResults || {});
          results[key] = { status: 'running', note: '' };
          return Object.assign({}, previous, { actionResults: results });
        });
        function settle(status, note) {
          setChat(function (previous) {
            var results = Object.assign({}, previous.actionResults || {});
            results[key] = { status: status, note: note || '' };
            return Object.assign({}, previous, { actionResults: results });
          });
        }

        if (type === 'run-diagnose') {
          return runDiagnose().then(function () { settle('done', ''); })
            .catch(function (error) { settle('error', humanError(t, error)); });
        }
        if (type === 'repair-all') {
          return runRepair(null).then(function () { settle('done', ''); })
            .catch(function (error) { settle('error', humanError(t, error)); });
        }
        if (type === 'repair-one') {
          var id = args.id ? String(args.id) : '';
          if (!id) { settle('error', '缺少 findingId'); return Promise.resolve(); }
          return runRepair([id]).then(function () { settle('done', ''); })
            .catch(function (error) { settle('error', humanError(t, error)); });
        }
        if (type === 'probe' || type === 'apply-probe') {
          var baseURL = args.baseURL ? String(args.baseURL).trim() : '';
          if (!baseURL) { settle('error', '缺少 baseURL'); return Promise.resolve(); }
          var probeBody = { baseURL: baseURL };
          if (args.api) probeBody.api = String(args.api);
          if (args.apiKey) probeBody.apiKey = String(args.apiKey);
          return api('/probe', { method: 'POST', body: probeBody, timeout: 60000 }).then(function (probed) {
            var models = Array.isArray(probed.models) ? probed.models.filter(function (model) {
              return model && model.id;
            }) : [];
            if (type === 'probe') {
              settle('done', '探测到 ' + models.length + ' 个模型');
              return null;
            }
            var route = args.route ? String(args.route).trim() : '';
            if (!route) { settle('error', '缺少 route（配置名）'); return null; }
            var applyBody = {
              route: route,
              baseURL: baseURL,
              mergeModels: true,
              models: models.map(cleanModel),
            };
            if (args.api) applyBody.api = String(args.api);
            if (args.apiKey) applyBody.apiKey = String(args.apiKey);
            return api('/apply', { method: 'POST', body: applyBody, timeout: 60000 }).then(function (applied) {
              settle('done', '已写入 ' + route + '（' + (applied.written || models.length) + ' 个模型）');
              refreshState();
              runDiagnose();
            });
          }).catch(function (error) { settle('error', humanError(t, error)); });
        }
        settle('error', '不认识的动作类型：' + type);
        return Promise.resolve();
      }

      react.useEffect(function () {
        refreshState();
        runDiagnose();
        // 余额/积分从渠道插件那儿读（浏览器侧，带会话），失败也不影响主流程。
        loadBilling();
        if (props.locale && typeof props.locale.subscribe === 'function') {
          return props.locale.subscribe(function () { bump(function (value) { return value + 1; }); });
        }
      }, []);

      var data = snapshot.data || {};
      var providers = data.providers && typeof data.providers === 'object' ? data.providers : {};
      var routes = Object.keys(providers);
      var modelCount = routes.reduce(function (total, route) {
        var list = providers[route] && Array.isArray(providers[route].models) ? providers[route].models : [];
        return total + list.length;
      }, 0);
      var counts = countFindings(diag.findings, diag.summary);
      var score = healthScore(diag, data);

      return h('div', { className: '__fd_root dsh-flat' },
        h('div', { className: '__fd_head' },
          h('div', null,
            h('h3', null, t('title')),
            h('p', { className: '__fd_hint' }, t('intro'))),
          h('div', { className: '__fd_stats' },
            h('span', null, h('b', null, String(routes.length)), ' ', t('statProviders')),
            h('span', null, h('b', null, String(modelCount)), ' ', t('statModels')),
            h('span', null, t('statHealth'), ' ', h('b', { className: scoreClass(score) }, String(score))),
            h('span', null, t('statLastScan'), ' ', h('b', null, diag.at ? timeText(diag.at) : '—')))),

        snapshot.status === 'error'
          ? h('div', { className: '__fd_section' },
              h('div', { className: '__fd_secBody' },
                h('p', { className: '__fd_error' }, t('stateError') + '：' + snapshot.error),
                h('div', { className: '__fd_actions' },
                  h('button', { type: 'button', onClick: refreshState }, t('retry')))))
          : null,

        snapshot.status === 'loading'
          ? h('p', { className: '__fd_hint' }, t('loading'))
          : null,

        h(Boundary, { t: t, title: t('sectionOnboard') },
          h(OnboardSection, {
            t: t,
            providers: data.providers && typeof data.providers === 'object' ? data.providers : {},
            providerCount: routes.length,
            onApplied: function () { refreshState(); runDiagnose(); },
          })),

        h(Boundary, { t: t, title: t('sectionDiagnose') },
          h(DiagnoseSection, {
            t: t, diag: diag, counts: counts, score: score, data: data,
            channelCache: Array.isArray(data.channelCache) ? data.channelCache : [],
            billing: billing,
            onRun: runDiagnose,
            onRepairOne: function (id) { runRepair([id]); },
            onOpenBilling: openBilling,
            onRefreshBilling: loadBilling,
            onSavedModel: refreshState,
          })),

        h(Boundary, { t: t, title: t('sectionChat') },
          h(ChatSection, {
            t: t, chat: chat,
            onSend: runChat,
            onStop: stopChat,
            onAction: function (action, key) { runChatAction(action, key); },
            onClear: function () {
              // 清空显示并重置 Host 侧会话，下次提问是全新的一轮。
              setChat({ messages: [], status: 'idle', error: '', actionResults: {} });
              api('/chat', { method: 'POST', body: { reset: true }, timeout: 30000 }).catch(function () {});
            },
          })),

        h(Boundary, { t: t, title: t('sectionRepair') },
          h(RepairSection, {
            t: t, diag: diag, repair: repair,
            onRepairAll: function () { runRepair(null); },
          })));
    }

    /* ------------------------------------------------------------------ *
     * 注册
     * ------------------------------------------------------------------ */
    function apply(ctx) {
      var t = ctx.locale.bind(NS);
      ctx.effect(function () {
        return ctx.locale.register(NS, { zh: zh, en: en });
      }, 'dsh-framework-doctor: dictionaries');

      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register({
          name: 'settings.section',
          id: 'framework-doctor',
          order: 42,
          label: function () { return t('nav'); },
          locale: NS,
        }, function (props) {
          return h(Page, Object.assign({}, props, { t: t, locale: ctx.locale, ctx: ctx }));
        });
      });
    }

    return { name: 'framework-doctor', inject: ['slots', 'locale'], apply: apply };
  },
});
