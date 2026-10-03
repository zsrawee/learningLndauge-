/**
 * One command that checks the whole app is wired correctly.
 * Run before handing the app to anyone: `node tools/verify.mjs`
 */
import { readFileSync } from 'node:fs'

let pass = 0, fail = 0
const results = []

async function group(name, fn) {
  console.log(`\n── ${name} ${'─'.repeat(Math.max(0, 56 - name.length))}`)
  try { await fn() } catch (e) { fail++; console.log(`  FAIL  threw: ${e.message}`) }
}

function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok    ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' :: ' + detail : ''}`); results.push(name) }
}

const BASE = 'http://127.0.0.1:4180'

// ---------------------------------------------------------------- source
await group('source files', async () => {
  for (const f of ['server.mjs', 'lib/provider.mjs', 'lib/pipeline.mjs',
    'lib/transcribe.mjs', 'lib/analyze.mjs', 'lib/edit.mjs', 'lib/speech.mjs',
    'lib/store.mjs', 'public/app.js']) {
    const src = readFileSync(f, 'utf8')
    ok(`${f} is non-empty`, src.length > 100)
  }
  // No leftover debugging.
  const app = readFileSync('public/app.js', 'utf8')
  ok('no console.log left in client', !/console\.log\(/.test(app))
  const provider = readFileSync('lib/provider.mjs', 'utf8')
  ok('no hardcoded api key', !/sk-[a-z0-9-]{20,}/i.test(provider))
})

// ---------------------------------------------------------------- server
await group('server', async () => {
  const state = await (await fetch(`${BASE}/api/state`)).json()
  ok('state responds', state.ok === true)
  ok('settings present', typeof state.settings === 'object')
  ok('secrets are masked', state.secrets?.analysisApiKey !== undefined)
  ok('no raw key leaked to browser',
    !JSON.stringify(state).match(/"(sk-|AQ\.|kn-)[A-Za-z0-9_-]{10,}"/))

  const page = await (await fetch(`${BASE}/`)).text()
  ok('page served', page.length > 2000)
  for (const id of ['liveBox', 'liveLog', 'modelBox', 'modelListBody',
    'modelSearch', 'autoProvider', 'analysisKey', 'provider', 'model']) {
    ok(`page contains #${id}`, page.includes(`id="${id}"`))
  }
})

// --------------------------------------------------------------- stream
await group('live stream', async () => {
  const controller = new AbortController()
  const res = await fetch(`${BASE}/api/progress`, { signal: controller.signal })
  ok('stream opens with 200', res.status === 200)
  ok('stream is event-stream',
    (res.headers.get('content-type') ?? '').includes('text/event-stream'))

  const reader = res.body.getReader()
  const { value } = await reader.read()
  const hello = new TextDecoder().decode(value)
  ok('stream sends a hello frame', hello.includes('"type":"hello"'))

  controller.abort()
  await reader.cancel().catch(() => {})
})

// -------------------------------------------------------------- routing
await group('provider resolution', async () => {
  // Every known provider must build a correct chat URL.
  const { chatUrl } = await import('../lib/provider.mjs')
  const cases = [
    ['https://openrouter.ai/api/v1', 'https://openrouter.ai/api/v1/chat/completions'],
    ['http://localhost:1234', 'http://localhost:1234/v1/chat/completions'],
    ['https://api.openai.com/v1', 'https://api.openai.com/v1/chat/completions'],
    ['https://generativelanguage.googleapis.com/v1beta/openai',
      'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'],
  ]
  for (const [base, want] of cases) {
    ok(`${base.replace('https://', '').slice(0, 42)} → correct path`, chatUrl(base) === want, chatUrl(base))
  }
})

// ------------------------------------------------------------- failures
await group('failure messages are actionable', async () => {
  // An invalid key must be rejected rather than silently accepted.
  const bad = await (await fetch(`${BASE}/api/detect-provider`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey: 'definitely-not-a-real-key-xyz' }),
  })).json()
  ok('invalid key is rejected', bad.ok === false)
  ok('rejection explains the next step', /تأكد|أدخل/.test(bad.message ?? ''))

  const noKey = await (await fetch(`${BASE}/api/detect-provider`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey: '' }),
  })).json()
  ok('empty key is rejected early', noKey.ok === false)

  const noUrl = await (await fetch(`${BASE}/api/models`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseURL: '', apiKey: 'x' }),
  })).json()
  ok('missing base URL is rejected', noUrl.ok === false)
})

// --------------------------------------------------------------- report
console.log(`\n${'═'.repeat(60)}`)
console.log(`  ${pass} passed, ${fail} failed`)
if (fail > 0) console.log(`  failing: ${results.join(', ')}`)
console.log(`${'═'.repeat(60)}\n`)
process.exit(fail === 0 ? 0 : 1)
