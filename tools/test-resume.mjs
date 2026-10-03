/**
 * Proves that a failed analysis does not throw away the transcription.
 *
 * The scenario: the AI provider is misconfigured, so the job fails after the
 * expensive local transcription. Fixing the settings and retrying must NOT
 * re-read the audio.
 *
 * The "fixed" provider is a local stub, so this tests the resume logic rather
 * than whether the configured account can afford a request.
 */
import { readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const BASE = 'http://127.0.0.1:4180'
const AUDIO = 'D:/Projects/anything/voice-tutor/data/tmp/indonesian-natural.wav'
const JOBS = 'D:/Projects/anything/voice-tutor/data/jobs'

const STUB_PORT = 4199
const STUB_URL = `http://127.0.0.1:${STUB_PORT}/v1`

// The user's real configuration, restored after the run so testing never
// repoints the app at the stub.
const REAL_URL = 'https://openrouter.ai/api/v1'
const REAL_MODEL = 'nvidia/nemotron-3-ultra-550b-a55b:free'
const REAL_KEY = readFileSync('data/secrets.json', 'utf8').includes('analysisApiKey')
  ? JSON.parse(readFileSync('data/secrets.json', 'utf8')).analysisApiKey
  : ''

const GOOD_KEY = REAL_KEY
const GOOD_URL = REAL_URL
const GOOD_MODEL = 'model-that-does-not-exist-zzz'

let stub = null

/** Start the local stub provider unless one is already answering. */
async function ensureStub() {
  try {
    const r = await fetch(`http://127.0.0.1:${STUB_PORT}/v1/models`)
    if (r.status < 500) return
  } catch { /* not running */ }
  stub = spawn(process.execPath, ['tools/stub-provider.mjs'], {
    cwd: 'D:/Projects/anything/voice-tutor', stdio: 'ignore',
  })
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 500))
    try {
      await fetch(`http://127.0.0.1:${STUB_PORT}/v1/models`)
      return
    } catch { /* keep waiting */ }
  }
}

let pass = 0, fail = 0
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' :: ' + detail : ''}`) }
}

const setSettings = (body) => fetch(`${BASE}/api/settings`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
})
const setKey = (key) => fetch(`${BASE}/api/secrets`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ analysisApiKey: key }),
})

/** Run a job, returning the parsed result and how long it took. */
async function run({ file, name, jobId }) {
  const q = new URLSearchParams({ name })
  if (jobId) q.set('jobId', jobId)
  const t0 = Date.now()
  const res = await fetch(`${BASE}/api/tutor?${q}`, { method: 'POST', body: file ?? Buffer.alloc(0) })
  const json = await res.json()
  return { ...json, seconds: (Date.now() - t0) / 1000 }
}

console.log('\n=== resume after a provider failure ===\n')

const audio = readFileSync(AUDIO)

// ---------------------------------------------------------------- 1. break it
console.log('step 1: run with a broken provider (must fail at analysis)\n')
await setKey(GOOD_KEY)
await setSettings({ analysis: { provider: GOOD_URL, model: 'a-model-that-does-not-exist-xyz' } })

const first = await run({ file: audio, name: 'resume-test.wav' })
console.log(`  ok=${first.ok} stage=${first.stage} in ${first.seconds.toFixed(1)}s`)
if (!first.ok) console.log(`  message: ${String(first.message).slice(0, 90)}\n`)

check('job failed', first.ok === false)
check('failure is at the analysis stage', first.stage === 'analyze', String(first.stage))
check('a job id came back', typeof first.jobId === 'string' && first.jobId.length > 0)
check('retry is offered', first.canRetry === true)
check('the transcript survived', first.saved?.transcript === true)
check('no output was produced', first.saved?.output === false)

const jobId = first.jobId
const transcriptFile = join(JOBS, jobId, 'transcript.json')
check('transcript file exists on disk', existsSync(transcriptFile))
check('source audio was kept', existsSync(join(JOBS, jobId, 'source.bin')))

// The transcript must contain real content, not an empty placeholder.
let transcript = null
try { transcript = JSON.parse(readFileSync(transcriptFile, 'utf8')) } catch { /* missing */ }
check('transcript holds real segments', (transcript?.segments?.length ?? 0) > 0,
  `${transcript?.segments?.length ?? 0} segments`)
check('transcript records its model', typeof transcript?.model === 'string', String(transcript?.model))

// ---------------------------------------------------------------- 2. fix it
console.log('\nstep 2: fix the model, then retry WITHOUT re-uploading audio\n')
await ensureStub()
await setSettings({ analysis: { provider: STUB_URL, model: 'stub' } })

const second = await run({ jobId, name: 'resume-test.wav' })
console.log(`  ok=${second.ok} in ${second.seconds.toFixed(1)}s`)
if (!second.ok) console.log(`  message: ${String(second.message).slice(0, 140)}\n`)

check('retry succeeded', second.ok === true, String(second.message ?? '').slice(0, 120))
check('retry reused the same job id', second.jobId === jobId)

// ------------------------------------------------- 3. was transcription skipped?
console.log('\nstep 3: confirm transcription was not repeated\n')

// Wall-clock is dominated by the speech stage, not transcription, so timing is
// a poor signal. Read the pipeline's own log of what it actually did instead.
function stepsOf(result) {
  return (result.stages ?? []).map(s => `${s.stage}:${s.detail ?? ''}`)
}

function reusedTranscript(result) {
  return stepsOf(result).some(s => s.startsWith('transcribe:') && s.includes('إعادة استخدام'))
}
function reusedAnalysis(result) {
  return stepsOf(result).some(s => s.startsWith('analyze:') && s.includes('إعادة استخدام'))
}
function didTranscribe(result) {
  return stepsOf(result).some(s => s.startsWith('transcribe:') && s.includes('Reading the audio'))
}

console.log('  retry steps:')
for (const s of stepsOf(second).slice(0, 6)) console.log(`    ${s}`)

check('retry did NOT re-read the audio', didTranscribe(second) === false)
check('retry reported reusing the transcript', reusedTranscript(second) === true)

// A fresh run of the same audio must actually transcribe, proving the check
// above is meaningful.
const fresh = await run({ file: audio, name: 'fresh-baseline.wav' })
check('fresh run did transcribe', didTranscribe(fresh) === true)
check('fresh run did not claim to reuse', reusedTranscript(fresh) === false)
check('fresh run succeeded', fresh.ok === true, String(fresh.message ?? '').slice(0, 120))

// ------------------------------------------------- 4. reuse is actually the reason
console.log('\nstep 4: with the transcript deleted, it must transcribe again\n')

rmSync(transcriptFile, { force: true })
await setSettings({ analysis: { model: 'a-model-that-does-not-exist-xyz' } })
const withoutTranscript = await run({ jobId, name: 'resume-test.wav' })
console.log(`  steps after deleting the transcript:`)
for (const s of stepsOf(withoutTranscript).slice(0, 5)) console.log(`    ${s}`)

check('without a transcript it transcribes again', didTranscribe(withoutTranscript) === true)

// ---------------------------------------------------------------- 5. cleanup
// Put the user's real provider back, so running the tests never leaves the app
// pointing at the stub.
await setKey(REAL_KEY)
await setSettings({ analysis: { provider: REAL_URL, model: REAL_MODEL } })
stub?.kill()
for (const id of [jobId, fresh.jobId].filter(Boolean)) {
  rmSync(join(JOBS, id), { recursive: true, force: true })
}

console.log(`\n=== ${pass} passed, ${fail} failed ===\n`)
process.exit(fail === 0 ? 0 : 1)
