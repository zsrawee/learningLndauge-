/**
 * The introduction must be spoken before the recording, not spliced into it.
 *
 * Renders a tiny synthetic source with one real cut plus an intro, then checks
 * that the result starts with the intro and still contains the source audio.
 */
import { mkdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { buildEditedAudio } from '../lib/edit.mjs'
import { speakMixed } from '../lib/speech.mjs'
import { ROOT } from '../lib/store.mjs'

const dir = join(ROOT, 'data', 'tmp', 'intro-edit')
rmSync(dir, { recursive: true, force: true })
mkdirSync(dir, { recursive: true })

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ` :: ${detail}` : ''}`) }
}

const source = join(dir, 'source.wav')
// Build a 20s tone as the "recording".
const { spawn, execFileSync } = await import('node:child_process')
const made = await new Promise((resolve) => {
  const c = spawn('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=20',
    '-ar', '24000', '-ac', '1', source], { stdio: 'ignore' })
  c.on('close', (code) => resolve(code === 0))
})
console.log('  المصدر: ' + (made ? 'أُنشئ (٢٠ث)' : 'فشل'))
if (!made) process.exit(1)

// A distinctive intro so it can be told apart from the tone.
const introFile = join(dir, 'intro.mp3')
const intro = await speakMixed({
  text: 'هذا تسجيل قصير عن اختبار المقدمة، وسنسمع بعده نغمة.',
  nativeLanguage: 'ar', targetLanguage: 'id', output: introFile,
})
console.log('  المقدمة: ' + (intro.ok ? 'سُجّلت' : 'فشلت'))
if (!intro.ok) { console.log('  ' + intro.message); process.exit(1) }

const explainFile = join(dir, 'explain.mp3')
const ex = await speakMixed({
  text: 'هنا يشرح المتحدث كلمة mengurbankan بمعنى يضحي.',
  nativeLanguage: 'ar', targetLanguage: 'id', output: explainFile,
})
console.log('  الشرح: ' + (ex.ok ? 'سُجّل' : 'فشل'))

const out = join(dir, 'edited.mp3')
const cuts = [
  { intro: true, audio: introFile, start: 0, end: 0, explanation: 'مقدمة' },
  { start: 8, end: 10, audio: explainFile, replay: true, segments: ['x'], explanation: 'شرح' },
]
const result = await buildEditedAudio({ source, workDir: dir, output: out, cuts, onProgress: () => {} })
console.log('  التحرير: ' + (result.ok ? 'نجح' : 'فشل'))
if (!result.ok) { console.log('  ' + result.message); process.exit(1) }

const dur = (f) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries',
  'format=duration', '-of', 'default=nw=1:nk=1', f], { encoding: 'utf8' }).trim())

const srcDur = dur(source)
const outDur = dur(out)
console.log('')
console.log(`  المصدر: ${srcDur.toFixed(2)}ث`)
console.log(`  الناتج: ${outDur.toFixed(2)}ث`)
console.log(`  الحجم:  ${statSync(out).size} بايت`)

// 20s source + intro + explanation + pauses. It must be longer than the source.
const ok = outDur > srcDur + 3
check('the output is longer than the source', ok, `${outDur.toFixed(2)}s vs ${srcDur.toFixed(2)}s`)

// The recording is a 440 Hz tone; the introduction is speech. The tone holds a
// perfectly steady level while speech rises and falls, so the two regions must
// not measure the same. Identical numbers mean the intro never landed.
const { spawnSync } = await import('node:child_process')
const measure = (f, at) => {
  const r = spawnSync('ffmpeg', ['-v', 'info', '-ss', String(at), '-t', '1',
    '-i', f, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' })
  const text = `${r.stdout ?? ''}${r.stderr ?? ''}`
  const m = /mean_volume:\s*(-?[\d.]+)/.exec(text)
  return m ? Number(m[1]) : NaN
}
const introLevel = measure(out, 0.5)
const toneLevel = measure(out, outDur - 1.5)
check('the introduction region carries audio', Number.isFinite(introLevel) && introLevel > -50,
  `${introLevel} dB`)
check('the introduction differs from the tone that ends the file',
  Number.isFinite(introLevel) && Number.isFinite(toneLevel)
    && Math.abs(introLevel - toneLevel) > 0.3,
  `${introLevel} dB vs ${toneLevel} dB`)

rmSync(dir, { recursive: true, force: true })
console.log(`\n=== ${pass} passed, ${fail} failed ===\n`)
process.exit(fail === 0 ? 0 : 1)
