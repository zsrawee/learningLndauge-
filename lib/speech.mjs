/**
 * Turn explanation text into audio.
 *
 * Two paths, chosen by whether the user has configured a speech provider:
 *   - edge-tts (default): free, no key, natural neural voices. 27 Arabic voices.
 *   - provider: any OpenAI-compatible /audio/speech endpoint, when a key exists.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const TTS_WORKER = join(ROOT, 'tools', 'tts_worker.py')

/** Sensible default voices per language, chosen from what edge-tts offers. */
export const EDGE_VOICES = {
  ar: ['ar-EG-ShakirNeural', 'ar-SA-HamedNeural', 'ar-AE-HamdanNeural'],
  id: ['id-ID-ArdiNeural', 'id-ID-GadisNeural'],
  en: ['en-US-GuyNeural', 'en-US-AriaNeural'],
}

function python(args) {
  return new Promise((resolve) => {
    const child = spawn('python', [TTS_WORKER, ...args], {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', c => { out += String(c) })
    child.stderr.on('data', c => { err += String(c) })
    child.on('error', e => resolve({ ok: false, message: e.message }))
    child.on('close', code => {
      const marker = out.lastIndexOf('###RESULT###')
      if (marker >= 0) {
        try { resolve(JSON.parse(out.slice(marker + 12).trim())); return } catch { /* fall through */ }
      }
      resolve({ ok: false, message: `tts worker exited ${code}: ${err.slice(-300)}` })
    })
  })
}

/**
 * Edge-TTS answers a burst of requests with "No audio was received" — it is a
 * rate limit, not an opinion about the text. Each explanation splits into
 * several fragments (one per Indonesian word woven into the Arabic), so a long
 * recording is hundreds of calls back to back, and the endpoint throttles the
 * burst well before the job is half done. Two things keep it finishing:
 *  - a minimum gap between calls, so we never burst in the first place;
 *  - a long backoff when it refuses anyway, long enough for the counter to reset.
 */
const TTS_MIN_GAP_MS = 1200
const TTS_DELAYS = [5000, 15000, 40000]
let lastTtsAt = 0

async function pythonRetry(args) {
  // Pace every call, retries included, so a long job never trips the burst
  // limit. The first call of a run is also spaced — a retry that follows a
  // run which just died is still a burst from the endpoint's point of view.
  const wait = lastTtsAt ? Math.max(0, lastTtsAt + TTS_MIN_GAP_MS - Date.now()) : 0
  if (wait > 0) await new Promise(r => setTimeout(r, wait))

  let result = await python(args)
  lastTtsAt = Date.now()
  for (const delay of TTS_DELAYS) {
    if (result.ok) break
    await new Promise(r => setTimeout(r, delay))
    result = await python(args)
    lastTtsAt = Date.now()
  }
  return result
}

/**
 * Synthesize one explanation to an mp3.
 *
 * @param {object} opts
 * @param {string} opts.text
 * @param {string} opts.language   ISO code of the spoken text
 * @param {string} opts.output     destination mp3
 * @param {object} [opts.provider] { baseURL, apiKey, model, voice } for the paid path
 */
export async function speak({ text, language, output, provider }) {
  if (!text || text.trim().length === 0) {
    return { ok: false, message: 'Nothing to speak.' }
  }
  mkdirSync(dirname(output), { recursive: true })

  // Paid path: an OpenAI-compatible speech endpoint.
  if (provider?.baseURL && provider?.apiKey) {
    const result = await speakViaProvider({ text, output, provider })
    if (result.ok) return result
    // Fall through to the free path rather than failing the whole job.
    console.warn('provider speech failed, falling back to edge-tts:', result.message)
  }

  const voice = (EDGE_VOICES[language] ?? EDGE_VOICES.en)[0]
  const result = await pythonRetry(['--text', text, '--voice', voice, '--out', output])
  if (!result.ok) {
    // edge-tts streams the audio to disk as it arrives, then can raise
    // "No audio was received" while tearing the socket down — after a full,
    // playable file was already written. A retry that also fails but leaves a
    // valid file behind is a success for our purposes, not a failure.
    if (await isPlayable(output)) {
      console.warn('edge-tts reported failure but left a playable file:', result.message)
      return { ok: true, output, engine: 'edge-tts', voice }
    }
    return result
  }
  if (!existsSync(output)) return { ok: false, message: 'edge-tts reported success but wrote no file.' }
  return { ok: true, output, engine: 'edge-tts', voice }
}

/**
 * True when a file exists, is not empty, and ffprobe accepts it — enough to
 * trust it as finished audio and move on.
 */
async function isPlayable(file) {
  if (!existsSync(file)) return false
  const { statSync } = await import('node:fs')
  if (statSync(file).size < 500) return false
  const probe = await run('ffprobe', ['-v', 'error', file])
  return probe.ok
}

/**
 * Split script into runs of Arabic and runs of Indonesian/Latin text.
 *
 * An Arabic voice reading "mengurbankan" mangles it, and the learner hears a
 * word they cannot match to the recording. Marking the foreign runs lets each
 * one be spoken by a voice that actually knows the language.
 */
export function splitByScript(text) {
  const runs = []
  let current = null
  // Latin letters, digits and the punctuation that holds a Latin phrase
  // together. Anything else — Arabic letters, Arabic punctuation — belongs to
  // the Arabic voice.
  const isLatin = (ch) => /[A-Za-z0-9'’\-]/.test(ch)
  // A space between two Latin words belongs to the Latin run, not to the
  // Arabic one: splitting "jam kosong" into three runs would make the voice
  // change mid-phrase.
  const isNeutral = (ch) => /[\s.,!?;:()"«»]/.test(ch)

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    let script
    if (isLatin(ch)) script = 'latin'
    else if (isNeutral(ch)) {
      // Look ahead for the next real character to decide who owns this space.
      // A trailing period at the very end belongs to whoever was speaking.
      const rest = text.slice(i + 1)
      const next = rest.match(/[A-Za-z0-9\u0600-\u06FF]/)?.[0]
      const prevLatin = current?.script === 'latin'
      const endsHere = !/[A-Za-z0-9\u0600-\u06FF]/.test(rest)
      script = prevLatin && (endsHere || (next && /[A-Za-z0-9]/.test(next))) ? 'latin' : 'other'
    } else script = 'other'

    if (!current || current.script !== script) {
      current = { script, text: ch }
      runs.push(current)
    } else {
      current.text += ch
    }
  }

  // A lone Latin character is almost always noise from a stray symbol; give it
  // back to the Arabic run rather than switching voices for one letter.
  return runs.filter(r => r.script === 'other' || r.text.trim().length > 2)
}

/** Concatenate mp3 parts into one file, with a short pause between each. */
async function joinAudio(parts, output) {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const dir = mkdtempSync(join(tmpdir(), 'vtts-'))
  try {
    const listFile = join(dir, 'list.txt')
    const silence = join(dir, 'pause.mp3')
    // A short pause keeps the switch between voices from sounding clipped.
    const made = await run('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono',
      '-t', '0.15', '-q:a', '9', silence])
    const lines = []
    for (let i = 0; i < parts.length; i++) {
      lines.push(`file '${parts[i].replace(/\\/g, '/').replace(/'/g, "'\\''")}'`)
      if (i < parts.length - 1 && made.ok) lines.push(`file '${silence.replace(/\\/g, '/')}'`)
    }
    writeFileSync(listFile, lines.join('\n'), 'utf8')
    // Re-encode rather than `-c copy`: the concat demuxer only copies cleanly
    // when every part shares exact codec parameters, and a mismatch silently
    // yields a truncated or unplayable file.
    const joined = await run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0',
      '-i', listFile, '-c:a', 'libmp3lame', '-ar', '24000', '-ac', '1',
      '-q:a', '5', output])
    if (!joined.ok) return joined
    return { ok: true, output }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Run a process and resolve with whether it succeeded. */
function run(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let err = ''
    child.stderr.on('data', c => { err += String(c) })
    child.on('error', e => resolve({ ok: false, message: e.message }))
    child.on('close', code => resolve(code === 0
      ? { ok: true }
      : { ok: false, message: `${cmd} exited ${code}: ${err.slice(-200)}` }))
  })
}

/** Give a fragment a closing stop so two parts do not run together. */
export function ensureSentence(text) {
  const t = String(text).trim()
  return /[.!؟?،,;:]$/.test(t) ? t : `${t}.`
}

/**
 * Speak one explanation as two calls instead of one per language switch.
 *
 * The vocabulary list used to be woven into the prose sentence by sentence
 * ("وكلمة X تعني Y"), which alternated languages several times per
 * explanation. Each switch is its own edge-tts request, so a long recording
 * became three hundred calls back to back and the endpoint's burst limit
 * killed the job every time, partway through. Grouping by language keeps the
 * same information — the Arabic voice reads the explanation and the meanings,
 * the target-language voice then pronounces the terms — for two calls instead
 * of thirteen.
 *
 * The meanings are read in the learner's language right after the explanation,
 * in the same order as the terms that follow, so the pairing is recoverable.
 */
export async function speakExplanation({ cut, nativeLanguage, targetLanguage, output, provider }) {
  const words = (cut.words ?? []).filter(w => w.term)
  if (!words.length) {
    return speak({ text: ensureSentence(cut.explanation), language: nativeLanguage, output, provider })
  }

  const meanings = words.filter(w => w.meaning).map(w => w.meaning)
  const arabicText = ensureSentence(cut.explanation) + (meanings.length
    ? ` ومعاني الكلمات بالترتيب: ${meanings.join('، ')}.`
    : '')
  const termsText = words.map(w => w.term).join('، ')

  const main = await speak({ text: arabicText, language: nativeLanguage, output, provider })
  if (!main.ok) return main

  // Pronounce the terms after their meanings, so the learner can match the
  // order. A failure here must not lose the explanation already on disk.
  const termFile = output.replace(/\.mp3$/, '.terms.mp3')
  const termsResult = await speak({ text: termsText, language: targetLanguage, output: termFile })
  if (!termsResult.ok) return main
  if (!existsSync(termFile)) return main

  const joined = await joinAudio([output, termFile], output)
  if (!joined.ok) return main
  try { unlinkSync(termFile) } catch { /* best effort */ }
  return { ok: true, output, engine: 'edge-tts-paired', voice: main.voice }
}

/**
 * Speak a mixed script, giving each language its own voice.
 *
 * Falls back to a single voice when the text is one language throughout, which
 * is the common case and avoids the extra ffmpeg pass entirely.
 */
export async function speakMixed({ text, nativeLanguage, targetLanguage, output, provider }) {
  // A configured provider models the whole script itself, so it can handle the
  // language switch without help.
  if (provider?.baseURL && provider?.apiKey) {
    return speak({ text, language: nativeLanguage, output, provider })
  }

  const runs = splitByScript(text)
  const hasLatin = runs.some(r => r.script === 'latin')
  if (!hasLatin) return speak({ text, language: nativeLanguage, output })

  mkdirSync(dirname(output), { recursive: true })
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const dir = mkdtempSync(join(tmpdir(), 'vtts-'))
  try {
    const nativeVoice = (EDGE_VOICES[nativeLanguage] ?? EDGE_VOICES.ar)[0]
    const targetVoice = (EDGE_VOICES[targetLanguage] ?? EDGE_VOICES.en)[0]
    const parts = []

    for (let i = 0; i < runs.length; i++) {
      const runItem = runs[i]
      if (!runItem.text.trim()) continue
      const isLatin = runItem.script === 'latin'
      const file = join(dir, `part-${i}.mp3`)
      const result = await pythonRetry(['--text', runItem.text.trim(),
        '--voice', isLatin ? targetVoice : nativeVoice, '--out', file])
      if (!result.ok) {
        // A single failed fragment must not lose the whole explanation. Retry
        // it with the native voice, which can at least pronounce the words.
        const retry = await pythonRetry(['--text', runItem.text.trim(),
          '--voice', nativeVoice, '--out', file])
        // A file the socket error arrived after is still usable.
        if (!retry.ok && !await isPlayable(file)) return result
      }
      parts.push(file)
    }

    if (parts.length === 0) {
      return speak({ text, language: nativeLanguage, output })
    }
    if (parts.length === 1) {
      const { copyFileSync } = await import('node:fs')
      copyFileSync(parts[0], output)
      return { ok: true, output, engine: 'edge-tts', voice: nativeVoice }
    }

    const joined = await joinAudio(parts, output)
    if (!joined.ok) return joined
    return { ok: true, output, engine: 'edge-tts-mixed', voice: nativeVoice, targetVoice }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** OpenAI-compatible POST /audio/speech. */
async function speakViaProvider({ text, output, provider }) {
  const { writeFileSync } = await import('node:fs')
  const base = String(provider.baseURL).replace(/\/+$/, '')
  const url = /\/v\d+$/.test(base) ? `${base}/audio/speech` : `${base}/v1/audio/speech`
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${provider.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: provider.model || 'tts-1',
        input: text,
        voice: provider.voice || 'alloy',
      }),
    })
    if (!res.ok) {
      const detail = await res.text()
      return { ok: false, message: `Speech provider HTTP ${res.status}: ${detail.slice(0, 160)}` }
    }
    writeFileSync(output, Buffer.from(await res.arrayBuffer()))
    return { ok: true, output, engine: 'provider' }
  } catch (error) {
    return { ok: false, message: String(error?.message ?? error) }
  }
}

/** List the edge-tts voices, so the UI can offer real choices. */
export async function listVoices() {
  const result = await python(['--list'])
  return result
}
