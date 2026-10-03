/**
 * The mismatch that actually broke the app:
 * a Google API key pasted into the OpenRouter provider field.
 *
 * The old behaviour was a bare "Model is unavailable", which gave no clue.
 * This proves the new check names the real problem.
 */
import { checkKeyMatch, detectKeyOwner, detectUrlOwner, chatUrl } from '../lib/provider.mjs'

let pass = 0, fail = 0
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' :: ' + detail : ''}`) }
}

console.log('\n=== API key / provider mismatch ===\n')

// --- the exact case from the user -------------------------------------------
const googleKey = 'AQ.Ab8RN6xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
const openrouterUrl = 'https://openrouter.ai/api/v1'

console.log(`key  = ${googleKey.slice(0, 12)}...  (a Google key)`)
console.log(`url  = ${openrouterUrl}  (OpenRouter)\n`)

const m = checkKeyMatch(openrouterUrl, googleKey)
check('mismatch is detected', m !== null)
check('key owner named as google', m?.keyOwner === 'google', String(m?.keyOwner))
check('url owner named as openrouter', m?.urlOwner === 'openrouter', String(m?.urlOwner))
check('message names both services', /google/.test(m?.message ?? '') && /openrouter/.test(m?.message ?? ''))
check('message offers a next step', /اكتشف تلقائياً/.test(m?.message ?? ''))

if (m) console.log(`\n  message shown to the user:\n    ${m.message}\n`)

// --- matching pairs must NOT warn -------------------------------------------
check('openrouter key + openrouter url is clean',
  checkKeyMatch('https://openrouter.ai/api/v1', 'sk-or-v1-abc') === null)
check('google key + google url is clean',
  checkKeyMatch('https://generativelanguage.googleapis.com/v1beta/openai',
    'AQ.Ab8RN6x') === null)
check('openai key + openai url is clean',
  checkKeyMatch('https://api.openai.com/v1', 'sk-proj-abc') === null)

// --- unknown keys stay silent rather than guessing ---------------------------
check('unknown key shape does not warn',
  checkKeyMatch('https://openrouter.ai/api/v1', 'some-custom-token') === null)
check('empty key does not warn', checkKeyMatch(openrouterUrl, '') === null)

// A bare `sk-` prefix belongs to many unrelated services, so it must not
// produce a warning that could send someone to the wrong provider.
check('ambiguous sk- key is not treated as OpenAI',
  checkKeyMatch('https://openrouter.ai/api/v1', 'sk-tinyfish-abc') === null)
check('sk-proj- key does warn when the url is elsewhere',
  checkKeyMatch('https://openrouter.ai/api/v1', 'sk-proj-abc') !== null)

// --- key shapes --------------------------------------------------------------
console.log('')
for (const [key, expected] of [
  ['sk-or-v1-abc', 'openrouter'],
  ['sk-ant-abc', 'anthropic'],
  ['sk-proj-abc', 'openai'],
  ['AIzaSyABC', 'google'],
  ['AQ.Ab8RN6x', 'google'],
  ['gsk_abc', 'groq'],
  ['xai-abc', 'xai'],
]) {
  check(`detects ${expected} from key shape`, detectKeyOwner(key) === expected, String(detectKeyOwner(key)))
}

// --- local servers must not be mistaken for a known owner --------------------
check('localhost has no URL owner', detectUrlOwner('http://localhost:1234/v1') === null)
check('localhost with any key does not warn',
  checkKeyMatch('http://localhost:1234/v1', 'AQ.Ab8RN6x') === null)

// --- URL construction (the earlier /v1/v1 bug) -------------------------------
console.log('')
for (const [base, expected] of [
  ['https://openrouter.ai/api/v1', 'https://openrouter.ai/api/v1/chat/completions'],
  ['https://openrouter.ai/api/v1/', 'https://openrouter.ai/api/v1/chat/completions'],
  ['https://api.openai.com/v1', 'https://api.openai.com/v1/chat/completions'],
  ['http://localhost:1234', 'http://localhost:1234/v1/chat/completions'],
  ['http://localhost:1234/v1', 'http://localhost:1234/v1/chat/completions'],
  ['https://generativelanguage.googleapis.com/v1beta/openai',
    'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'],
  ['https://generativelanguage.googleapis.com/v1beta',
    'https://generativelanguage.googleapis.com/v1beta/chat/completions'],
]) {
  const got = chatUrl(base)
  check(`${base} → correct path`, got === expected, got)
}

console.log(`\n=== ${pass} passed, ${fail} failed ===\n`)
process.exit(fail === 0 ? 0 : 1)
