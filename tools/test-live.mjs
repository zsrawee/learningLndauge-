/**
 * Verify the live progress stream behaves as the browser expects.
 *
 * Opens the SSE endpoint, starts a real job, and records how the steps arrive
 * over time — proving the page can show activity during the run rather than
 * only at the end.
 */
import { readFileSync } from 'node:fs'

const BASE = 'http://127.0.0.1:4180'
const AUDIO = 'D:/Projects/anything/voice-tutor/data/tmp/indonesian-natural.wav'

const t0 = Date.now()
const at = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(5) + 's'

console.log('\n=== live progress stream test ===\n')

const controller = new AbortController()
const events = []

// Open the stream exactly as the browser does.
const stream = await fetch(`${BASE}/api/progress`, { signal: controller.signal })
console.log(`[${at()}] stream opened: HTTP ${stream.status}`)

const reader = stream.body.getReader()
const decoder = new TextDecoder()
let buffer = ''

const reading = (async () => {
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let idx
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)
        for (const line of block.split('\n')) {
          if (!line.startsWith('data:')) continue
          const msg = JSON.parse(line.slice(5).trim())
          events.push(msg)
          if (msg.type === 'step') {
            console.log(`[${at()}] step  ${String(msg.stage).padEnd(10)} ${msg.detail ?? ''}`)
          } else {
            console.log(`[${at()}] ${msg.type}`)
          }
        }
      }
    }
  } catch { /* aborted at the end */ }
})()

// Give the stream a moment to register before starting work.
await new Promise(r => setTimeout(r, 400))

const audio = readFileSync(AUDIO)
console.log(`[${at()}] uploading ${(audio.length / 1024).toFixed(0)} KB ...`)

const res = await fetch(`${BASE}/api/tutor?name=live-test.wav`, { method: 'POST', body: audio })
const result = await res.json()
console.log(`[${at()}] job ${result.ok ? 'succeeded' : 'FAILED: ' + result.message}`)

await new Promise(r => setTimeout(r, 600))
controller.abort()
await reading.catch(() => {})

// ---------------------------------------------------------------- assertions
let pass = 0, fail = 0
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' :: ' + detail : ''}`) }
}

const steps = events.filter(e => e.type === 'step')
const stages = [...new Set(steps.map(s => s.stage))]

console.log('\n--- checks ---')
check('stream delivered events', events.length > 0, `${events.length} events`)
check('job succeeded', result.ok === true, result.message ?? '')
check('start step received', stages.includes('start'))
check('transcribe step received', stages.includes('transcribe'))
check('analyze step received', stages.includes('analyze'))
check('speak step received', stages.includes('speak'))
check('edit step received', stages.includes('edit'))
check('done step received', stages.includes('done'))
check('finish marker received', events.some(e => e.type === 'finish'))

// Steps must arrive spread over time, not all at once at the end.
const timed = steps.filter(s => typeof s.at === 'number')
if (timed.length >= 2) {
  const spread = (timed[timed.length - 1].at - timed[0].at) / 1000
  check('steps were spread over the run, not batched at the end',
    spread > 3, `spread=${spread.toFixed(1)}s over ${timed.length} steps`)
} else {
  check('steps carry timestamps', false, `${timed.length} timed steps`)
}

console.log(`\n=== ${pass} passed, ${fail} failed ===\n`)
process.exit(fail === 0 ? 0 : 1)
