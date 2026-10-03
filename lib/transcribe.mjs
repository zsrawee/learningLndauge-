/**
 * Local speech-to-text via a PERSISTENT faster-whisper process.
 *
 * Loading the model costs ~27s on this machine (interpreter 12.7s + weights
 * 14.1s). Spawning it per job threw that away every time; this keeps one
 * process resident for the life of the server, so only transcription is paid
 * per job.
 *
 * Falls back to a one-shot worker if the resident process cannot start.
 */
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SERVER = join(ROOT, 'tools', 'whisper_server.py')
const WORKER = join(ROOT, 'tools', 'whisper_worker.py')

const PYTHON = ['python', 'py', 'python3']
const REQUEST_TIMEOUT_MS = 30 * 60 * 1000

/** The resident process and its pending requests. */
let child = null
let activePython = null
let ready = null
let nextId = 1
const pending = new Map()
let stdoutBuffer = ''
let spawnCount = 0

function log(msg) {
  console.log(`[whisper] ${msg}`)
}

/** Start the resident process, resolving once it reports ready. */
function startResident(python, warmModel) {
  return new Promise((resolve) => {
    spawnCount++
    const proc = spawn(python, [SERVER], {
      cwd: ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, VOICE_TUTOR_WARM_MODEL: warmModel ?? 'small' },
    })

    // Decode as UTF-8 and let Node hold back a partial character. Calling
    // String(chunk) on each raw buffer would corrupt any multi-byte character
    // that straddles a chunk boundary — routine with Arabic and Indonesian.
    proc.stdout.setEncoding('utf8')
    proc.stderr.setEncoding('utf8')

    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }

    proc.stdout.on('data', (chunk) => {
      stdoutBuffer += String(chunk)
      let index
      while ((index = stdoutBuffer.indexOf('\n')) >= 0) {
        const line = stdoutBuffer.slice(0, index).trim()
        stdoutBuffer = stdoutBuffer.slice(index + 1)
        if (!line) continue
        let msg
        try { msg = JSON.parse(line) } catch { continue }

        // The first line is the readiness banner.
        if (msg.ready === true) { finish({ ok: true }); continue }

        const waiter = pending.get(msg.id)
        if (waiter) {
          pending.delete(msg.id)
          clearTimeout(waiter.timer)
          waiter.resolve(msg)
        }
      }
    })

    proc.stderr.on('data', (chunk) => {
      for (const line of String(chunk).split('\n')) {
        const t = line.trim()
        if (t) log(t)
      }
    })

    proc.on('error', (error) => {
      finish({ ok: false, message: error.message })
      cleanup()
    })

    proc.on('close', (code) => {
      if (!settled) finish({ ok: false, message: `whisper server exited with ${code}` })
      // Reject anything still in flight so callers never hang.
      for (const [, waiter] of pending) {
        clearTimeout(waiter.timer)
        waiter.resolve({ ok: false, message: 'The transcription process stopped.' })
      }
      pending.clear()
      cleanup()
    })

    child = proc
    activePython = python
  })
}

function cleanup() {
  child = null
  ready = null
  stdoutBuffer = ''
}

async function ensureReady(warmModel) {
  if (child && ready) {
    const r = await ready
    if (r.ok) return r
  }
  ready = (async () => {
    for (const python of PYTHON) {
      const probe = await new Promise((resolve) => {
        const p = spawn(python, ['-c', 'import faster_whisper'], { stdio: 'ignore' })
        p.on('error', () => resolve(false))
        p.on('close', code => resolve(code === 0))
      })
      if (!probe) continue
      const result = await startResident(python, warmModel)
      if (result.ok) {
        log(`resident process ready via ${python} (start #${spawnCount})`)
        return result
      }
    }
    return {
      ok: false,
      message: 'faster-whisper was not found. Install it with: pip install faster-whisper',
    }
  })()
  return ready
}

/** Load the model up front so the first real job is not the slow one. */
export async function warmUp(model = 'small') {
  return ensureReady(model)
}

/**
 * Confirm faster-whisper is importable.
 * @returns {Promise<{ok:boolean, python?:string, version?:string, message?:string}>}
 */
export async function checkRuntime() {
  for (const python of PYTHON) {
    const version = await new Promise((resolve) => {
      let p
      try {
        p = spawn(python, ['-c', 'import faster_whisper;print(faster_whisper.__version__)'],
          { stdio: ['ignore', 'pipe', 'ignore'] })
      } catch { resolve(null); return }
      let out = ''
      p.stdout.on('data', c => { out += String(c) })
      p.on('error', () => resolve(null))
      p.on('close', code => resolve(code === 0 ? out.trim() : null))
    })
    if (version) return { ok: true, python, version }
  }
  return { ok: false, message: 'faster-whisper not found. Install it with: pip install faster-whisper' }
}

/** One-shot fallback, used only when the resident process cannot start. */
function runOneShot(args) {
  return new Promise((resolve) => {
    const proc = spawn(activePython ?? PYTHON[0], [WORKER, ...args], {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    proc.stdout.on('data', c => { out += String(c) })
    proc.stderr.on('data', c => { err += String(c) })
    proc.on('error', e => resolve({ ok: false, message: e.message }))
    proc.on('close', (code) => {
      const marker = out.lastIndexOf('###RESULT###')
      if (marker >= 0) {
        try { resolve(JSON.parse(out.slice(marker + 12).trim())); return } catch { /* fall through */ }
      }
      resolve({ ok: false, message: `worker exited ${code}`, detail: err.slice(-500) })
    })
  })
}

/**
 * Transcribe an audio file.
 * @returns {Promise<{ok:boolean, language?:string, segments?:Array, message?:string}>}
 */
export async function transcribe({ file, language = '', model = 'base', beamSize = 1 }, onProgress) {
  if (!existsSync(file)) return { ok: false, message: `Audio file not found: ${file}` }

  const status = await ensureReady(model)
  if (!status.ok || !child) {
    // Resident process unavailable — degrade instead of failing the job.
    onProgress?.('using one-shot worker')
    const args = [file, '--model', model]
    if (language) args.push('--language', language)
    return runOneShot(args)
  }

  const id = String(nextId++)
  onProgress?.('transcribing (model resident)')

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      resolve({ ok: false, message: 'Transcription timed out.' })
    }, REQUEST_TIMEOUT_MS)

    pending.set(id, { resolve, timer })

    try {
      child.stdin.write(JSON.stringify({ id, file, language, model, beamSize }) + '\n')
    } catch (error) {
      clearTimeout(timer)
      pending.delete(id)
      resolve({ ok: false, message: `Could not send the request: ${error.message}` })
    }
  })
}

/** Stop the resident process on server shutdown. */
export function shutdown() {
  if (!child) return
  try { child.stdin.write(JSON.stringify({ cmd: 'shutdown' }) + '\n') } catch { /* ignore */ }
  try { child.kill() } catch { /* ignore */ }
  child = null
}
