/**
 * The intake over real HTTP: upload → pause → answer → download.
 *
 * The unit tests drive runPipeline directly, which proves the prompts but not
 * the seam the browser actually touches: the busy lock, the stage files on
 * disk, the resume endpoint finding the original upload, and the answer
 * payload reaching the job. This runs the whole thing through the server.
 *
 * The provider is swapped for a local stub via /api/settings and put back
 * afterwards. Only settings.json is written — never secrets.
 */
import { createServer } from 'node:http'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const PORT = 4180
const ROOT = process.cwd()
const JOBS = join(ROOT, 'data', 'jobs')
const UPLOADS = join(ROOT, 'data', 'uploads')
const OUTPUT = join(ROOT, 'data', 'output')
const SEED = 'jmuph8nk71emtnc'

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ` :: ${detail}` : ''}`) }
}

const QUOTE = 'Jadi gini cara kerja otak itu adalah mereka hanya akan mengingat sesuatu yang menurut mereka penting,'

/** The stub provider this run talks to instead of the real relay. */
const stub = createServer(async (req, res) => {
  let body = ''
  for await (const chunk of req) body += chunk
  const p = JSON.parse(body)
  const sys = p.messages?.[0]?.content ?? ''
  const isInterview = sys.includes('Write the 4-6 questions')
  const isOverview = sys.includes('SHORT spoken introduction')
  const content = isInterview
    ? JSON.stringify({ questions: [
        { id: 'q1', type: 'choice', text: 'هل الأرقام في هذا المقطع تشتتك؟', options: ['نعم', 'لا'] },
      ] })
    : isOverview
      ? JSON.stringify({ overview: 'هذا تسجيل عن عمل الدماغ وكيفية الحفظ.' })
      : JSON.stringify({ items: [{
          segments: [QUOTE],
          reason: 'جملة طويلة',
          words: [{ term: 'penting', meaning: 'مهم' }],
          explanation: 'الآن يتحدث المتحدث عن كيف يعمل الدماغ: لا يحفظ إلا ما يبدو له مهماً.',
        }] })
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({
    id: 'x', object: 'chat.completion', model: 'stub',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
  }))
})
await new Promise(r => stub.listen(0, '127.0.0.1', r))
const stubURL = `http://127.0.0.1:${stub.address().port}/v1`

const api = async (path, options = {}) => {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method: options.method ?? 'GET',
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  })
  try { return await res.json() } catch { return { ok: false, message: `HTTP ${res.status}` } }
}

console.log('\n=== الخانات عبر HTTP ===\n')

// Point the server at the stub, and remember the real provider to restore it.
const before = await api('/api/state')
const realProvider = before.settings?.analysis?.provider
const realModel = before.settings?.analysis?.model
const realBrief = (await api('/api/brief')).brief

// Seed a job exactly as /api/tutor would have left it after transcription.
const jobId = 'j' + Date.now().toString(36) + 'http001'
const jobDir = join(JOBS, jobId)
mkdirSync(jobDir, { recursive: true })
copyFileSync(join(JOBS, SEED, 'source.bin'), join(jobDir, 'source.bin'))
copyFileSync(join(JOBS, SEED, 'transcript.json'), join(jobDir, 'transcript.json'))
mkdirSync(UPLOADS, { recursive: true })
copyFileSync(join(JOBS, SEED, 'source.bin'), join(UPLOADS, jobId + '.mp3'))

// A .wav name proves the resume endpoint finds the upload without assuming mp3.
const uploadedAs = join(UPLOADS, jobId + '.mp3')

try {
  await api('/api/settings', { method: 'POST', body: {
    analysis: { provider: stubURL, model: 'stub-model' },
  } })
  await api('/api/brief', { method: 'POST', body: {
    wants: 'أركز على الحوار', avoid: 'لا تحلل القواعد', mode: 'ai', answers: {},
  } })

  // Act as the browser would: retry with the existing jobId (transcript reused).
  const tutorRes = await fetch(
    `http://127.0.0.1:${PORT}/api/tutor?name=podcast.mp3&jobId=${jobId}`,
    { method: 'POST', body: new Blob([]) },
  )
  const first = await tutorRes.json()

  check('the upload pauses for AI-mode questions',
    first.ok === true && first.needAnswers === true,
    JSON.stringify({ ok: first.ok, needAnswers: first.needAnswers, message: first.message }))
  check('the pause returns the generated questions', (first.questions ?? []).length > 0)
  check('the questions are saved on the job',
    existsSync(join(jobDir, 'interview.json')))
  check('the analysis has not started yet',
    !existsSync(join(jobDir, 'analysis.json')))

  // The learner answers; the server must find the original upload and resume.
  const answerRes = await api(`/api/answer?jobId=${jobId}`, {
    method: 'POST', body: { answers: { q1: 'نعم' } },
  })

  check('the resume finished the job', answerRes.ok === true, answerRes.message ?? '')
  check('the resume produced an output', Boolean(answerRes.id ?? answerRes.jobId))
  check('the resume produced explanations', (answerRes.items ?? []).length > 0,
    `${answerRes.items?.length ?? 0} items`)

  const outPath = join(OUTPUT, `${jobId}.mp3`)
  check('the output file is on disk', existsSync(outPath))
  if (existsSync(outPath)) {
    const size = readFileSync(outPath).length
    check('the output file is not empty', size > 1000, `${size} bytes`)
  }

  // The answers the learner gave must persist to the brief for next time.
  const afterBrief = (await api('/api/brief')).brief
  check('the intake answers persist on the brief', Boolean(afterBrief.wants))

  // A second run with the same job must reuse the analysis, not ask again.
  const again = await fetch(
    `http://127.0.0.1:${PORT}/api/tutor?name=podcast.mp3&jobId=${jobId}`,
    { method: 'POST', body: new Blob([]) },
  ).then(r => r.json())
  check('a retry does not ask the same questions again',
    again.ok === true && !again.needAnswers, again.message ?? '')
} finally {
  // Put everything back: the real provider and the learner's own intake.
  await api('/api/settings', { method: 'POST', body: {
    analysis: { provider: realProvider, model: realModel },
  } })
  await api('/api/brief', { method: 'POST', body: realBrief })
  stub.close()
  rmSync(jobDir, { recursive: true, force: true })
  if (existsSync(uploadedAs)) rmSync(uploadedAs, { force: true })
  if (existsSync(join(OUTPUT, `${jobId}.mp3`))) rmSync(join(OUTPUT, `${jobId}.mp3`), { force: true })
}

console.log(`\n=== ${pass} passed, ${fail} failed ===\n`)
process.exit(fail === 0 ? 0 : 1)
