/**
 * Unit tests for the framework-doctor model-chain semantics that
 * POST /assistant-model relies on.
 *
 * The Host route normalizes the posted chain; these tests cover the rules it
 * must hold: dedupe, empty-field rejection, truncation, fallback preservation.
 *
 * Run:  node test-assistant-model.mjs
 */
import assert from 'node:assert/strict'

let passed = 0
let failed = 0
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok  ${name}`) }
  catch (e) { failed++; console.log(`FAIL  ${name}\n      ${e?.message ?? e}`) }
}

/** Mirror of the normalization in index.js POST /assistant-model. */
function normalizeChain(chain) {
  const entries = []
  const seen = new Set()
  for (const row of chain) {
    if (!row || typeof row !== 'object') continue
    const provider = typeof row.provider === 'string' ? row.provider.trim() : ''
    const model = typeof row.model === 'string' ? row.model.trim() : ''
    if (!provider || !model) continue
    const key = provider + '\0' + model
    if (seen.has(key)) continue
    seen.add(key)
    entries.push({ provider, model })
    if (entries.length >= 8) break
  }
  return entries
}

/** Mirror of the chain the UI derives for display. */
function deriveChain(configured, selection, fallback) {
  const rows = configured.map((e) => ({ ...e, source: 'chain' }))
  if (fallback && selection?.provider && selection?.model &&
      !rows.some((e) => e.provider === selection.provider && e.model === selection.model)) {
    rows.push({ provider: selection.provider, model: selection.model, source: 'default' })
  }
  return rows
}

console.log('normalizeChain')
await test('keeps well-formed entries in order', () => {
  const out = normalizeChain([
    { provider: 'our-free-model', model: 'z-ai/glm-5.3' },
    { provider: 'buddy', model: 'deepseek-v4.1-flash' },
  ])
  assert.deepEqual(out, [
    { provider: 'our-free-model', model: 'z-ai/glm-5.3' },
    { provider: 'buddy', model: 'deepseek-v4.1-flash' },
  ])
})

await test('drops entries with an empty side', () => {
  const out = normalizeChain([
    { provider: '', model: 'x' },
    { provider: 'p', model: '' },
    { provider: 'p', model: 'ok' },
  ])
  assert.deepEqual(out, [{ provider: 'p', model: 'ok' }])
})

await test('trims surrounding whitespace', () => {
  const out = normalizeChain([{ provider: '  p  ', model: '\tm\n' }])
  assert.deepEqual(out, [{ provider: 'p', model: 'm' }])
})

await test('dedupes, keeping the first position', () => {
  const out = normalizeChain([
    { provider: 'a', model: '1' },
    { provider: 'b', model: '2' },
    { provider: 'a', model: '1' },
  ])
  assert.deepEqual(out, [
    { provider: 'a', model: '1' },
    { provider: 'b', model: '2' },
  ])
})

await test('skips non-object rows', () => {
  const out = normalizeChain([null, 'x', 42, undefined, { provider: 'p', model: 'm' }])
  assert.deepEqual(out, [{ provider: 'p', model: 'm' }])
})

await test('truncates at 8 hops', () => {
  const chain = Array.from({ length: 20 }, (_, i) => ({ provider: 'p', model: String(i) }))
  assert.equal(normalizeChain(chain).length, 8)
})

await test('an empty chain is legal (means: follow the default)', () => {
  assert.deepEqual(normalizeChain([]), [])
})

console.log('\nderiveChain')
await test('appends the default model as the last resort', () => {
  const rows = deriveChain(
    [{ provider: 'p', model: 'm' }],
    { provider: 'd', model: 'x' },
    true,
  )
  assert.equal(rows.length, 2)
  assert.equal(rows[1].source, 'default')
  assert.deepEqual([rows[1].provider, rows[1].model], ['d', 'x'])
})

await test('does not duplicate a default already in the chain', () => {
  const rows = deriveChain(
    [{ provider: 'd', model: 'x' }],
    { provider: 'd', model: 'x' },
    true,
  )
  assert.equal(rows.length, 1)
  assert.equal(rows[0].source, 'chain')
})

await test('fallback off means the default is never appended', () => {
  const rows = deriveChain(
    [{ provider: 'p', model: 'm' }],
    { provider: 'd', model: 'x' },
    false,
  )
  assert.equal(rows.length, 1)
  assert.equal(rows[0].source, 'chain')
})

await test('a null selection is tolerated', () => {
  const rows = deriveChain([{ provider: 'p', model: 'm' }], null, true)
  assert.equal(rows.length, 1)
})

await test('an empty configured chain plus fallback yields exactly the default', () => {
  const rows = deriveChain([], { provider: 'd', model: 'x' }, true)
  assert.deepEqual(rows, [{ provider: 'd', model: 'x', source: 'default' }])
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
