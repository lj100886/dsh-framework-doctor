<p align="center">
  <img src="icon.svg" width="72" alt="Framework Doctor icon">
</p>

# dsh-framework-doctor

English | [中文](README.zh.md)

A DeepSeek Harness plugin that configures model providers by probing their
endpoint, checks framework health, and repairs what can be fixed — from a
standalone settings page. Nothing runs in the background.

## What it does

The plugin adds one page: **Settings → Framework doctor**. It has four sections.

### 1. Connect a model

Paste an endpoint URL and an API key, press **Probe**, and the plugin asks
`{baseURL}/models` for the model list, then derives each model's capabilities:

| Derived field | Source |
|---|---|
| Input modalities (`text` / `image`) | endpoint metadata, then the model-family table |
| Context window, max output tokens | endpoint metadata, then the family table |
| Reasoning efforts | the family table (or `false` for a non-reasoning model) |
| `compat.thinkingFormat` | the family table (`deepseek`, `qwen-chat-template`, `zai`, `openrouter`, `openai`) |

Anything the endpoint does not state and the family table cannot infer is left
**empty rather than guessed** — a wrong reasoning-effort map makes the whole
provider fail its request. Each row shows whether its values were declared by
the endpoint or inferred, so you can tell the two apart before writing.

Already-configured providers can be re-probed and filled in the same way: pick
one from the dropdown and the form is populated (the stored credential is reused,
so you do not retype the key). Writing in that mode **merges** — models you
hand-wrote are kept, newly advertised models are appended, and capability fields
are filled in from the endpoint.

API keys are stored through the harness credential service; the config keeps only
an `apiKeyEnv` reference, never the key itself.

### 2. Framework checkup

23 checks run against the live configuration and runtime state: 18 against the
`llm-pi-ai` provider config, 5 against runtime facts (plugin load phase,
registered providers, the default model).

They cover the failures that actually happen: a hand-written provider with no
`baseURL`, a credential reference that resolves to nothing, a plaintext key left
in `headers`, a reasoning model with no effort map, a **non-reasoning model
carrying one** (a 400 on every request), duplicate model ids, a default model
pointing at a provider that does not exist, and so on.

Providers registered by *other* plugins are reported as `external-provider`
(info) rather than as missing configuration — a provider is considered real when
it is registered with the model service, not only when it appears in this config.

### 3. Talk to the doctor

A chat box. You describe what you want; the assistant looks up the real state
before answering. It can request framework data on demand through six read-only
tools:

| Tool | What it returns |
|---|---|
| `state` | Provider list with baseURL, protocol, credential state, and per-model modalities / context / output cap / reasoning efforts; the default model; registered routes |
| `diagnose` | The full checkup result with severities |
| `plugins` | Plugin rows: package, enabled flag, load phase |
| `tools` | The tools this agent can currently call |
| `provider` | One provider's full config (keys redacted) |
| `probe` | Live endpoint interrogation |

The assistant writes `TOOL: {"name":"...","args":{...}}`, the host runs it and
feeds the result back, up to 4 rounds. The page shows which tools it consulted.

Anything the assistant suggests that *changes* something is rendered as a button
you have to press: re-run the checkup, auto-repair, repair one finding, probe an
endpoint, or probe-and-write a provider. The model never edits configuration on
its own.

### 4. Repair

Auto-fixable findings can be applied in one click. Repairs are generated as
`settings.mutate` operations: they only ever produce `set`, never `unset`, with
two deliberate exceptions (drop a duplicate model id, and set `reasoningEfforts`
to `false` on a model that should not have one).

### Session failover

When a model call fails with a retryable error — `RATE_LIMIT` (429), `QUOTA`,
`SERVER`, `TIMEOUT`, `TRANSPORT`, `EMPTY_RESPONSE` — the plugin looks for the
**same model on another configured channel** and retries there, so the session
keeps going instead of stalling.

It hooks two harness events:

| Event | Role |
|---|---|
| `agent/request-error` | Decide whether to fail over. Returning `{ kind: 'retry' }` makes the agent loop retry inside the same turn and step. |
| `agent/request` | Replace the provider/model for that retry with the chosen channel. |

Selection is conservative:

1. **Same model id** on another provider that has a `baseURL` and is registered
   with the model service.
2. Failing that, the **same model after stripping a vendor prefix** (so
   `deepseek/deepseek-v3` on a gateway matches `deepseek-v3` elsewhere).
3. If neither exists, the error is left terminal — it is not silently swapped for
   a different model.

A failed route enters a cooldown, but the length is **derived from the error**, not
fixed: quota exhaustion waits far longer than a rate limit, and a gateway 5xx or a
network blip is retried sooner. An endpoint's own `Retry-After` always wins; if it
says "retry in a second", the plugin retries in place rather than switching
channels. Repeated failures on the same route double its cooldown, and one success
clears the record.

Every failure is also recorded as a channel health record — error type, severity,
whether it looks like a billing/quota problem, consecutive count, and remaining
cooldown. The chat section can read it through the `channel-health` tool and
answer "which channel is broken, how badly, do I need to top up, and roughly when
will it recover". The reasoning stays in the chat: the retry path itself never
calls a model (it runs on the failure path, where a model call could deadlock and
would add latency), so failover decisions are deterministic and instant while the
explanations are written by the model afterwards.

Disable it (or cap the cooldown) in the row config:

```yaml
- id: framework-doctor
  config:
    failover: true
    failoverMaxCooldownMs: 3600000
```

### Which model the doctor uses

The chat section does not have to share your default model. Configure a fallback
chain and the doctor follows it in order, hopping to the next entry whenever one
fails — so a 429 on the first channel does not leave you with a doctor that
cannot diagnose:

```yaml
- id: framework-doctor
  config:
    model:
      chain:
        - provider: cheap-chan
          model: deepseek-v4.1-flash
        - provider: reliable-chan
          model: deepseek-v4.1-flash
      fallbackToDefaultModel: true   # append the session default as the last resort
```

Without `model.chain` it simply follows the default model, which is the old
behaviour. The page shows the resolved chain in order, dimming any hop that is
currently in cooldown.

### Billing problems

When a failure looks like quota or rate limiting rather than a broken endpoint,
the page says so and offers to take you to the page that actually owns your
balance. It cannot show the balance itself — see
[Why it cannot read other plugins' billing](#why-it-cannot-read-other-plugins-billing).

## Install

```sh
dsh plugin --profile <your-profile> add dsh-framework-doctor
```

Or from a local checkout:

```sh
dsh plugin --profile <your-profile> add /absolute/path/to/dsh-framework-doctor
```

Restart `dsh web` if the page does not appear, then open **Settings → Framework
doctor**.

## What it deliberately does not do

- **No background scanning.** Health checks run when you press a button. There is
  no timer and no polling.
- **No automatic configuration changes.** Every write is either a click in the
  connect wizard or a click on an assistant-suggested action.
- **No plaintext secrets.** Keys go to the credential service; `headers` values
  are checked for plaintext keys and reported.
- **No guessing.** Unverifiable model capabilities are left unset.

## Reading other channel plugins

Two different data sources, because they have two different access models.

**Local caches — Host reads the files.** Channel plugins keep their availability
verdict on disk (for `dsh-our-free-model`: `$DSH_HOME/our-free-model/`). Those
files need no authentication, so the Host reads them directly and reports what
the *endpoint itself* said, which is far more useful than an error code:

```
Our Free Model (checked 2026-10-20T14:20:56Z)
  egress: 203.0.113.7 (CN)
  flagged as abusive traffic, service refused (10 models — switching model will
  not help, the egress IP needs to change):
    · big-pickle: ...we've detected abusive traffic from this IP address...
```

`availability.json` carries per-model state and the endpoint's own detail string;
`catalog.json` carries the advertised list. Both are read read-only, and a missing
or malformed file just yields an empty result.

**Live billing — the browser reads it.** Balance and credits are *not* cached to
disk; they are fetched live from the upstream gateways. Those endpoints sit
behind the harness connection fence, so a Host request gets 401 — but this
plugin's page runs *in the browser*, with the same session cookie, so it can call
them directly. That is why billing is read client-side while availability is read
Host-side.

When a failure looks like quota, the page shows the live balance plus a link to
the page that owns the account. It never invents a number: if the channel plugin
is absent, not signed in, or changed its API, the panel says so quietly and stops
there.

## Requirements

- DeepSeek Harness `>=0.2.0` (`engines.dsh`; also declared under
  `dsh.compatibility`)
- Node.js `>=20.18`
- A configured default model, for the chat section only. Everything else works
  without one.

No runtime dependencies. The plugin uses only Node built-ins and the harness
services it injects.

## Development

```sh
node tests/run-all.mjs    # or: npm test
```

Three suites, none of which need a running harness:

| Suite | Checks |
|---|---|
| `tests/framework-doctor-lib.mjs` | `lib/infer.js` capability derivation, `lib/diagnose.js` rules, `lib/repair.js` plans, plus an end-to-end probe against a local fake OpenAI-compatible endpoint |
| `tests/framework-doctor-failover.mjs` | Retryable-error classification, channel selection, cooldown bookkeeping, and the host wiring that turns a 429 into a switch-and-retry |
| `tests/framework-doctor-host.mjs` | Host routes, `/apply` validation and merge semantics, `/chat` tool loop, the trust fence, and degradation when a service is missing |
| `tests/framework-doctor-client.mjs` | Loads `client.js` against a stubbed module loader and React, renders every section, and checks theme-token and boundary constraints |

### Layout

| File | Role |
|---|---|
| `index.js` | Host entry: HTTP routes, settings read/write, the chat tool loop |
| `client.js` | The settings page (plain JS + `createElement`, no build step) |
| `lib/infer.js` | Endpoint interrogation and capability derivation |
| `lib/diagnose.js` | The checkup rules |
| `lib/repair.js` | Findings to `settings.mutate` operations |
| `lib/failover.js` | Retryable-error classification and same-model channel selection |
| `lib/trust.js` | Request trust fence for the plugin's HTTP surface |

## License

MIT — see [LICENSE](LICENSE).