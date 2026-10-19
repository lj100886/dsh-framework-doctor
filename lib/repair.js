/**
 * dsh-framework-doctor — 由体检结论生成修复计划（纯函数）
 *
 * 这里只生成**配置修改指令**（settings ops），不执行、不读写、不联网。
 * 执行在 `index.js`：它拿 `RepairPlan.steps[].op` 直接喂给
 * `ctx.settings.mutate('llm-pi-ai', ops, revision)`。
 *
 * 安全红线（CONTRACT.md「B. lib/repair.js」）：
 *   - 绝不生成会删用户数据的 op。唯一两个例外：
 *       * `drop-duplicate`：只删「同 route 内重复的 id」，保留第一条
 *       * `drop-reasoning`：只把 `reasoningEfforts` 设成 `false`，不删字段
 *   - 需要探测才能算的步骤（`probe-models` / `infer-*`）：
 *       `context.probed?.[route]` 存在 → 生成具体的 `set` op（合并后的模型数组）
 *       不存在 → `op: null` + `needsProbe: true`，由 index.js 探测后带 `context.probed` 重调
 *   - `planRepair` 幂等：同样的 findings + 同样的 `context.probed`，两次结果完全一致
 *
 * 两个文件之间的契约：`Finding.repair.kind` 就是这里的 `step.kind`，
 * `Finding.repair.payload` 原样进 `step.payload`，再按 kind 补齐/覆盖。
 */

/** 探测结果里允许回填到配置的模型字段（顺序固定，保证幂等输出）。 */
const PROBED_FIELDS = ['input', 'contextWindow', 'maxTokens', 'reasoningEfforts', 'compat'];

/** 会写回 `providers[route].models` 的 kind：它们都走同一套「合并后整列覆盖」。 */
const MODEL_LIST_KINDS = new Set([
  'probe-models',
  'infer-input',
  'infer-context',
  'infer-max-tokens',
  'infer-reasoning',
  'fix-model-id',
  'set-model-alias',
  'drop-duplicate',
  'drop-reasoning',
]);

/** 需要探测的 kind（probe 之后才能算 op）。 */
const PROBE_KINDS = new Set([
  'probe-models',
  'infer-input',
  'infer-context',
  'infer-max-tokens',
  'infer-reasoning',
]);

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 深拷贝成纯 JSON（避免把调用方的对象引用写进 op）。 */
function cloneJson(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

/** 取 route 的现有模型数组（永远是拷贝，调用方随便改）。 */
function existingModels(context, route) {
  const models = route === undefined ? undefined : context?.providers?.[route]?.models;
  if (!Array.isArray(models)) return [];
  return cloneJson(models);
}

/** 取该 route 的探测结果：优先 `context.probed`，其次步骤 payload 上的 `models`。 */
function probedModels(context, route, payload) {
  const fromContext = context?.probed;
  if (route !== undefined && isObject(fromContext) && Array.isArray(fromContext[route])) {
    return fromContext[route];
  }
  if (Array.isArray(payload?.models)) return payload.models;
  return undefined;
}

/** 只保留 schema 认识的字段，未知元数据剥掉（与 model-console 的 cleanModel 一致）。 */
function cleanModel(model) {
  const out = {};
  if (!isObject(model)) return out;
  if (typeof model.id === 'string') out.id = model.id;
  if (model.name !== undefined) out.name = model.name;
  if (model.contextWindow !== undefined) out.contextWindow = model.contextWindow;
  if (model.maxTokens !== undefined) out.maxTokens = model.maxTokens;
  if (model.input !== undefined) out.input = cloneJson(model.input);
  if (model.reasoningEfforts !== undefined) out.reasoningEfforts = cloneJson(model.reasoningEfforts);
  if (model.compat !== undefined) out.compat = cloneJson(model.compat);
  return out;
}

/**
 * 把探测结果并进现有模型列表。
 *
 * 语义（契约）：以现有 `providers[route].models` 为底，按 `id` 匹配，
 * 用探测结果覆盖 `input` / `contextWindow` / `maxTokens` / `reasoningEfforts` / `compat`；
 * 探测到但配置里没有的模型追加在后面。已有顺序不变，因此可重复调用。
 *
 * @returns {object[]} 合并后的模型数组
 */
function mergeModels(base, probed) {
  const out = base.map((model) => cleanModel(model));
  const indexById = new Map();
  for (let i = 0; i < out.length; i += 1) {
    const id = typeof out[i].id === 'string' ? out[i].id : '';
    if (id.length > 0 && !indexById.has(id)) indexById.set(id, i);
  }

  for (const raw of Array.isArray(probed) ? probed : []) {
    if (!isObject(raw)) continue;
    const id = typeof raw.id === 'string' ? raw.id : '';
    if (id.length === 0) continue;

    const at = indexById.get(id);
    if (at !== undefined) {
      const target = out[at];
      for (const field of PROBED_FIELDS) {
        if (raw[field] !== undefined) target[field] = cloneJson(raw[field]);
      }
      continue;
    }

    const appended = cleanModel(raw);
    appended.id = id;
    if (appended.name === undefined) appended.name = id;
    indexById.set(id, out.length);
    out.push(appended);
  }

  return out;
}

/** 生成「整列覆盖 models」的 op。 */
function modelsOp(route, models) {
  return { op: 'set', path: ['providers', route, 'models'], value: models };
}

/** 生成「写单个字段」的 op。 */
function fieldOp(route, field, value) {
  return { op: 'set', path: ['providers', route, field], value };
}

/** 构造一步。字段顺序固定，方便快照比对与幂等断言。 */
function step(findingId, kind, title, op, needsProbe, payload) {
  return {
    findingId,
    kind,
    title,
    op: op ?? null,
    needsProbe: Boolean(needsProbe),
    payload: payload ?? {},
  };
}

/* ------------------------------------------------------------------ *
 * 分派
 * ------------------------------------------------------------------ */

/**
 * 把一条 finding 变成一个修复步骤。
 *
 * @returns {{ step: object } | { skip: true }}
 */
function planOne(finding, context) {
  const repair = isObject(finding?.repair) ? finding.repair : undefined;
  const kind = typeof repair?.kind === 'string' ? repair.kind : '';
  if (kind.length === 0) return { skip: true };

  const payload = isObject(repair.payload) ? cloneJson(repair.payload) : {};

  // Finding 顶层就带 route / modelId；payload 里没写时回落到它们，
  // 这样即使上游只在 Finding 上填了这两个字段也能正确分派。
  const route =
    typeof payload.route === 'string' && payload.route.length > 0
      ? payload.route
      : typeof finding.route === 'string' && finding.route.length > 0
        ? finding.route
        : undefined;
  const modelId =
    typeof payload.modelId === 'string' && payload.modelId.length > 0
      ? payload.modelId
      : typeof finding.modelId === 'string' && finding.modelId.length > 0
        ? finding.modelId
        : '';

  const findingId = String(finding.id);
  const title = String(finding.title ?? findingId);
  const display = typeof payload.displayName === 'string' ? payload.displayName : route;

  /* ---------- 模型清单类：都要拿到 models 数组 ---------- */
  if (MODEL_LIST_KINDS.has(kind)) {
    const models = existingModels(context, route);

    /* 探测回填路径 */
    if (PROBE_KINDS.has(kind)) {
      const probed = probedModels(context, route, payload);
      if (probed !== undefined && route !== undefined) {
        const merged = mergeModels(models, probed);
        return {
          step: step(findingId, kind, title, modelsOp(route, merged), false, {
            ...payload,
            models: merged,
          }),
        };
      }
      // 还没探测：先要探测。route 未知（如 no-llm-provider）时没法探测。
      if (route === undefined) {
        return {
          step: step(findingId, kind, title, null, false, {
            ...payload,
            guide:
              typeof payload.guide === 'string'
                ? payload.guide
                : '先确认 llm-pi-ai 已加载并启用，然后在「接入向导」里添加 provider、探测模型清单并写入配置。',
          }),
        };
      }
      return {
        step: step(findingId, kind, title, null, true, { ...payload }),
      };
    }

    /* drop-reasoning：只把档位设成 false，绝不删字段。 */
    if (kind === 'drop-reasoning') {
      if (route === undefined || models.length === 0) {
        return {
          step: step(findingId, kind, title, null, false, {
            ...payload,
            guide: `把 ${display || '该提供方'} 里模型 "${modelId}" 的 reasoningEfforts 设为 false（该模型不支持思考档位）。`,
          }),
        };
      }
      let touched = false;
      const next = models.map((model) => {
        if (!isObject(model)) return model;
        if (String(model.id ?? '') !== modelId) return model;
        touched = true;
        return { ...model, reasoningEfforts: false };
      });
      if (!touched) {
        return {
          step: step(findingId, kind, title, null, false, {
            ...payload,
            guide: `模型 "${modelId}" 已不在配置里（可能被前面的步骤改过），跳过。`,
          }),
        };
      }
      return {
        step: step(findingId, kind, title, modelsOp(route, next), false, {
          ...payload,
          models: next,
        }),
      };
    }

    /* drop-duplicate：保留第一条，删掉重复 id 的后续条目。 */
    if (kind === 'drop-duplicate') {
      if (route === undefined || models.length === 0) {
        return {
          step: step(findingId, kind, title, null, false, {
            ...payload,
            guide: `在 ${display || '该提供方'} 的模型清单里只保留 "${modelId}" 的第一条，删掉重复项。`,
          }),
        };
      }
      const seen = new Set();
      const next = [];
      for (const model of models) {
        const id = isObject(model) ? String(model.id ?? '') : '';
        if (id.length > 0) {
          if (seen.has(id)) continue;
          seen.add(id);
        }
        next.push(model);
      }
      if (next.length === models.length) {
        return {
          step: step(findingId, kind, title, null, false, {
            ...payload,
            guide: `重复的 "${modelId}" 已经不在了（可能被前面的步骤改过），跳过。`,
          }),
        };
      }
      return {
        step: step(findingId, kind, title, modelsOp(route, next), false, {
          ...payload,
          models: next,
        }),
      };
    }

    /* fix-model-id / set-model-alias：改某个下标上的 id。 */
    if (kind === 'fix-model-id' || kind === 'set-model-alias') {
      const index = Number.isInteger(payload.index) ? payload.index : -1;
      const suggested = typeof payload.suggestedId === 'string' ? payload.suggestedId.trim() : '';
      const target =
        index >= 0 && index < models.length
          ? models[index]
          : models.find(
              (model) => isObject(model) && String(model.id ?? '') === String(payload.id ?? ''),
            );
      if (route === undefined || !isObject(target) || suggested.length === 0) {
        return {
          step: step(findingId, kind, title, null, false, {
            ...payload,
            guide:
              typeof payload.guide === 'string'
                ? payload.guide
                : `把模型 id 改成端点真实接受的模型名（建议 "${suggested || '小写连字符名'}"）。`,
          }),
        };
      }
      const next = models.map((model) => (model === target ? { ...model, id: suggested } : model));
      // 改完 id 之后可能和别的条目撞名：不在这里做删除，留给 duplicate-model 规则下次体检。
      const duplicated = next.filter((model) => String(model?.id ?? '') === suggested).length > 1;
      return {
        step: step(findingId, kind, title, modelsOp(route, next), false, {
          ...payload,
          suggestedId: suggested,
          models: next,
          ...(duplicated
            ? { note: `改完后 "${suggested}" 与其它条目重名，需要再体检一次处理重复。` }
            : {}),
        }),
      };
    }
  }

  /* ---------- 单字段 / 人工类 ---------- */
  switch (kind) {
    /* set-base-url：需要外部给出地址；没有地址时不瞎填。 */
    case 'set-base-url': {
      const fromPayload = typeof payload.baseURL === 'string' ? payload.baseURL.trim() : '';
      const fromContext =
        route !== undefined && typeof context?.baseURLs?.[route] === 'string'
          ? context.baseURLs[route].trim()
          : '';
      const baseURL = fromPayload || fromContext;
      if (route === undefined || baseURL.length === 0) {
        return {
          step: step(findingId, kind, title, null, false, {
            ...payload,
            guide: `给 ${display || '该提供方'} 填上端点根地址（OpenAI 兼容网关通常以 /v1 结尾），保存后重新体检。`,
          }),
        };
      }
      return {
        step: step(findingId, kind, title, fieldOp(route, 'baseURL', baseURL), false, {
          ...payload,
          baseURL,
        }),
      };
    }

    /* set-credential-ref：只加一个引用名，不碰任何已有值。 */
    case 'set-credential-ref': {
      const apiKeyEnv =
        typeof payload.apiKeyEnv === 'string' && payload.apiKeyEnv.trim().length > 0
          ? payload.apiKeyEnv.trim()
          : route
            ? `${String(route).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
            : '';
      if (route === undefined || apiKeyEnv.length === 0) {
        return {
          step: step(findingId, kind, title, null, false, {
            ...payload,
            guide: `给 ${display || '该提供方'} 补一个 apiKeyEnv 引用，并把密钥存进凭据服务。`,
          }),
        };
      }
      return {
        step: step(findingId, kind, title, fieldOp(route, 'apiKeyEnv', apiKeyEnv), false, {
          ...payload,
          apiKeyEnv,
        }),
      };
    }

    /* set-placeholder-key：本地端点的占位头，只加不删其它 header。 */
    case 'set-placeholder-key': {
      if (route === undefined) {
        return {
          step: step(findingId, kind, title, null, false, {
            ...payload,
            guide: '给本地端点加一个 Authorization 头（值可以是任意占位串，如 Bearer local）。',
          }),
        };
      }
      const headerName =
        typeof payload.header === 'string' && payload.header.trim().length > 0
          ? payload.header.trim()
          : 'Authorization';
      const value =
        typeof payload.value === 'string' && payload.value.length > 0
          ? payload.value
          : 'Bearer local';
      const existingHeaders = isObject(context?.providers?.[route]?.headers)
        ? cloneJson(context.providers[route].headers)
        : {};
      // 只覆盖同名 header（大小写不敏感），其余 header 原样保留。
      const nextHeaders = {};
      for (const key of Object.keys(existingHeaders).sort()) {
        if (key.toLowerCase() === headerName.toLowerCase()) continue;
        nextHeaders[key] = existingHeaders[key];
      }
      nextHeaders[headerName] = value;
      return {
        step: step(findingId, kind, title, fieldOp(route, 'headers', nextHeaders), false, {
          ...payload,
          header: headerName,
          value,
          headers: nextHeaders,
        }),
      };
    }

    /* open-credential：凭据存储只能人工操作。 */
    case 'open-credential': {
      const apiKeyEnv = typeof payload.apiKeyEnv === 'string' ? payload.apiKeyEnv : '';
      return {
        step: step(findingId, kind, title, null, false, {
          ...payload,
          guide:
            typeof payload.guide === 'string'
              ? payload.guide
              : `在凭据服务里为 ${apiKeyEnv || '该 apiKeyEnv 引用'} 存入密钥，然后重新体检。`,
        }),
      };
    }

    /* move-secret-to-ref：搬密钥要读写凭据存储，只能人工。 */
    case 'move-secret-to-ref': {
      const header = typeof payload.header === 'string' ? payload.header : 'headers';
      return {
        step: step(findingId, kind, title, null, false, {
          ...payload,
          guide:
            typeof payload.guide === 'string'
              ? payload.guide
              : `把 ${header} 里的明文密钥存进凭据服务，改成 apiKeyEnv 引用后删掉这个 header。`,
        }),
      };
    }

    /* reload-plugin：宿主插件生命周期不归本插件管。 */
    case 'reload-plugin': {
      const pluginName = typeof payload.pluginName === 'string' ? payload.pluginName : '该插件';
      return {
        step: step(findingId, kind, title, null, false, {
          ...payload,
          guide:
            typeof payload.guide === 'string'
              ? payload.guide
              : `修复 ${pluginName} 的加载错误后，在插件页重载它。`,
        }),
      };
    }

    /* fix-route：先修这条 route 的其它致命问题，再重载。 */
    case 'fix-route': {
      return {
        step: step(findingId, kind, title, null, false, {
          ...payload,
          guide:
            typeof payload.guide === 'string'
              ? payload.guide
              : `先修正 route "${route ?? ''}" 的其余致命问题（baseURL / 凭据 / 模型 id / 重复模型），再重载 llm-pi-ai。`,
        }),
      };
    }

    /* set-default-model：默认模型在 agent-default-model，不在 llm-pi-ai。 */
    case 'set-default-model': {
      const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
      const preferred = candidates.find(
        (row) =>
          isObject(row) &&
          typeof row.provider === 'string' &&
          row.provider.length > 0 &&
          typeof row.model === 'string' &&
          row.model.length > 0,
      );
      if (!preferred) {
        return {
          step: step(findingId, kind, title, null, false, {
            ...payload,
            guide: '先在「接入向导」里配置一个可用的 provider 与模型，再把默认模型切过去。',
          }),
        };
      }
      const selection = { provider: preferred.provider, model: preferred.model };
      return {
        step: step(findingId, kind, title, null, false, {
          ...payload,
          selection,
          guide: `把默认模型改成 ${selection.provider} / ${selection.model}。`,
        }),
      };
    }

    /* set-reasoning-effort：整份 selection 交给 agentDefaultModel.saveSelection()。 */
    case 'set-reasoning-effort': {
      const provider = typeof payload.provider === 'string' ? payload.provider : '';
      const model = typeof payload.model === 'string' ? payload.model : '';
      const effort =
        typeof payload.reasoningEffort === 'string' && payload.reasoningEffort.length > 0
          ? payload.reasoningEffort
          : 'medium';
      if (provider.length === 0 || model.length === 0) {
        return {
          step: step(findingId, kind, title, null, false, {
            ...payload,
            guide: '先确定默认模型，再给它选一个思考档位（建议 medium）。',
          }),
        };
      }
      const selection = { provider, model, reasoningEffort: effort };
      return {
        step: step(findingId, kind, title, null, false, {
          ...payload,
          reasoningEffort: effort,
          selection,
          guide: `把默认模型的思考档位设为 ${effort}。`,
        }),
      };
    }

    default:
      return { skip: true };
  }
}

/* ------------------------------------------------------------------ *
 * 对外接口
 * ------------------------------------------------------------------ */

/**
 * 把体检结论变成修复计划。
 *
 * @param {object[]} findings  diagnoseConfig / diagnoseRuntime 的输出
 * @param {object} [context]   `{ providers, defaultSelection, probed, baseURLs? }`
 *   - `providers`：llm-pi-ai 的 providers 字典（改 models / headers 的底稿）
 *   - `probed`：`{ [route]: InferredModel[] }`，探测回填后的模型清单
 * @returns {{ steps: object[], skipped: object[] }}
 */
export function planRepair(findings, context) {
  const list = Array.isArray(findings) ? findings : [];
  const ctx = isObject(context) ? context : {};
  const steps = [];
  const skipped = [];

  for (const finding of list) {
    if (!isObject(finding)) continue;
    const planned = planOne(finding, ctx);
    if (planned.skip) {
      skipped.push(finding);
      continue;
    }
    steps.push(planned.step);
  }

  return { steps, skipped };
}

/** 每步的默认中文说明（describeRepair 的兜底，按 kind 分组）。 */
const KIND_SUMMARY = {
  'set-base-url': '写入提供方端点地址（baseURL）。',
  'set-credential-ref': '补上 apiKeyEnv 引用名（密钥仍需存进凭据服务）。',
  'open-credential': '需要在凭据服务里补上密钥，无法自动完成。',
  'move-secret-to-ref': '需要把明文密钥搬进凭据服务，无法自动完成。',
  'probe-models': '探测端点模型清单，合并后写入配置。',
  'fix-model-id': '把不合法的模型 id 改成合法值。',
  'set-model-alias': '把模型 id 改成服务端别名（需先在服务端设置 --alias）。',
  'infer-input': '按端点探测结果补全输入模态。',
  'infer-context': '按端点探测结果补全上下文窗口。',
  'infer-max-tokens': '按端点探测结果补全输出上限。',
  'infer-reasoning': '按家族补全思考档位表。',
  'drop-reasoning': '把该模型的 reasoningEfforts 设为 false（不删字段）。',
  'drop-duplicate': '删掉同 route 内重复的模型 id，保留第一条。',
  'fix-route': '需要先修好该 route 的其它致命问题，再重载插件。',
  'set-default-model': '把默认模型切到一个真实可用的 provider / 模型。',
  'set-reasoning-effort': '给默认模型显式指定思考档位。',
  'set-placeholder-key': '给本地端点补一个占位 Authorization 头。',
  'reload-plugin': '需要人工在插件页重载该插件。',
};

/**
 * 把一步修复翻译成给用户看的一句中文。
 *
 * 有 `payload.guide` 的（人工步骤）优先返回指引；否则按 kind 给动作摘要，
 * 并附上具体的路径/取值，方便用户核对将要写入什么。
 *
 * @param {object} step planRepair 产出的 RepairStep
 * @returns {string}
 */
export function describeRepair(step) {
  if (!isObject(step)) return '无效的修复步骤。';

  const guide = typeof step.payload?.guide === 'string' ? step.payload.guide.trim() : '';
  if (guide.length > 0) return guide;

  const summary = KIND_SUMMARY[step.kind] ?? '';
  const op = step.op;
  const title = typeof step.title === 'string' ? step.title : String(step.findingId ?? '');

  if (!isObject(op)) {
    if (step.needsProbe) {
      return `${summary || '需要先探测端点。'}（${title}）`;
    }
    return summary || `无法自动修复：${title}`;
  }

  const path = Array.isArray(op.path) ? op.path.join('.') : '';
  if (op.op === 'set') {
    const value = op.value;
    let rendered;
    if (Array.isArray(value)) {
      rendered = `数组（${value.length} 项）`;
    } else if (isObject(value)) {
      const keys = Object.keys(value);
      rendered = `对象（${keys.length > 0 ? keys.join(', ') : '空'}）`;
    } else {
      rendered = JSON.stringify(value);
    }
    return `${summary || '写入配置'} 目标 ${path} = ${rendered}`;
  }
  if (op.op === 'unset') {
    return `${summary || '移除配置项'} 目标 ${path}`;
  }
  return summary || `修复 ${title}`;
}

export { MODEL_LIST_KINDS, PROBE_KINDS };
