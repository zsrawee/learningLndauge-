/**
 * The edit itself: cut the original at each hard passage, splice in a spoken
 * explanation, then continue.
 *
 * Output is one continuous audio file — the learner downloads it and listens;
 * there is nothing to operate.
 *
 * Strategy: build each piece as its own normalized WAV, then concatenate. This
 * is far cheaper than one giant filter graph, which matters on a weak CPU.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, existsSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const FFMPEG = process.env.FFMPEG ?? 'ffmpeg'
const FFPROBE = process.env.FFPROBE ?? 'ffprobe'

/** Everything is resampled to one format so concatenation never drifts. */
export const AUDIO = { sampleRate: 44100, channels: 2, codec: 'libmp3lame', bitrate: '128k' }

function run(bin, args, { capture = true } = {}) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' })
    let out = ''
    let err = ''
    child.stdout?.on('data', c => { out += String(c) })
    child.stderr?.on('data', c => { err += String(c) })
    child.on('error', e => resolve({ code: -1, out, err: e.message }))
    child.on('close', code => resolve({ code, out, err }))
  })
}

/** Duration in seconds, or 0 when unreadable. */
export async function duration(file) {
  const r = await run(FFPROBE, [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=nw=1:nk=1', file,
  ])
  const value = Number.parseFloat(r.out.trim())
  return Number.isFinite(value) ? value : 0
}

/** Re-encode one clip to the shared format. Returns true on success. */
async function normalize(input, output) {
  const r = await run(FFMPEG, [
    '-y', '-i', input,
    '-ar', String(AUDIO.sampleRate),
    '-ac', String(AUDIO.channels),
    '-c:a', 'pcm_s16le',
    output,
  ])
  return r.code === 0 && existsSync(output)
}

/** Cut [start, end] out of the source into a normalized clip. */
async function slice(source, start, end, output) {
  const span = Math.max(0, end - start)
  if (span < 0.05) return false
  const r = await run(FFMPEG, [
    '-y', '-ss', start.toFixed(3), '-t', span.toFixed(3), '-i', source,
    '-ar', String(AUDIO.sampleRate), '-ac', String(AUDIO.channels),
    '-c:a', 'pcm_s16le', output,
  ])
  return r.code === 0 && existsSync(output)
}

/** Generate a short silence so the spoken explanation does not sound clipped. */
async function silence(seconds, output) {
  const r = await run(FFMPEG, [
    '-y', '-f', 'lavfi',
    '-i', `anullsrc=r=${AUDIO.sampleRate}:cl=${AUDIO.channels === 2 ? 'stereo' : 'mono'}`,
    '-t', seconds.toFixed(3), '-c:a', 'pcm_s16le', output,
  ])
  return r.code === 0 && existsSync(output)
}

/** Concatenate normalized WAVs in order. */
async function concat(parts, output) {
  const listFile = output + '.txt'
  writeFileSync(listFile, parts.map(p => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'), 'utf8')
  const r = await run(FFMPEG, [
    '-y', '-f', 'concat', '-safe', '0', '-i', listFile,
    '-c:a', AUDIO.codec, '-b:a', AUDIO.bitrate,
    output,
  ])
  try { rmSync(listFile) } catch { /* best effort */ }
  return r.code === 0 && existsSync(output)
}

/**
 * Build the edited audio.
 *
 * @param {object} options
 * @param {string} options.source      original audio
 * @param {string} options.workDir     scratch directory
 * @param {string} options.output      final mp3 path
 * @param {Array}  options.cuts        [{start, end, audio, repeatText}]
 * @param {(msg:string)=>void} [options.onProgress]
 */
export async function buildEditedAudio({ source, workDir, output, cuts, onProgress }) {
  mkdirSync(workDir, { recursive: true })
  const total = await duration(source)
  if (total <= 0) return { ok: false, message: 'Could not read the source audio duration.' }

  const parts = []
  let cursor = 0
  let index = 0

  const push = async (file, label) => {
    if (file && existsSync(file)) parts.push(file)
    onProgress?.(label)
  }

  // The introduction is spoken before the recording starts, whatever order it
  // was placed in. Rendering it from position rather than by its own start
  // keeps it correct even if the cut list is ever sorted or filtered.
  for (const cut of cuts.filter(c => c.intro)) {
    if (cut.audio && existsSync(cut.audio)) {
      const f = join(workDir, `intro-${index}.wav`)
      if (await normalize(cut.audio, f)) await push(f, 'introduction')
    }
    const beat = join(workDir, `intro-beat-${index}.wav`)
    if (await silence(0.45, beat)) await push(beat, 'pause')
    index++
  }

  for (const cut of cuts) {
    if (cut.intro) continue
    const start = Math.max(0, Math.min(cut.start, total))
    const end = Math.max(start, Math.min(cut.end, total))

    // 1. Original audio up to the hard passage.
    if (start - cursor > 0.05) {
      const f = join(workDir, `orig-${index}.wav`)
      if (await slice(source, cursor, start, f)) await push(f, `cut original up to ${start.toFixed(1)}s`)
    }

    // 2. The hard passage itself, replayed so the learner hears it again.
    //    The learner can turn this off; then only the explanation is inserted.
    if (cut.replay !== false && end - start > 0.05) {
      const f = join(workDir, `passage-${index}.wav`)
      if (await slice(source, start, end, f)) await push(f, `replay passage ${start.toFixed(1)}-${end.toFixed(1)}s`)
    }

    // 3. A short beat, then the spoken explanation.
    const gap = join(workDir, `gap-${index}.wav`)
    if (await silence(0.35, gap)) await push(gap, 'pause')

    if (cut.audio && existsSync(cut.audio)) {
      const f = join(workDir, `explain-${index}.wav`)
      if (await normalize(cut.audio, f)) await push(f, `explanation ${index + 1}`)
    }

    const after = join(workDir, `after-${index}.wav`)
    if (await silence(0.45, after)) await push(after, 'pause')

    cursor = end
    index++
  }

  // 4. Whatever remains of the original.
  if (total - cursor > 0.05) {
    const f = join(workDir, 'orig-tail.wav')
    if (await slice(source, cursor, total, f)) await push(f, 'remaining original')
  }

  if (parts.length === 0) return { ok: false, message: 'Nothing to render — no cuts were produced.' }

  const ok = await concat(parts, output)
  if (!ok) return { ok: false, message: 'ffmpeg failed to assemble the final file.' }

  return {
    ok: true,
    output,
    duration: await duration(output),
    cuts: cuts.length,
    parts: parts.length,
  }
}
