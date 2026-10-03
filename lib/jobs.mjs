/**
 * Job store: keeps every finished stage on disk so a failure late in the
 * pipeline never throws away the work that already succeeded.
 *
 * The expensive part of this app is transcription — minutes of CPU on a weak
 * machine. If the AI provider then fails, re-running transcription from scratch
 * is pure waste. Each stage is written as its own file, and a retry picks up
 * from the last stage that completed.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './store.mjs'

export const JOBS_DIR = join(ROOT, 'data', 'jobs')

/** A job that has not been touched for this long is cleaned up. */
const JOB_TTL_MS = 3 * 24 * 60 * 60 * 1000

const STAGE_FILES = {
  source: 'source.bin',       // the uploaded audio, kept so a retry needs no re-upload
  transcript: 'transcript.json',
  interview: 'interview.json', // the questions asked, and the learner's answers
  analysis: 'analysis.json',
  speech: 'speech.json',
  output: 'output.json',
}

function jobDir(id) { return join(JOBS_DIR, id) }
function stagePath(id, stage) { return join(jobDir(id), STAGE_FILES[stage]) }

export function ensureJobsDir() { mkdirSync(JOBS_DIR, { recursive: true }) }
export function newJobId() {
  return 'j' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

/**
 * Whether a string is a job id this module could have produced.
 *
 * Every route that turns a request parameter into a filesystem path must use
 * this, so the accepted shape can never drift from the generated one.
 */
export function isJobId(value) {
  return /^j[0-9a-z]{8,24}$/.test(String(value ?? ''))
}

/** Path of a produced mp3, or null when the id is not one we would generate. */
export function outputPath(id) {
  return isJobId(id) ? join(ROOT, 'data', 'output', `${id}.mp3`) : null
}

/** Read a saved stage, or null when it was never completed. */
export function readStage(id, stage) {
  const p = stagePath(id, stage)
  if (!existsSync(p)) return null
  try {
    if (stage === 'source') return readFileSync(p)
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

export function writeStage(id, stage, value) {
  ensureJobsDir()
  mkdirSync(jobDir(id), { recursive: true })
  const p = stagePath(id, stage)
  if (stage === 'source') writeFileSync(p, value)
  else writeFileSync(p, JSON.stringify(value), 'utf8')
  return p
}

export function hasStage(id, stage) { return existsSync(stagePath(id, stage)) }

/** Which stages a job already has, for deciding where a retry resumes. */
export function jobStages(id) {
  const out = {}
  for (const stage of Object.keys(STAGE_FILES)) out[stage] = hasStage(id, stage)
  return out
}

/** Everything the browser needs to offer a retry, without the audio itself. */
export function jobSummary(id) {
  if (!existsSync(jobDir(id))) return null
  const meta = readStage(id, 'output') ?? readStage(id, 'analysis') ?? readStage(id, 'transcript')
  const stages = jobStages(id)
  return {
    id,
    stages,
    canResume: stages.source && stages.transcript,
    // An empty string is not a name; `??` would have passed it on as the
    // label the next retry sends back, and the name would be lost forever.
    name: (meta?.name ?? '').trim() || null,
    segments: readStage(id, 'transcript')?.segments?.length ?? 0,
    hasOutput: stages.output,
    outputId: readStage(id, 'output')?.outputId ?? null,
    downloadName: readStage(id, 'output')?.downloadName ?? null,
  }
}

/**
 * Drop the stages that a retry must recompute.
 *
 * `from` is the stage that failed; everything at or after it is stale, while
 * everything before it is still valid.
 */
export function invalidateFrom(id, from) {
  const order = ['source', 'transcript', 'interview', 'analysis', 'speech', 'output']
  const idx = order.indexOf(from)
  if (idx < 0) return
  for (const stage of order.slice(idx)) {
    if (stage === 'source') continue // never drop the upload: it saves a re-upload
    const p = stagePath(id, stage)
    if (existsSync(p)) { try { rmSync(p) } catch { /* best effort */ } }
  }
}

/** Remove old jobs so the folder cannot grow without bound. */
export function pruneJobs(now = Date.now()) {
  ensureJobsDir()
  let removed = 0
  for (const id of readdirSync(JOBS_DIR)) {
    try {
      const info = statSync(jobDir(id))
      if (now - info.mtimeMs > JOB_TTL_MS) { rmSync(jobDir(id), { recursive: true, force: true }); removed++ }
    } catch { /* skip */ }
  }
  return removed
}
