# Changelog

## Unreleased

- **Session failover** — when a model call fails with a retryable error
  (`RATE_LIMIT`/429, `QUOTA`, `SERVER`, `TIMEOUT`, `TRANSPORT`,
  `EMPTY_RESPONSE`), the plugin looks for the same model on another configured
  channel and retries there in the same turn, instead of leaving the session
  stuck. Errors a different channel cannot fix (credential, unknown model,
  HTTP 400/401) never trigger it. `failover: false` in the row config turns it
  off.
- **Cooldowns derived from the error** — quota waits far longer than a rate
  limit, a 5xx or network blip retries sooner, an endpoint's `Retry-After` wins
  outright (and a very short one retries in place instead of switching).
  Consecutive failures double the cooldown; one success clears it.
- **Channel health records** — every failure is kept as a record (error type,
  severity, billing flag, consecutive count, remaining cooldown), exposed at
  `/state` and through a new `channel-health` info tool, so the chat section can
  explain which channel is broken, how badly, whether the user needs to top up,
  and roughly when it recovers.

## 0.1.0 — 2026-10-19

First release.

- **Connect a model** — probe an endpoint, derive input modalities, context
  window, output cap, reasoning efforts, and `compat.thinkingFormat`; write the
  provider config with the key stored in the credential service.
- **Fill in existing providers** — pick a configured provider, re-probe it, and
  merge (hand-written models kept, new models appended, capability fields filled
  in).
- **Framework checkup** — 23 checks: 18 against the `llm-pi-ai` provider config
  and 5 against runtime state, including plugin load phase and the default
  model.
- **Chat section** — the assistant requests framework data through six read-only
  tools (`state`, `diagnose`, `plugins`, `tools`, `provider`, `probe`) and
  suggests changes as buttons that only run when pressed.
- **Repair** — auto-fixable findings become `settings.mutate` operations that
  only ever `set`, never `unset`.
- No background scanning, no automatic configuration writes, no plaintext
  secrets in the config.

### Fixed during development

- A checkup rule for "a non-reasoning model carrying a reasoning-effort map"
  could never fire, because the classifier returned `reasoning` as soon as it
  saw an effort map. It now classifies by model name only.
- A default model pointing at a provider registered by another plugin was
  reported as missing. Providers are now considered real when they are
  registered with the model service, not only when they appear in the config.
  Such providers are reported once as `external-provider` (info).