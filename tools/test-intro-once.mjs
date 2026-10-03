/**
 * The introduction must be added exactly once.
 *
 * The intro cut is stored with the analysis cuts, so a retry already has it.
 * The code that prepends it used to run on every resume, which grew the list
 * by one each time — the learner watched the explanation count climb for no
 * reason (34 → 37 → 44 → 47), and worse, the saved speech clips shifted with
 * it so each explanation was read with the previous one's words. This pins
 * the count across runs.
 */
import { createServer } from 'node:http'
import { copyFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const JOBS = join(ROOT, 'data', 'jobs')
const SEED = 'jmuph8nk71emtnc'

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ` :: ${detail}` : ''}`) }
}

const QUOTE = 'Jadi gini cara kerja otak itu adalah mereka hanya akan mengingat sesuatu yang menurut mereka penting,'

const stub = createServer(async (req, res) => {
  let body = ''
  for await (const chunk of req) body += chunk
  const p = JSON.parse(body)
  const sys = p.messages?.[0]?.content ?? ''
  const content = sys.includes('SHORT spoken introduction')
    ? JSON.stringify({ overview: 'هذا تسجيل عن عمل الدماغ وكيفية الحفظ.' })
    : JSON.stringify({ items: [{
        segments: [QUOTE],
        reason: 'جملة طويلة',
        words: [{ term: 'penting', meaning: 'مهم' }],
        explanation: 'الآن يتحدث المتحدث عن كيف يعمل الدماغ.',
      }] })
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
  }))
})
await new Promise(r => stub.listen(0, '127.0.0.1', r))
const baseURL = `http://127.0.0.1:${stub.address().port}/v1`

const { runPipeline } = await import('../lib/pipeline.mjs')
const { getBrief, saveBrief } = await import('../lib/store.mjs')
const { readStage } = await import('../lib/jobs.mjs')

const jobId = 'j' + Date.now().toString(36) + 'intro001'
const jobDir = join(JOBS, jobId)
const savedBrief = getBrief()

console.log('\n=== المقدمة تُضاف مرة واحدة فقط ===\n')

try {
  mkdirSync(jobDir, { recursive: true })
  copyFileSync(join(JOBS, SEED, 'source.bin'), join(jobDir, 'source.bin'))
  copyFileSync(join(JOBS, SEED, 'transcript.json'), join(jobDir, 'transcript.json'))

  saveBrief({ wants: 'اشرح الجمل الطويلة', avoid: 'لا تترجم', mode: 'fixed', answers: {} })

  const settings = {
    targetLanguage: 'id', nativeLanguage: 'ar',
    replayPassage: true, speechEngine: 'free',
    transcription: { model: 'base', beamSize: 1 },
    analysis: { provider: baseURL, model: 'stub' },
  }
  const secrets = { analysisApiKey: 'stub', speechApiKey: '' }
  const file = join(jobDir, 'source.bin')

  const first = await runPipeline({
    jobId, file, name: 'podcast.mp3', settings, secrets,
    onProgress: () => {},
  })
  check('the first run finishes', first.ok === true, first.message ?? '')

  const after1 = readStage(jobId, 'analysis')
  const intros1 = after1.cuts.filter(c => c.intro).length
  check('the first run adds exactly one intro', intros1 === 1, `${intros1} intros`)
  const count1 = after1.cuts.length
  check('the first run records a speech clip per cut',
    Object.keys(readStage(jobId, 'speech')?.speech ?? {}).length === count1)

  // A retry reuses the analysis. Before the fix this prepended a second intro
  // and shifted every saved clip by one.
  const second = await runPipeline({
    jobId, file, name: 'podcast.mp3', settings, secrets,
    onProgress: () => {},
  })
  check('the retry finishes', second.ok === true, second.message ?? '')

  const after2 = readStage(jobId, 'analysis')
  const intros2 = after2.cuts.filter(c => c.intro).length
  check('the retry does not add another intro', intros2 === 1, `${intros2} intros`)
  check('the cut count does not grow on a retry', after2.cuts.length === count1,
    `${count1} -> ${after2.cuts.length}`)

  // The clips must still line up with the same cuts, or the finished audio
  // would read each explanation with the wrong words.
  const speech2 = readStage(jobId, 'speech')?.speech ?? {}
  check('the speech clips still cover every cut',
    Object.keys(speech2).length === after2.cuts.length,
    `${Object.keys(speech2).length} vs ${after2.cuts.length}`)

  // A third run keeps the count flat too — the bug accumulated per retry.
  const third = await runPipeline({
    jobId, file, name: 'podcast.mp3', settings, secrets,
    onProgress: () => {},
  })
  const after3 = readStage(jobId, 'analysis')
  check('a third run still adds no intro', after3.cuts.filter(c => c.intro).length === 1)
  check('a third run keeps the count flat', after3.cuts.length === count1,
    `${count1} -> ${after3.cuts.length}`)
} finally {
  saveBrief(savedBrief)
  stub.close()
  rmSync(jobDir, { recursive: true, force: true })
}

console.log(`\n=== ${pass} passed, ${fail} failed ===\n`)
process.exit(fail === 0 ? 0 : 1)
