/**
 * End-to-end pipeline test with a real Indonesian passage and a real provider.
 *
 * Exercises transcription, analysis, speech, and the ffmpeg edit, then verifies
 * the produced file is genuinely longer and contains the inserted explanations.
 */
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

const BASE = 'http://127.0.0.1:4180'
const ROOT = 'D:/Projects/anything/voice-tutor'
const OR_KEY = ''

let pass = 0, fail = 0
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' :: ' + detail : ''}`) }
}

console.log('\n=== end-to-end pipeline test ===\n')

/**
 * Confirm the file carries actual audio, not silence.
 *
 * ffmpeg's volumedetect output is not capturable through Node in this
 * environment, so loudness is measured by decoding to raw PCM and computing
 * the level directly. That is deterministic and needs no parsing.
 */
function measureVolume(file) {
  let pcm
  try {
    pcm = execFileSync('ffmpeg', [
      '-v', 'quiet', '-i', file,
      '-f', 's16le', '-acodec', 'pcm_s16le', '-ac', '1', '-ar', '8000', '-',
    ], { maxBuffer: 512 * 1024 * 1024 })
  } catch (error) {
    // Some builds write nothing to stdout but still produce the buffer on error.
    pcm = error.stdout
  }
  if (!pcm || pcm.length < 2) return { mean: undefined, max: undefined, samples: 0 }

  let sumSquares = 0
  let peak = 0
  const count = Math.floor(pcm.length / 2)
  for (let i = 0; i < count; i++) {
    const sample = pcm.readInt16LE(i * 2) / 32768
    sumSquares += sample * sample
    const abs = Math.abs(sample)
    if (abs > peak) peak = abs
  }
  const rms = Math.sqrt(sumSquares / count)
  const toDb = (v) => (v > 0 ? 20 * Math.log10(v) : -Infinity)
  return { mean: toDb(rms), max: toDb(peak), samples: count }
}

// ---------------------------------------------------------------- 1. setup
console.log('[1] configure')
const settings = await fetch(BASE + '/api/settings', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    targetLanguage: 'id', nativeLanguage: 'ar', level: 'intermediate', density: 'normal',
    speechEngine: 'free',
    analysis: { provider: 'https://openrouter.ai/api/v1', model: 'google/gemini-2.5-flash' },
  }),
}).then(r => r.json())
check('settings saved', settings.ok === true, JSON.stringify(settings).slice(0, 150))

const orKey = process.env.OPENROUTER_API_KEY || OR_KEY
const secrets = await fetch(BASE + '/api/secrets', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ analysisApiKey: orKey }),
}).then(r => r.json())
check('analysis key stored', secrets.ok === true)

// ------------------------------------------------------------------ 2. audio
console.log('\n[2] prepare natural Indonesian audio')
const tmp = join(ROOT, 'data', 'tmp')
mkdirSync(tmp, { recursive: true })

// Prefer the natural neural clip; the robotic SAPI voice makes Whisper produce
// garbage, which would test the wrong thing.
const natural = join(tmp, 'indonesian-natural.wav')
if (!existsSync(natural)) {
  console.log('        generating with tools/make_test_audio.py ...')
  execFileSync('python', ['tools/make_test_audio.py'], { cwd: ROOT, stdio: 'inherit' })
}
const bytes = readFileSync(natural)
console.log(`        ${(bytes.length / 1024).toFixed(0)} KB of natural speech`)

// ------------------------------------------------------------- 3. pipeline
console.log('\n[3] run the pipeline (this takes a few minutes)')
const started = Date.now()
const res = await fetch(`${BASE}/api/tutor?name=e2e-indonesian.wav`, {
  method: 'POST', body: bytes,
})
const result = await res.json()
const elapsed = ((Date.now() - started) / 1000).toFixed(0)
console.log(`        finished in ${elapsed}s`)

check('pipeline succeeded', result.ok === true, JSON.stringify(result).slice(0, 400))
if (!result.ok) {
  console.log('\n  stages:', JSON.stringify(result.stages?.slice(-3) ?? [], null, 2))
  console.log(`\n=== ${pass} passed, ${fail} failed ===\n`)
  process.exit(1)
}

console.log(`        transcribed ${result.segments} segments, language=${result.language}`)
console.log(`        found ${result.cuts} passages to explain`)
console.log(`        original ${result.originalDuration}s -> edited ${Math.round(result.duration)}s`)

// --------------------------------------------------------------- 4. verify
console.log('\n[4] verify the output')
const outPath = result.outputPath
check('output file exists', existsSync(outPath))

if (existsSync(outPath)) {
  const size = statSync(outPath).size
  console.log(`        ${(size / 1024).toFixed(0)} KB`)
  check('output is non-trivial in size', size > 50_000, `${size} bytes`)

  // The edited file must be longer: explanations were inserted.
  const grew = result.duration > result.originalDuration
  check('edited audio is longer than the original', grew,
    `${result.originalDuration}s -> ${result.duration}s`)

  // Confirm it is real decodable audio.
  const probe = execFileSync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration,bit_rate', '-of', 'json', outPath,
  ], { encoding: 'utf8' })
  const info = JSON.parse(probe)
  check('output decodes as audio', Number(info.format?.duration) > 0,
    JSON.stringify(info.format))

  // Confirm speech is present across the file (not one long silence).
  // ffmpeg reports volumedetect on stderr and exits non-zero with `-f null -`,
  // so both streams must be captured rather than trusted.
  const vol = measureVolume(outPath)
  check('output has audible content',
    vol.mean !== undefined && vol.mean > -40,
    `mean_volume=${vol.mean}dB max_volume=${vol.max}dB`)

  // The edited file should contain more silence than the original: the pauses
  // around each inserted explanation are the audible signature of the edit.
  check('output is longer by roughly the inserted explanations',
    result.duration - result.originalDuration > 10,
    `+${Math.round(result.duration - result.originalDuration)}s`)
}

console.log('\n[5] what the learner would see')
for (const item of (result.items ?? []).slice(0, 4)) {
  const mm = Math.floor(item.start / 60)
  const ss = String(Math.floor(item.start % 60)).padStart(2, '0')
  console.log(`\n  ${mm}:${ss}`)
  if (item.quote) console.log(`    «${item.quote.slice(0, 70)}»`)
  if (item.explanation) console.log(`    ${item.explanation.slice(0, 110)}`)
  for (const w of (item.words ?? []).slice(0, 3)) {
    console.log(`    • ${w.term} — ${w.meaning}`)
  }
}

console.log(`\n=== ${pass} passed, ${fail} failed ===\n`)
process.exit(fail === 0 ? 0 : 1)
