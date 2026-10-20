# Changelog

## Unreleased

- **Reads channel plugins, across two access models** — availability verdicts are
  read by the Host straight off disk (`$DSH_HOME/our-free-model/availability.json`),
  so the report carries what the endpoint itself said — "flagged as abusive
  traffic", "not available in your country", plus the egress IP — instead of a
  bare 429. Live balance is read by the browser, because those endpoints sit
  behind the connection fence and answer 401 to a Host request, while this
  plugin's page carries the same session cookie. Both paths degrade quietly when
  the channel plugin is absent or changed.
- New `channel-cache` info tool and a channel-cache panel; billing panel with a
  refresh control.

- **A model of its own, with a fallback chain** — the chat section no longer has
  to share your default model. `config.model.chain` is an ordered list the
  doctor walks through, hopping to the next entry whenever one fails, so a 429
  on the first channel does not leave you with a doctor that cannot diagnose.
  `fallbackToDefaultModel` (on by default) appends the session default as the
  last resort. Omitting `model.chain` keeps the old follow-the-default
  behaviour. The page lists the resolved chain and dims hops in cooldown.
- **Billing is surfaced, not guessed** — failures that look like quota or rate
  limiting are labelled as such and the page offers a jump to the channel
  plugin that owns the account. It does not display someone else's balance:
  channel plugins keep that behind their own UI (their HTTP API returns 401 to
  a Host request, and they publish no `ctx.provide()` service), and their stats
  carry usage only. A wrong number there would be worse than none.

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