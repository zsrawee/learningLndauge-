/**
 * The introduction must actually reach the pipeline's chat() call.
 *
 * It silently did not. The call passed `{ settings, secrets, system, user }`,
 * but chat() takes `{ baseURL, apiKey, model, messages }`. Every argument was
 * ignored, chat returned "No provider base URL configured", and the failure was
 * swallowed by the deliberate "an introduction is a bonus" guard — so the run
 * looked healthy while shipping a feature that never ran.
 *
 * This drives the real chat() against a local endpoint and checks both the
 * argument shape and the parse.
 */
import { createServer } from 'node:http'

import { buildOverviewPrompt, parseOverview } from '../lib/analyze.mjs'
import { chat } from '../lib/provider.mjs'

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ` :: ${detail}` : ''}`) }
}

// A stand-in provider that records what it was actually sent.
let seen = null
let refuse = false
const ARABIC = 'هذا تسجيل حوار عن التعليم. يتحدث شخص عن الوقت الذي يستهلكه، '
  + 'ويذكر أنه ضحّى بوقته. الكلمة المتكررة هي perhatian أي الانتباه.'
const server = createServer(async (req, res) => {
  let body = ''
  for await (const chunk of req) body += chunk
  seen = { url: req.url, auth: req.headers.authorization ?? '', body }

  // A provider that refuses the request. A 400 is the fast failure path — a
  // dead connection backs off for minutes (deliberately, for the flaky relay),
  // which has no place in a test.
  if (refuse) {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'bad model' } }))
    return
  }

  const wantsOverview = body.includes('overview') && !body.includes('items')
  const content = wantsOverview ? JSON.stringify({ overview: ARABIC }) : '{"items":[]}'
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({
    id: 'x', object: 'chat.completion', model: 'x',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
  }))
})

await new Promise(r => server.listen(0, '127.0.0.1', r))
const baseURL = `http://127.0.0.1:${server.address().port}/v1`

console.log('\n=== المقدمة تصل إلى نداء المحادثة ===\n')

// This is the exact shape pipeline.mjs must use.
const result = await chat({
  baseURL,
  apiKey: 'stub-key',
  model: 'stub-model',
  messages: [
    { role: 'system', content: buildOverviewPrompt({ targetLanguage: 'id', nativeLanguage: 'ar', level: 'intermediate' }) },
    { role: 'user', content: '[1] 0:00 salah satu hal yang penting' },
  ],
  maxTokens: 1200,
})

check('chat reaches the provider', result.ok, result.message ?? '')
check('the request went to the completions endpoint',
  Boolean(seen?.url?.includes('/chat/completions')), seen?.url ?? '')
check('the api key was sent', /^Bearer .+/.test(seen?.auth ?? ''), seen?.auth ?? '')

const sent = JSON.parse(seen?.body ?? '{}')
check('the model reached the provider', sent.model === 'stub-model', String(sent.model))
check('the system prompt is the overview prompt',
  /overview/.test(sent.messages?.[0]?.content ?? '') && /introduction/i.test(sent.messages?.[0]?.content ?? ''))
check('the transcript was sent as the user turn',
  sent.messages?.[1]?.role === 'user' && (sent.messages?.[1]?.content ?? '').includes('penting'))

const overview = result.ok ? parseOverview(result.text) : ''
check('the introduction was parsed out of the reply',
  typeof overview === 'string' && overview.length > 100, `${overview?.length ?? 0} chars`)
check('the introduction is real Arabic prose',
  /[\u0600-\u06FF]/.test(overview ?? '') && overview.includes('perhatian'))

// The guard the pipeline relies on: a bonus must never fail the job.
refuse = true
const down = await chat({
  baseURL, apiKey: 'k', model: 'm',
  messages: [{ role: 'user', content: 'x' }], maxTokens: 10,
})
check('a refusing provider returns a failure rather than throwing',
  down.ok === false && typeof down.message === 'string')
refuse = false
check('an empty overview is treated as absent', parseOverview('') === '')
check('a reply with no overview is treated as absent', parseOverview('{"items":[]}') === '')

// The learner's own words must reach the introduction, not just a level label.
const withBrief = buildOverviewPrompt({
  targetLanguage: 'id', nativeLanguage: 'ar', level: 'intermediate',
  brief: { wants: 'اشرح الجمل الطويلة', avoid: 'لا تترجم كل كلمة', answers: {} },
})
check('the overview prompt quotes what the learner asked for', withBrief.includes('اشرح الجمل الطويلة'))
check('the overview prompt quotes what the learner refused', withBrief.includes('لا تترجم كل كلمة'))

// A brief that is still empty must fall back rather than produce a thin prompt.
const noBrief = buildOverviewPrompt({ targetLanguage: 'id', nativeLanguage: 'ar', level: 'beginner' })
check('an unanswered brief falls back to the level guide', /beginner/i.test(noBrief))

server.close()
console.log(`\n=== ${pass} passed, ${fail} failed ===\n`)
process.exit(fail === 0 ? 0 : 1)
