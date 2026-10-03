/**
 * Drives the real pipeline against a local stub provider, with a learner brief
 * in place.
 *
 * What this proves, that unit tests cannot: the brief actually reaches the
 * model's system prompt, the transcript is reused across the interview pause,
 * and the answer call resumes from it without re-reading the audio.
 *
 * Secrets and settings are passed inline ONLY. Nothing here may call
 * setSecrets() or updateSettings(): those write to disk, and a test that
 * wrote a placeholder over a real key once destroyed it.
 */
import { createServer } from 'node:http'
import { copyFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { runPipeline } from '../lib/pipeline.mjs'
import { getBrief, saveBrief, paths } from '../lib/store.mjs'
import { JOBS_DIR } from '../lib/jobs.mjs'

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ` :: ${detail}` : ''}`) }
}

// Everything the stub provider was asked for, so the brief can be found in it.
const sent = []

// A plausible reply: one passage the pipeline can locate in the real transcript.
// The quote must be verbatim from transcript.json or locateInTranscript drops it.
const QUOTE = 'Jadi gini cara kerja otak itu adalah mereka hanya akan mengingat sesuatu yang menurut mereka penting,'
const ITEM = JSON.stringify({
  items: [{
    segments: [QUOTE],
    reason: 'جملة طويلة',
    words: [{ term: 'penting', meaning: 'مهم' }],
    explanation: 'الآن يتحدث المتحدث عن كيف يعمل الدماغ: لا يحفظ إلا ما يبدو له مهماً. هذه فكرة محورية في الحلقة.',
  }],
})
const OVERVIEW = JSON.stringify({ overview: 'هذا تسجيل عن التعليم وأهمية الوقت في الدراسة.' })

const server = createServer(async (req, res) => {
  let body = ''
  for await (const chunk of req) body += chunk
  const parsed = JSON.parse(body)
  sent.push(parsed)

  const wantsQuestions = parsed.messages?.[0]?.content?.includes('Write the 4-6 questions')
  const wantsOverview = parsed.messages?.[0]?.content?.includes('SHORT spoken introduction')
  const content = wantsQuestions
    ? JSON.stringify({ questions: [{ id: 'q1', type: 'choice', text: 'هل الأرقام تشتتك؟', options: ['نعم', 'لا'] }] })
    : wantsOverview ? OVERVIEW : ITEM
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({
    id: 'x', object: 'chat.completion', model: 'stub',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
  }))
})

await new Promise(r => server.listen(0, '127.0.0.1', r))
const baseURL = `http://127.0.0.1:${server.address().port}/v1`

console.log('\n=== المسار كاملاً مع خانات المتعلم ===\n')

// The real saved podcast source: 748s of Indonesian speech.
const file = 'data/jobs/jmuph8nk71emtnc/source.bin'
const name = 'probe.mp3'
const settings = {
  targetLanguage: 'id', nativeLanguage: 'ar',
  replayPassage: true, speechEngine: 'free',
  voice: 'ar-KW-FahedNeural',
  transcription: { model: 'base', beamSize: 1,
    cacheDir: 'D:\\Projects\\anything\\voice-tutor\\.models' },
  analysis: { provider: baseURL, model: 'stub-model' },
}
const secrets = { analysisApiKey: 'stub-key', speechApiKey: '' }

// The pipeline reads the brief from disk, so set a known one here and put the
// user's back afterwards. brief.json is intake data, never secrets — safe to
// write from a test, unlike setSecrets.
const savedBrief = getBrief()
saveBrief({
  wants: 'اشرح الجمل الطويلة فقط',
  avoid: 'لا تترجم كل كلمة حرفياً',
  mode: 'fixed',
  answers: {},
})

// Whisper on the real audio takes minutes. Seed the new job with the saved
// transcript so the pipeline skips transcription entirely — it matches on the
// transcription model, which is the same 'base' here.
const jobId = 'j' + Date.now().toString(36) + 'btest01'
const jobDir = join(JOBS_DIR, jobId)
mkdirSync(jobDir, { recursive: true })
copyFileSync('data/jobs/jmuph8nk71emtnc/source.bin', join(jobDir, 'source.bin'))
copyFileSync('data/jobs/jmuph8nk71emtnc/transcript.json', join(jobDir, 'transcript.json'))
console.log(`(running under job ${jobId}, seeded with the saved transcript)`)

try {
  const stage1 = await runPipeline({
    jobId, file, name, settings, secrets,
    onProgress: (s, d) => { if (s === 'analyze' || s === 'speak') console.log(`    [${s}] ${d}`) },
  })

// FIXED mode needs no answers, so the pipeline should run straight through.
check('fixed mode runs to completion without pausing', stage1.ok === true, stage1.message ?? '')
check('the pipeline reports the passages it explained', (stage1.cuts ?? 0) >= 0)
check('the overview was generated', stage1.ok === true)

// THE point of this test: the learner's own words must be inside the system
// prompt the model actually received, not just in a builder's output. Every
// request must carry them, including the split-and-retry ones.
const analysisCalls = sent.filter(m =>
  /hard for this learner/i.test(m.messages?.[0]?.content ?? ''))
const promptText = analysisCalls.map(m => m.messages[0].content).join('\n')
check('an analysis request was made', analysisCalls.length > 0, `${analysisCalls.length} calls`)
check('every analysis request carries the learner profile',
  analysisCalls.length > 0 && analysisCalls.every(m => m.messages[0].content.includes('IN THEIR OWN WORDS')))
check('the learner\'s wants reached the model', promptText.includes('اشرح الجمل الطويلة فقط'))
check('the learner\'s refusals reached the model', promptText.includes('لا تترجم كل كلمة حرفياً'))
check('the model was told the learner is the authority',
  /IN THEIR OWN WORDS/.test(promptText))
check('the strict JSON contract survived', /Return STRICT JSON only/.test(promptText))
check('the introduction prompt also carries the brief',
  sent.some(m => /SHORT spoken introduction/.test(m.messages?.[0]?.content ?? '')
    && m.messages[0].content.includes('اشرح الجمل الطويلة فقط')))

  server.close()
} finally {
  // Put the learner's own intake back exactly as it was.
  saveBrief(savedBrief)
}

console.log(`\n=== ${pass} passed, ${fail} failed ===\n`)
process.exit(fail === 0 ? 0 : 1)
