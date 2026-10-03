/**
 * The workers must survive text outside the console codepage.
 *
 * A real job died mid-transcription with
 *   UnicodeEncodeError: 'charmap' codec can't encode characters ...
 * because Python wrote UTF-8 JSON to a stdout governed by cp1256. Anything the
 * transcript happened to contain could kill the process.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { ROOT } from '../lib/store.mjs'

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ` :: ${detail}` : ''}`) }
}

const runPython = (script, args, input) => new Promise((resolve) => {
  const p = spawn('python', [join(ROOT, 'tools', script), ...args], {
    cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'],
  })
  p.stdout.setEncoding('utf8')
  p.stderr.setEncoding('utf8')
  let out = ''
  let err = ''
  p.stdout.on('data', (c) => { out += c })
  p.stderr.on('data', (c) => { err += c })
  p.on('error', (e) => resolve({ code: -1, out, err: e.message }))
  p.on('close', (code) => resolve({ code, out, err }))
  if (input !== undefined) { p.stdin.write(input); p.stdin.end() }
  else p.stdin.end()
})

console.log('\n=== whisper worker: text outside the console codepage ===\n')

// The codepage on this machine cannot represent these characters. Before the
// fix, emitting them raised UnicodeEncodeError and killed the process.
const banner = await runPython('whisper_server.py', [], JSON.stringify({ cmd: 'shutdown' }) + '\n')
check('the whisper worker starts', banner.code === 0 || banner.out.length > 0,
  `code ${banner.code}`)
check('its banner is valid UTF-8 JSON',
  banner.out.split('\n').some(l => {
    try { return JSON.parse(l).ready === true } catch { return false }
  }), banner.out.slice(0, 120))
check('no encode error on the whisper worker',
  !/UnicodeEncodeError|charmap/.test(banner.err), banner.err.slice(-160))

console.log('\n=== tts worker: Arabic and Indonesian round-trip ===\n')

const voices = await runPython('tts_worker.py', ['--list'])
const result = /###RESULT###(.*)/.exec(voices.out)
check('the voice list comes back', Boolean(result), voices.out.slice(0, 80))
check('no encode error on the voice list',
  !/UnicodeEncodeError|charmap/.test(voices.err), voices.err.slice(-160))
if (result) {
  const parsed = JSON.parse(result[1])
  check('the voice list is valid JSON with voices',
    parsed.ok === true && Array.isArray(parsed.voices) && parsed.voices.length > 50,
    `${parsed.voices?.length} voices`)
  check('Arabic voices are present',
    parsed.voices.some(v => v.locale?.startsWith('ar-')))
  check('Indonesian voices are present',
    parsed.voices.some(v => v.locale?.startsWith('id-')))
}

// An actual synthesis of Arabic + Indonesian text, the exact case that matters.
const outDir = join(ROOT, 'data', 'tmp')
mkdirSync(outDir, { recursive: true })
const outFile = join(outDir, 'unicode-check.mp3')
const { rmSync } = await import('node:fs')
rmSync(outFile, { force: true })

const text = 'كلمة mengurbankan تعني يضحي، و jam kosong تعني الحصة الفارغة. '
  + 'وربما نقابل رمزاً غريباً مثل 日本語 أو emoji 🎧.'
const spoken = await runPython('tts_worker.py', ['--text', text, '--voice', 'ar-EG-ShakirNeural', '--out', outFile])
check('mixed Arabic and Indonesian text speaks without crashing',
  spoken.code === 0, `code ${spoken.code}: ${spoken.err.slice(-160)}`)
check('the mp3 was written',
  existsSync(outFile) && statSync(outFile).size > 1000,
  existsSync(outFile) ? `${statSync(outFile).size} bytes` : 'missing')

console.log(`\n=== ${pass} passed, ${fail} failed ===\n`)
process.exit(fail === 0 ? 0 : 1)
