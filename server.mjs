/**
 * Voice Tutor — local server.
 *
 * Serves the upload page, runs the edit pipeline, and hands back the finished
 * audio file. Binds to loopback only: it holds an API key and personal audio.
 */
import { createServer } from 'node:http'
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'

import { ROOT, getBrief, getSecretsState, getSettings, paths, saveBrief, setSecrets, updateSettings } from './lib/store.mjs'
import { runPipeline } from './lib/pipeline.mjs'
import { checkRuntime, shutdown as shutdownWhisper, warmUp } from './lib/transcribe.mjs'
import { fetchModels, resolveProvider } from './lib/provider.mjs'
import { FIXED_QUESTIONS } from './lib/analyze.mjs'
import { listVoices } from './lib/speech.mjs'
import {
  JOBS_DIR, ensureJobsDir, hasStage, isJobId, jobStages, jobSummary, newJobId, pruneJobs, readStage, writeStage,
} from './lib/jobs.mjs'

const PUBLIC = join(ROOT, 'public')
const UPLOADS = join(ROOT, 'data', 'uploads')
const OUTPUT = join(ROOT, 'data', 'output')
const PORT = Number(process.env.PORT ?? 4180)
const HOST = '127.0.0.1'

for (const d of [UPLOADS, OUTPUT]) mkdirSync(d, { recursive: true })

const AUDIO_EXT = new Set(['.mp3', '.wav', '.m4a', '.ogg', '.opus', '.webm', '.mp4', '.flac', '.aac'])

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.webm': 'audio/webm',
}

/** One job at a time: this machine is weak and the pipeline is CPU-bound. */
let busy = false
let busySince = 0
const lastJob = { id: null, name: null }

/** A job that runs longer than this is assumed dead and the slot is freed. */
const JOB_STALE_MS = 45 * 60 * 1000

const LOCK_FILE = join(ROOT, 'data', '.run-lock')

/**
 * The lock is a file, not a flag, because two server processes share this
 * folder. A leftover second server (from an unclean restart) would not see the
 * first one's in-memory `busy` and could start the same job again — which
 * regenerates the analysis and silently changes the explanation count on the
 * learner. The file is created with 'wx' so the check-and-create step cannot
 * let both processes through at once.
 *
 * Returns false when another run owns the slot.
 */
function lockJob() {
  const claim = () => JSON.stringify({ pid: process.pid, since: Date.now() })
  try {
    writeFileSync(LOCK_FILE, claim(), { flag: 'wx' })
  } catch (e) {
    if (e.code !== 'EEXIST') return false
    // A lock older than the stale limit belongs to a process that died;
    // take the slot instead of waiting on something that will never finish.
    let heldSince = 0
    try { heldSince = JSON.parse(readFileSync(LOCK_FILE, 'utf8')).since ?? 0 } catch { /* corrupt */ }
    if (Date.now() - heldSince < JOB_STALE_MS) {
      busy = true
      busySince = heldSince
      return false
    }
    try { writeFileSync(LOCK_FILE, claim()) } catch { return false }
  }
  busy = true
  busySince = Date.now()
  return true
}

function unlockJob() {
  try { unlinkSync(LOCK_FILE) } catch { /* already gone */ }
  busy = false
  busySince = 0
}

/** Browsers watching /api/progress, so steps appear live. */
const watchers = new Set()

function broadcast(payload) {
  const line = `data: ${JSON.stringify(payload)}\n\n`
  for (const res of watchers) {
    try { res.write(line) } catch { watchers.delete(res) }
  }
}

function json(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

function readBody(req, limit = 2 * 1024 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', c => {
      size += c.length
      if (size > limit) { reject(new Error('File too large')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

async function readJson(req) {
  const b = await readBody(req, 1024 * 1024)
  if (b.length === 0) return {}
  try { return JSON.parse(b.toString('utf8')) } catch { return {} }
}

/* ------------------------------------------------------------------ routes */

const routes = {
  'GET /api/state': async () => ({
    ok: true,
    settings: getSettings(),
    secrets: getSecretsState(),
    busy,
    last: lastJob,
  }),

  'GET /api/runtime': async () => {
    const runtime = await checkRuntime()
    return { ok: true, whisper: runtime }
  },

  'GET /api/voices': async () => {
    const result = await listVoices()
    if (!result.ok) return result
    // Group by locale so the UI can offer a short list.
    const byLocale = {}
    for (const v of result.voices) {
      const lang = v.locale.split('-')[0]
      ;(byLocale[lang] ??= []).push(v)
    }
    return { ok: true, voices: result.voices, byLocale }
  },

  'POST /api/settings': async (req) => ({
    ok: true,
    settings: updateSettings(await readJson(req)),
  }),

  'POST /api/secrets': async (req) => ({
    ok: true,
    secrets: setSecrets(await readJson(req)),
  }),

  'POST /api/models': async (req) => {
    const { baseURL, apiKey } = await readJson(req)
    const result = await fetchModels({ baseURL, apiKey })
    if (!result.ok) return result
    // Return the whole list so the page can show a real chooser.
    return { ok: true, models: result.models, count: result.models.length, warning: result.warning }
  },

  /**
   * Work out which provider a pasted key belongs to by asking each one.
   * Prefix guessing is unreliable, so this settles it with real requests.
   */
  'POST /api/detect-provider': async (req) => {
    const { apiKey } = await readJson(req)
    const result = await resolveProvider(apiKey)
    if (!result.ok) return result
    return { ok: true, provider: result.provider, owner: result.owner, models: result.models }
  },

  /**
   * Live progress stream (Server-Sent Events).
   *
   * Handlers receive (req, url, res); this one owns the response for the whole
   * job instead of answering once, so it returns undefined to tell the
   * dispatcher not to finish the response.
   */
  'GET /api/progress': async (req, _url, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    res.write(`data: ${JSON.stringify({ type: 'hello', busy })}\n\n`)
    watchers.add(res)

    // Keep proxies and the browser from closing an idle stream.
    const keepAlive = setInterval(() => {
      try { res.write(': ping\n\n') } catch { /* closed */ }
    }, 15_000)

    req.on('close', () => {
      clearInterval(keepAlive)
      watchers.delete(res)
    })
    return undefined // this handler owns the response
  },

  /** Upload, then run the whole pipeline and return when the file is ready. */
  'POST /api/tutor': async (req, url) => {
    // The lock file also clears a slot left behind by a process that died.
    if (!lockJob()) {
      const elapsed = Math.round((Date.now() - busySince) / 1000)
      return {
        ok: false,
        message: `هناك مهمة قيد التنفيذ منذ ${elapsed} ثانية. انتظر حتى تنتهي.`,
      }
    }
    // A retry reuses the previous job so its saved stages are picked up.
    const reuse = url.searchParams.get('jobId')
    const isRetry = Boolean(reuse && hasStage(reuse, 'source'))

    // The browser can send an empty name (a stale cached page, or a job whose
    // recorded name was lost). An empty name is not the same as no name: `??`
    // leaves '' standing, which then produces an extension-less upload path
    // and breaks the resume. Fall back to whatever the saved stages remember.
    const name = (url.searchParams.get('name') ?? '').trim()
      || (isRetry
        ? (readStage(reuse, 'analysis')?.name
          ?? readStage(reuse, 'transcript')?.name
          ?? 'audio.mp3')
        : 'audio.mp3')
    const ext = extname(name).toLowerCase()
    if (ext && !AUDIO_EXT.has(ext)) {
      return { ok: false, message: `Unsupported audio type "${ext}".` }
    }

    const buffer = await readBody(req)

    // On a retry the audio is already on disk, so an empty body is expected and
    // correct; only a first-time upload must carry the file.
    if (buffer.length === 0 && !isRetry) {
      return { ok: false, message: 'الملف المرفوع فارغ.' }
    }

    const id = isRetry ? reuse : newJobId()
    const file = join(UPLOADS, id + ext)

    if (isRetry) {
      // Re-materialise the upload from the saved copy so ffmpeg has a path.
      writeFileSync(file, readStage(id, 'source'))
    } else {
      writeStage(id, 'source', buffer)
      writeFileSync(file, buffer)
    }

    lastJob.id = null
    lastJob.name = name
    const stages = []

    // Stream each step to any browser watching /api/progress, so the page can
    // show what is happening instead of a bare spinner.
    const emit = (stage, detail) => {
      const entry = { stage, detail: detail ?? '', at: Date.now() }
      stages.push(entry)
      console.log(`[${stage}] ${entry.detail}`)
      broadcast({ type: 'step', ...entry })
    }
    emit('start', reuse ? `إعادة المحاولة على «${name}»` : `تم استلام «${name}»`)

    try {
      const result = await runPipeline({ jobId: id, file, name, onProgress: emit })
      if (result.ok) {
        lastJob.id = result.id
        emit('done', 'الملف جاهز للتحميل')
      } else {
        emit('error', result.message ?? 'فشل')
      }
      broadcast({ type: 'finish', ok: result.ok === true })
      // Tell the browser what failed and whether a retry is worth offering.
      return {
        ...result,
        jobId: id,
        stages,
        saved: jobStages(id),
        canRetry: result.ok !== true && result.stage !== 'transcribe',
      }
    } catch (error) {
      console.error('[pipeline]', error)
      emit('error', String(error?.message ?? error))
      broadcast({ type: 'finish', ok: false })
      return {
        ok: false, jobId: id, canRetry: true, saved: jobStages(id),
        message: String(error?.message ?? error), stage: 'unknown',
      }
    } finally {
      unlockJob()
    }
  },

  /** What a saved job still has, so the page can offer to resume it. */
  'GET /api/job': async (_req, url) => {
    const id = url.searchParams.get('id')
    const summary = id ? jobSummary(id) : null
    if (!summary) return { ok: false, message: 'لا توجد مهمة محفوظة بهذا المعرّف.' }
    return { ok: true, job: summary }
  },

  // A page that was closed or refreshed mid-run loses the retry button, so it
  // needs a way back to a job whose expensive stages already succeeded.
  'GET /api/pending': async () => {
    if (busy) return { ok: true, job: null }
    const ids = readdirSync(JOBS_DIR).filter(isJobId)
      .sort((a, b) => statSync(join(JOBS_DIR, b)).mtimeMs - statSync(join(JOBS_DIR, a)).mtimeMs)
    for (const id of ids) {
      const summary = jobSummary(id)
      // Resumable means the transcript survived but no finished audio exists
      // yet. A job that already has an output is done, and shows up in the
      // downloads list instead.
      if (summary?.canResume && !summary.hasOutput) {
        const progress = jobStages(id)
        return {
          ok: true,
          job: {
            ...summary,
            analyzed: progress.analysis,
            spoken: progress.speech ? Object.keys(readStage(id, 'speech')?.speech ?? {}).length : 0,
          },
        }
      }
    }
    return { ok: true, job: null }
  },

  'GET /api/outputs': async () => {
    const files = readdirSync(OUTPUT).filter(f => f.endsWith('.mp3'))
    return {
      ok: true,
      outputs: files.map(f => ({
        id: f.replace(/\.mp3$/, ''),
        bytes: statSync(join(OUTPUT, f)).size,
      })).sort((a, b) => b.id.localeCompare(a.id)),
    }
  },

  'POST /api/outputs/delete': async (req) => {
    const { id } = await readJson(req)
    if (!isJobId(id)) return { ok: false, message: 'Bad id' }
    const p = join(OUTPUT, `${id}.mp3`)
    if (existsSync(p)) { try { unlinkSync(p) } catch { /* ignore */ } }
    return { ok: true }
  },

  /* ------------------------------------------------------- learner brief */

  /** Save the learner's own instructions and answers, prefilled next time. */
  'POST /api/brief': async (req) => {
    const patch = await readJson(req)
    const brief = saveBrief(patch)
    return { ok: true, brief }
  },

  /** What the learner already told us, so the page can prefill the fields. */
  'GET /api/brief': async () => ({ ok: true, brief: getBrief() }),

  /** The fixed intake questions, so the page can render them without a model. */
  'GET /api/questions': async () => ({ ok: true, questions: FIXED_QUESTIONS }),

  /**
   * Resume a job that paused to ask the learner something.
   *
   * The transcript is already saved, so this is cheap. The answers are stored
   * on the job AND on the brief, so they prefill the form next time.
   */
  'POST /api/answer': async (req, url) => {
    const jobId = url.searchParams.get('jobId')
    if (!isJobId(jobId)) return { ok: false, message: 'Bad job id' }
    if (!hasStage(jobId, 'transcript')) {
      return { ok: false, message: 'لا يوجد نص محفوظ لهذه المهمة.' }
    }
    const body = await readJson(req)
    const answers = body?.answers && typeof body.answers === 'object' ? body.answers : {}

    // Keep the recorded questions on the job, with their answers beside them.
    const interview = readStage(jobId, 'interview') ?? { questions: FIXED_QUESTIONS, mode: 'ai' }
    interview.answers = answers
    writeStage(jobId, 'interview', interview)

    // Answers that apply to the learner generally are saved to the brief too,
    // so the next recording starts with them prefilled. AI-mode questions are
    // recording-specific, so only the fixed set carries over.
    const brief = getBrief()
    const merged = { ...brief.answers }
    for (const q of FIXED_QUESTIONS) {
      const v = answers[q.id]
      if (v !== undefined) merged[q.id] = v
    }
    saveBrief({ answers: merged })

    // Resume the pipeline from the saved transcript.
    // A paused job has no output/analysis stage yet, so the original name is
    // recovered from whatever the upload actually wrote — the extension is
    // whatever the learner picked, not always .mp3.
    const uploaded = existsSync(UPLOADS)
      ? readdirSync(UPLOADS).find(f => f.startsWith(jobId + '.'))
      : null
    if (!uploaded) {
      return { ok: false, message: 'الملف الأصلي غير موجود على القرص.' }
    }
    const file = join(UPLOADS, uploaded)
    const name = (readStage(jobId, 'output')?.name ?? '').trim()
      || (readStage(jobId, 'analysis')?.name ?? '').trim()
      || (readStage(jobId, 'transcript')?.name ?? '').trim()
      || uploaded.slice(jobId.length + 1)

    if (!lockJob()) {
      const elapsed = Math.round((Date.now() - busySince) / 1000)
      return {
        ok: false,
        message: `هناك مهمة قيد التنفيذ منذ ${elapsed} ثانية. انتظر حتى تنتهي.`,
      }
    }

    const stages = []
    const emit = (stage, detail) => {
      const entry = { stage, detail: detail ?? '', at: Date.now() }
      stages.push(entry)
      console.log(`[${stage}] ${entry.detail}`)
      broadcast({ type: 'step', ...entry })
    }
    emit('start', `استئناف المهمة بعد إجاباتك على «${name}»`)

    try {
      const result = await runPipeline({ jobId, file, name, onProgress: emit })
      if (result.ok) {
        lastJob.id = result.id ?? jobId
        lastJob.name = name
        emit('done', 'الملف جاهز للتحميل')
      } else {
        emit('error', result.message ?? 'فشل')
      }
      broadcast({ type: 'finish', ok: result.ok === true })
      return {
        ...result,
        jobId,
        stages,
        saved: jobStages(jobId),
        canRetry: result.ok !== true && result.stage !== 'transcribe',
      }
    } catch (error) {
      console.error('[pipeline]', error)
      emit('error', String(error?.message ?? error))
      broadcast({ type: 'finish', ok: false })
      return {
        ok: false, jobId, canRetry: true, saved: jobStages(jobId),
        message: String(error?.message ?? error), stage: 'unknown',
      }
    } finally {
      unlockJob()
    }
  },
}

/* ----------------------------------------------------------------- static */

function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname)
  if (pathname === '/') pathname = '/index.html'

  if (pathname.startsWith('/file/')) {
    const id = pathname.slice('/file/'.length)
    // Job ids come from newJobId(), not from a UUID, so validate them with the
    // same shape the generator produces. A stricter pattern here silently
    // 404s every produced file.
    if (!isJobId(id)) { res.writeHead(404); res.end('Not found'); return true }
    const p = join(OUTPUT, `${id}.mp3`)
    if (!existsSync(p)) { res.writeHead(404); res.end('Not found'); return true }
    streamFile(req, res, p, 'audio/mpeg')
    return true
  }

  const target = normalize(join(PUBLIC, pathname))
  if (!target.startsWith(PUBLIC) || !existsSync(target) || !statSync(target).isFile()) return false
  streamFile(req, res, target, MIME[extname(target).toLowerCase()] ?? 'application/octet-stream')
  return true
}

function streamFile(req, res, file, type) {
  const size = statSync(file).size
  const range = req.headers.range
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range)
    if (m) {
      const start = m[1] ? Number(m[1]) : 0
      const end = m[2] ? Number(m[2]) : size - 1
      if (start < size) {
        res.writeHead(206, {
          'Content-Type': type,
          'Content-Range': `bytes ${start}-${end}/${size}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': end - start + 1,
        })
        createReadStream(file, { start, end }).pipe(res)
        return
      }
    }
  }
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes' })
  createReadStream(file).pipe(res)
}

/* ----------------------------------------------------------------- server */

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? HOST}`)
  const method = req.method ?? 'GET'
  try {
    const handler = routes[`${method} ${url.pathname}`]
    if (handler) {
      const result = await handler(req, url, res)
      // A streaming handler owns its response and returns undefined.
      if (result === undefined) return
      // Long jobs can outlive the client; only write when still open.
      if (!res.headersSent) json(res, 200, result)
      return
    }
    if ((method === 'GET' || method === 'HEAD') && serveStatic(req, res, url)) return
    json(res, 404, { ok: false, message: 'Not found' })
  } catch (error) {
    console.error('[error]', error)
    if (!res.headersSent) json(res, 500, { ok: false, message: String(error?.message ?? error) })
  }
})

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    // Almost always a previous window still running. Say so plainly instead of
    // dumping a stack trace, and give the one command that fixes it.
    console.error(`\n  Port ${PORT} is already in use.`)
    console.error('  Another Voice Tutor window is probably still open.\n')
    console.error('  To find and stop it:')
    console.error(`    Get-NetTCPConnection -LocalPort ${PORT} -State Listen |`)
    console.error('      ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }\n')
    console.error('  Or start this copy on a different port:')
    console.error(`    $env:PORT=4181; node server.mjs\n`)
    process.exit(1)
  }
  console.error('\n  Server error:', error.message, '\n')
  process.exit(1)
})

server.listen(PORT, HOST, () => {
  console.log(`\n  Voice Tutor is running:  http://${HOST}:${PORT}\n`)
  console.log(`  Data: ${paths.DATA}`)
  console.log('  Press Ctrl+C to stop.\n')

  // Saved stages are what make a retry cheap, so the folder must exist.
  ensureJobsDir()
  const pruned = pruneJobs()
  if (pruned > 0) console.log(`  Removed ${pruned} expired job(s).`)

  // Load the Whisper model now, in the background. It costs ~27s once; paying
  // it at startup means the first job the user submits is not the slow one.
  const model = getSettings().transcription.model
  console.log(`  Warming up the transcription model ('${model}')...`)
  warmUp(model).then((result) => {
    if (result.ok) console.log('  Transcription model ready.\n')
    else console.warn(`  Warm-up failed: ${result.message}\n`)
  })
})

// Release the resident Whisper process cleanly.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    shutdownWhisper()
    process.exit(0)
  })
}
