/**
 * Settings and config. Kept deliberately small: the learner should not have to
 * configure anything, so every field has a working default.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const DATA = join(ROOT, 'data')
const SETTINGS_FILE = join(DATA, 'settings.json')
const SECRETS_FILE = join(DATA, 'secrets.json')
export const BRIEF_FILE = join(DATA, 'brief.json')

export const DEFAULTS = {
  /** Language being learned. */
  targetLanguage: 'id',
  /** Language the explanations are written and spoken in. */
  nativeLanguage: 'ar',
  /** Learner level — the user said "assume intermediate". */
  level: 'intermediate',
  /** How often to interrupt. */
  density: 'normal',
  /** Spoken explanation engine: 'free' (edge-tts) or 'provider'. */
  speechEngine: 'free',
  /** Voice for the free engine; empty means pick by language. */
  voice: '',
  /** Replay the hard passage after explaining it. */
  replayPassage: true,
  transcription: {
    /**
     * faster-whisper model size: tiny | base | small | medium | large-v3
     *
     * Measured on this machine (i5-3470) against clear natural speech:
     *   base  beam=1   4.5s   30/30 key words
     *   base  beam=5   9.2s   30/30
     *   small beam=1  25.4s   30/30
     * `base` matches `small` on accuracy at a fraction of the time, so it is
     * the default. Raise it only for noisy or heavily accented audio.
     */
    model: 'base',
    /** Beam width; 1 is several times faster with no observed loss here. */
    beamSize: 1,
    cacheDir: join(ROOT, '.models'),
  },
  /** Text model used to find the hard passages. */
  analysis: {
    provider: '',
    model: '',
  },
  /** Optional paid speech endpoint. */
  speech: {
    baseURL: '',
    model: 'tts-1',
    voice: 'alloy',
  },
}

function ensure() { mkdirSync(DATA, { recursive: true }) }

function readJson(file, fallback) {
  try {
    if (!existsSync(file)) return fallback
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : fallback
  } catch { return fallback }
}

function merge(base, patch) {
  const out = structuredClone(base)
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = { ...out[k], ...v }
    } else if (v !== undefined) {
      out[k] = v
    }
  }
  return out
}

let settings = merge(DEFAULTS, readJson(SETTINGS_FILE, {}))
let secrets = readJson(SECRETS_FILE, { analysisApiKey: '', speechApiKey: '' })

export function getSettings() { return structuredClone(settings) }

export function updateSettings(patch) {
  settings = merge(settings, patch)
  ensure()
  writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8')
  return getSettings()
}

/** Keys are never returned to the browser; only whether one is set. */
export function getSecretsState() {
  return {
    analysisApiKey: secrets.analysisApiKey ? 'set' : 'unset',
    speechApiKey: secrets.speechApiKey ? 'set' : 'unset',
  }
}

export function getSecrets() { return { ...secrets } }

/**
 * Save keys. This writes to disk, so it is only for the settings screen where
 * a human typed the value.
 *
 * Refuse a write that would replace a real key with an obvious placeholder: a
 * diagnostic run once called this with "stub-key" and silently destroyed the
 * user's only OpenRouter key, which had no backup anywhere.
 */
const PLACEHOLDERS = new Set(['stub-key', 'test', 'test-key', 'dummy', 'fake', 'x', 'changeme'])

export function setSecrets(patch) {
  for (const field of ['analysisApiKey', 'speechApiKey']) {
    if (!(field in patch)) continue
    const next = String(patch[field] ?? '').trim()
    const current = String(secrets[field] ?? '').trim()
    if (current && next && PLACEHOLDERS.has(next.toLowerCase())) {
      return {
        ...getSecretsState(),
        refused: `${field} كان مضبوطاً على مفتاح حقيقي، ولن يُستبدل بقيمة وهمية «${next}».`,
      }
    }
  }
  secrets = { ...secrets, ...patch }
  ensure()
  writeFileSync(SECRETS_FILE, JSON.stringify(secrets, null, 2), 'utf8')
  return getSecretsState()
}

/**
 * Keep one previous copy of the keys, so an accidental overwrite is
 * recoverable instead of permanent.
 */
export function backupSecrets() {
  try {
    if (!existsSync(SECRETS_FILE)) return null
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const target = `${SECRETS_FILE}.${stamp}.bak`
    writeFileSync(target, readFileSync(SECRETS_FILE, 'utf8'), 'utf8')
    return target
  } catch { return null }
}

export const paths = { DATA, SETTINGS_FILE, SECRETS_FILE, BRIEF_FILE }

/* ------------------------------------------------------------------ brief */

/**
 * The learner's own instructions to the tutor, plus their answers to the
 * intake questions.
 *
 * This replaced the level/density picks: instead of the model guessing how
 * hard a passage is for an abstract "beginner", the learner says in their own
 * words what they want, what they never want, and how much they understand.
 *
 * Read from disk on every call rather than cached at startup. The user edits
 * this from the browser between jobs, and a cached copy would silently serve
 * the stale version until a restart — exactly the trap the settings cache has.
 */
export function getBrief() {
  const b = readJson(BRIEF_FILE, null)
  if (!b || typeof b !== 'object') return blankBrief()
  return {
    wants: String(b.wants ?? '').trim(),
    avoid: String(b.avoid ?? '').trim(),
    mode: b.mode === 'ai' ? 'ai' : 'fixed',
    answers: b.answers && typeof b.answers === 'object' ? b.answers : {},
  }
}

export function saveBrief(patch) {
  const next = { ...getBrief(), ...(patch ?? {}) }
  ensure()
  writeFileSync(BRIEF_FILE, JSON.stringify(next, null, 2), 'utf8')
  return next
}

function blankBrief() {
  return { wants: '', avoid: '', mode: 'fixed', answers: {} }
}
