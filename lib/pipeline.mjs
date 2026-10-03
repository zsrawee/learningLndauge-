/**
 * The whole job, start to finish.
 *
 * Upload -> transcribe -> find hard passages -> speak explanations -> edit audio.
 * The learner waits; nothing here asks them anything.
 *
 * Every completed stage is saved, so a failure at the analysis step does not
 * force the transcription to run again. A retry resumes from the failed stage.
 */
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { transcribe } from './transcribe.mjs'
import {
  buildAnalysisPrompt, buildInterviewPrompt, buildOverviewPrompt, buildTranscriptText,
  briefToSettings, chooseChunkSeconds, chunkSegments, enforceSpacing, FIXED_QUESTIONS,
  gapFor, locateInTranscript, parseAnalysis, parseInterview, parseOverview,
  targetCount, thinByDensity,
} from './analyze.mjs'
import { ensureSentence, speak, speakExplanation, speakMixed } from './speech.mjs'
import { buildEditedAudio } from './edit.mjs'
import { ROOT, getBrief, getSecrets, getSettings } from './store.mjs'
import { chat } from './provider.mjs'
import { readStage, writeStage } from './jobs.mjs'

const WORK = join(ROOT, 'data', 'work')
const OUT = join(ROOT, 'data', 'output')

/**
 * Run one job, resuming from whatever it already has saved.
 *
 * `settings` and `secrets` are overridable so a test or diagnostic harness can
 * point the run at a local provider WITHOUT calling updateSettings/setSecrets —
 * those write to disk, and a test that rewrites the real secrets file destroys
 * the user's API key.
 *
 * @param {object} input
 * @param {string} input.jobId      id whose saved stages are reused
 * @param {string} input.file       uploaded audio path
 * @param {string} input.name       original filename
 * @param {object} [input.settings] override the stored settings for this run only
 * @param {object} [input.secrets]  override the stored secrets for this run only
 * @param {(stage:string, detail?:string)=>void} [input.onProgress]
 */
export async function runPipeline({ jobId, file, name, settings: settingsOverride, secrets: secretsOverride, onProgress }) {
  const settings = settingsOverride ?? getSettings()
  const secrets = secretsOverride ?? getSecrets()
  const workDir = join(WORK, jobId)
  mkdirSync(workDir, { recursive: true })
  mkdirSync(OUT, { recursive: true })

  const say = (stage, detail) => onProgress?.(stage, detail)

  // Reuse the transcript when a previous attempt already produced one.
  let tr = readStage(jobId, 'transcript')
  if (tr?.segments?.length && tr.language === settings.targetLanguage
      && tr.model === settings.transcription.model) {
    say('transcribe', `إعادة استخدام النص المحفوظ — ${tr.segments.length} مقطعاً (لا حاجة لإعادة القراءة)`)
  } else {
    // ---- 1. transcribe locally -------------------------------------------
    say('transcribe', 'Reading the audio on this machine')
    tr = await transcribe({
      file,
      language: settings.targetLanguage,
      model: settings.transcription.model,
      beamSize: settings.transcription.beamSize,
    }, (line) => say('transcribe', line))
    if (!tr.ok) return { ok: false, jobId, message: tr.message, stage: 'transcribe' }
    if (!tr.segments?.length) {
      return { ok: false, jobId, message: 'No speech was recognized in this file.', stage: 'transcribe' }
    }
    // Remember which settings produced this transcript, so a later change to
    // the transcription model correctly invalidates it.
    tr.model = settings.transcription.model
    writeStage(jobId, 'transcript', tr)
    say('transcribe', `Done — ${tr.segments.length} segments, ${tr.duration}s`)
  }

  // ---- 1b. the learner's own instructions -------------------------------
  // What makes a passage hard is not a level label; it is what this learner
  // said they struggle with. The brief is the authority from here on.
  const brief = getBrief()
  const { level, density } = briefToSettings(brief)
  const effective = { ...settings, level, density }

  // In 'ai' mode the model writes questions for THIS recording, reading the
  // learner's two fields plus a sample of what they will hear. Fixed mode
  // reuses the standard set, answered once and prefilled forever after.
  let interview = readStage(jobId, 'interview')
  if (brief.mode === 'ai' && !interview) {
    if (!settings.analysis.provider || !settings.analysis.model) {
      return {
        ok: false, jobId, stage: 'analyze', needsSettings: true,
        message: 'لم تختر موديل التحليل بعد. افتح الإعدادات واختر موديلاً.',
      }
    }
    say('interview', 'Writing questions tailored to this recording')
    const sample = tr.segments.slice(0, 40)
    const result = await chat({
      baseURL: settings.analysis.provider,
      apiKey: secrets.analysisApiKey,
      model: settings.analysis.model,
      messages: [
        { role: 'system', content: buildInterviewPrompt({
          targetLanguage: settings.targetLanguage,
          nativeLanguage: settings.nativeLanguage,
          wants: brief.wants,
          avoid: brief.avoid,
          transcriptSample: buildTranscriptText(sample),
        }) },
        { role: 'user', content: buildTranscriptText(sample) },
      ],
      maxTokens: 1200,
      onProgress: (line) => say('interview', line),
    })
    // A flaky relay must never be the reason someone cannot use the app.
    const questions = (result.ok ? parseInterview(result.text) : null) ?? FIXED_QUESTIONS
    interview = { questions, answers: {}, mode: 'ai' }
    writeStage(jobId, 'interview', interview)
  }

  // The questions shown with the answers, so the profile names what was asked.
  const questions = interview?.questions ?? FIXED_QUESTIONS
  const answered = interview?.answers && Object.keys(interview.answers).length > 0
  if (brief.mode === 'ai' && interview && !answered) {
    // Stop here and hand the questions to the learner. The job resumes from the
    // saved transcript once they answer, so this pause costs no re-reading.
    return { ok: true, needAnswers: true, jobId, name, questions, mode: 'ai' }
  }
  const profileAnswers = interview?.answers ?? brief.answers

  // ---- 2. find the hard passages ---------------------------------------
  let cuts = readStage(jobId, 'analysis')?.cuts
  if (cuts?.length) {
    say('analyze', `إعادة استخدام التحليل المحفوظ — ${cuts.length} شرحاً`)
  } else {
    say('analyze', 'Finding the passages you would not understand')
    if (!settings.analysis.provider || !settings.analysis.model) {
      return {
        ok: false, jobId, stage: 'analyze', needsSettings: true,
        message: 'لم تختر موديل التحليل بعد. افتح الإعدادات واختر موديلاً.',
      }
    }
    // Ask one chunk at a time. A provider's output ceiling is unknown and often
    // small — a prepaid key may only afford a couple of thousand tokens — so a
    // single giant request for a long recording gets truncated and the answer is
    // lost. Start from a safe size and shrink further if the provider says so.
    // Assume a comfortable reply until the provider tells us otherwise.
    let budgetTokens = 4000
    let chunkSeconds = chooseChunkSeconds({
      density: effective.density, level: effective.level, budgetTokens,
    })
    let chunks = chunkSegments(tr.segments, chunkSeconds)
    const wanted = targetCount(tr.duration, effective.density, effective.level)
    say('analyze', chunks.length === 1
      ? `Reading the transcript — looking for about ${wanted} passages`
      : `Reading the transcript in ${chunks.length} parts — looking for about ${wanted} passages`)

    const allItems = []
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]

      // Ask for one part, retrying with a smaller slice when the model returns
      // far fewer passages than that stretch has room for. This is what fills
      // the long silences a single pass leaves behind.
      const found = await analyzeRange({
        segments: chunk,
        settings: effective, secrets, say,
        partIndex: i + 1,
        partTotal: chunks.length,
        jobId,
        name,
        fullSegments: tr.segments,
        fullDuration: tr.duration,
        brief: { ...brief, answers: profileAnswers },
        questions,
      })
      if (found.error) {
        // A relay that refused a large request sometimes accepts a smaller one.
        // Try once more asking for less before giving up on the whole job.
        if (found.retryWithFewer && allItems.length === 0 && chunk === chunks[0]) {
          say('analyze', 'المزود رفض الطلب كاملاً — إعادة المحاولة بعدد أقل')
          const lighter = await analyzeRange({
            segments: chunk, settings: effective, secrets, say,
            partIndex: i + 1, partTotal: chunks.length,
            jobId, name,
            fullSegments: tr.segments, fullDuration: tr.duration,
            askForOverride: 2,
            brief: { ...brief, answers: profileAnswers },
            questions,
          })
          if (!lighter.error) {
            allItems.push(...lighter.items)
            say('analyze', `الجزء ${i + 1}: ${lighter.items.length} تدخلاً — المجموع ${allItems.length}`)
            continue
          }
        }
        if (allItems.length === 0) return { ...found.error, jobId }
        // Keep whatever earlier parts produced rather than losing the job.
        onProgress?.('analyze', found.error.message)
        continue
      }
      // The provider may cap the reply to what the account can afford, which can
      // be far less than we assumed. Once that is known, size the remaining
      // requests to fit, so each answer comes back complete instead of cut off.
      if (found.budget && found.budget < budgetTokens) {
        budgetTokens = found.budget
        const smaller = chooseChunkSeconds({
          density: effective.density, level: effective.level, budgetTokens,
        })
        if (smaller < chunkSeconds) {
          say('analyze', `المزود يسمح بـ ${budgetTokens} رمزاً — تقسيم أنعم (${smaller}ث للجزء)`)
          chunkSeconds = smaller
          chunks = chunkSegments(tr.segments, chunkSeconds)
        }
      }

      allItems.push(...found.items)
      say('analyze', `الجزء ${i + 1}: ${found.items.length} تدخلاً — المجموع ${allItems.length}`)

      // Save after every part, so a failure later does not lose earlier work.
      const partial = thinByDensity(locateInTranscript(allItems, tr.segments), {
        density: effective.density, level: effective.level, duration: tr.duration,
      })
      if (partial.length > 0) writeStage(jobId, 'analysis', { cuts: partial, name, partial: true })
    }

    const located = locateInTranscript(allItems, tr.segments)
    cuts = thinByDensity(located, {
      density: effective.density,
      level: effective.level,
      duration: tr.duration,
    })

    // thinByDensity caps the total, but it ranks by explanation length, so a
    // long explanation early in the recording can crowd out everything later.
    // Enforce the spacing the user actually asked for.
    cuts = enforceSpacing(cuts, gapFor(effective.density, effective.level), tr.duration)
    if (cuts.length === 0) {
      return {
        ok: false, jobId, stage: 'analyze', retryable: true,
        message: 'لم يُحدَّد أي مقطع صعب. جرّب موديلاً آخر أو مستوى أعلى.',
      }
    }
    writeStage(jobId, 'analysis', { cuts, name })

    // Report under-delivery honestly instead of silently producing a nearly
    // untouched recording.
    say('analyze', cuts.length < wanted / 2
      ? `Found ${cuts.length} passages to explain — less than the ${wanted} asked for`
      : `Found ${cuts.length} passages to explain`)
  }

  // ---- 2b. introduce the whole recording once --------------------------
  // The learner should not be dropped into a conversation already in progress
  // without ever learning its subject. This is spoken before anything else.
  let overview = readStage(jobId, 'analysis')?.overview ?? ''
  if (!overview && settings.overview !== false) {
    say('analyze', 'Writing an introduction to the recording')
    const result = await chat({
      baseURL: settings.analysis.provider,
      apiKey: secrets.analysisApiKey,
      model: settings.analysis.model,
      messages: [
        { role: 'system', content: buildOverviewPrompt({
          targetLanguage: settings.targetLanguage,
          nativeLanguage: settings.nativeLanguage,
          level: effective.level,
          brief: { ...brief, answers: profileAnswers },
          questions,
        }) },
        { role: 'user', content: buildTranscriptText(tr.segments) },
      ],
      maxTokens: 1200,
      onProgress: (line) => say('analyze', line),
    })
    if (result.ok) overview = parseOverview(result.text)
    // An introduction is a bonus: never fail the job over it.
    if (!overview) say('analyze', 'تعذّر توليد المقدمة — سيكمل بدونها')
  }
  if (overview && cuts.length > 0 && !cuts.some(c => c.intro)) {
    // The intro is stored with the cuts, so a retry already has it. Adding it
    // again would grow the list by one on every resume, and shift every
    // saved speech clip by one so the intro would be read with the first
    // explanation's voice. Only a list that has never had one gets it.
    const introFile = join(workDir, 'speech-intro.mp3')
    const result = await speakMixed({
      text: overview,
      nativeLanguage: settings.nativeLanguage,
      targetLanguage: settings.targetLanguage,
      output: introFile,
    })
    if (result.ok) {
      cuts = [{ intro: true, audio: introFile, start: 0, end: 0, explanation: overview }, ...cuts]
      writeStage(jobId, 'analysis', { cuts, name, overview })
    } else {
      say('analyze', 'تعذّر تسجيل المقدمة — سيكمل بدونها')
    }
  }
  // Honour the replay preference when building the edit. The introduction has
  // no passage behind it, so replaying it would cut a zero-length slice.
  for (const cut of cuts) {
    if (!cut.intro) cut.replay = settings.replayPassage !== false
  }

  // ---- 3. speak each explanation ---------------------------------------
  const saved = readStage(jobId, 'speech')?.speech ?? {}
  for (let i = 0; i < cuts.length; i++) {
    const cut = cuts[i]
    const out = join(workDir, `speech-${i}.mp3`)

    // Reuse a clip that was already recorded and is still on disk.
    if (saved[i]?.file === out && existsSync(out)) {
      say('speak', `إعادة استخدام الشرح ${i + 1} من ${cuts.length}`)
      cut.audio = out
      continue
    }

    say('speak', `Recording explanation ${i + 1} of ${cuts.length}`)
    // The script mixes Arabic prose with Indonesian terms. One Arabic voice
    // would mangle every term, so the terms are spoken by a voice that knows
    // the language — grouped into one call each rather than alternating per
    // word, which would be a burst of requests edge-tts refuses to serve.
    const result = await speakExplanation({
      cut,
      nativeLanguage: settings.nativeLanguage,
      targetLanguage: settings.targetLanguage,
      output: out,
      provider: settings.speechEngine === 'provider' && secrets.speechApiKey
        ? { ...settings.speech, apiKey: secrets.speechApiKey }
        : undefined,
    })
    if (!result.ok) {
      return { ok: false, jobId, stage: 'speak', retryable: true, message: result.message }
    }
    cut.audio = out
    saved[i] = { file: out }
    writeStage(jobId, 'speech', { speech: saved, count: cuts.length })
  }

  // ---- 4. edit the audio ------------------------------------------------
  say('edit', 'Cutting and splicing the audio')
  const outputName = `${name.replace(/\.[^.]+$/, '')}-tutor.mp3`
  const outputPath = join(OUT, `${jobId}.mp3`)
  const rendered = await buildEditedAudio({
    source: file,
    workDir,
    output: outputPath,
    cuts,
    onProgress: (msg) => say('edit', msg),
  })
  if (!rendered.ok) {
    return { ok: false, jobId, stage: 'edit', retryable: true, message: rendered.message }
  }

  writeStage(jobId, 'output', {
    name,
    outputId: jobId,
    downloadName: outputName,
    duration: rendered.duration,
  })

  say('done', 'Ready to download')
  return {
    ok: true,
    id: jobId,
    jobId,
    downloadName: outputName,
    outputPath,
    duration: rendered.duration,
    originalDuration: tr.duration,
    language: tr.language,
    cuts: cuts.filter(c => !c.intro).length,
    segments: tr.segments.length,
    transcripts: tr.segments,
    items: cuts.map(c => ({
      start: c.start,
      end: c.end,
      reason: c.reason,
      words: c.words,
      explanation: c.explanation,
      // The introduction covers no passage, so it carries no segments to quote.
      quote: Array.isArray(c.segments) ? c.segments.join(' ') : '',
      intro: c.intro === true,
    })),
  }
}

/**
 * Analyse one stretch of transcript, retrying with smaller slices when the
 * model returns too few passages for it.
 *
 * A single request over several minutes sometimes yields almost nothing, which
 * shows up later as a long unexplained silence in the finished audio. Halving
 * the slice and asking again recovers those stretches, and a slice that still
 * under-delivers is accepted rather than retried forever.
 */
async function analyzeRange({
  segments, settings, secrets, say, partIndex, partTotal, depth = 0, askForOverride,
  brief, questions,
}) {
  const start = segments[0].start
  const end = segments[segments.length - 1].end
  const duration = Math.max(1, end - start)
  const wanted = targetCount(duration, settings.density, settings.level)

  // Ask for the passages this stretch has room for, but never for more than one
  // reply can comfortably hold — an over-large ask is what gets truncated.
  // askForOverride is the last resort after a relay refused the full request.
  const askFor = askForOverride ?? Math.min(wanted, Math.max(3, Math.floor(2600 / 260)))
  const reply = await chat({
    baseURL: settings.analysis.provider,
    apiKey: secrets.analysisApiKey,
    model: settings.analysis.model,
    messages: [
      { role: 'system', content: buildAnalysisPrompt({
        targetLanguage: settings.targetLanguage,
        nativeLanguage: settings.nativeLanguage,
        level: settings.level,
        density: settings.density,
        duration,
        part: partTotal > 1 ? { index: partIndex, total: partTotal } : undefined,
        askFor,
        brief,
        questions,
      }) },
      { role: 'user', content: buildTranscriptText(segments) },
    ],
    maxTokens: Math.min(8000, 900 + askFor * 300),
    onProgress: (line) => say('analyze', line),
  })

  if (!reply.ok) {
    // chat() already turned this into actionable Arabic, so pass it through
    // rather than wrapping it in another layer of failure text.
    const busy = /مزدحم/.test(reply.message)
    const auth = /المفتاح غير صحيح|الرصيد لا يكفي|رصيداً مدفوعاً/.test(reply.message)
    return {
      items: [],
      error: {
        ok: false, stage: 'analyze', retryable: true, needsSettings: auth,
        message: busy ? 'مزود الموديل مزدحم حالياً. جرّب بعد قليل، أو اختر موديلاً آخر.' : reply.message,
      },
      // A relay that rejects a large request sometimes accepts a smaller one,
      // so offer the caller a reduced target rather than nothing at all.
      retryWithFewer: !auth && askFor > 2,
    }
  }

  const parsed = parseAnalysis(reply.text)
  if (!parsed) {
    // One unreadable slice should not discard the rest.
    if (depth >= 1 || segments.length < 6) {
      return { items: [], error: { ok: false, stage: 'analyze', retryable: true,
        message: 'لم يُرجع الموديل صيغة JSON المتوقعة. جرّب موديلاً آخر ثم «أعد المحاولة».' } }
    }
    const half = Math.ceil(segments.length / 2)
    const left = await analyzeRange({ segments: segments.slice(0, half), settings, secrets, say,
      partIndex, partTotal, depth: depth + 1, brief, questions })
    const right = await analyzeRange({ segments: segments.slice(half), settings, secrets, say,
      partIndex, partTotal, depth: depth + 1, brief, questions })
    return { items: [...left.items, ...right.items], error: left.error ?? right.error, budget: left.budget ?? right.budget }
  }

  // Enough passages for this stretch, or nothing more we can do with it.
  if (parsed.items.length >= Math.max(1, wanted / 2) || depth >= 1 || segments.length < 8) {
    return { items: parsed.items, budget: reply.budget }
  }

  // Under-delivered: split and ask again, so a sparse answer cannot leave a
  // multi-minute silence in the finished audio.
  say('analyze', `الجزء ${partIndex}: ${parsed.items.length} فقط من ${wanted} — تقسيمه لدقة أعلى`)
  const half = Math.ceil(segments.length / 2)
  const left = await analyzeRange({ segments: segments.slice(0, half), settings, secrets, say,
    partIndex, partTotal, depth: depth + 1, brief, questions })
  const right = await analyzeRange({ segments: segments.slice(half), settings, secrets, say,
    partIndex, partTotal, depth: depth + 1, brief, questions })

  const combined = [...left.items, ...right.items]
  // Prefer the retry only when it genuinely found more.
  return { items: combined.length > parsed.items.length ? combined : parsed.items, budget: reply.budget }
}

/**
 * Turn one analysis item into what the voice should actually say.
 *
 * The explanation carries the meaning; the vocabulary is woven in after it as
 * speech rather than as a `term: meaning` list, because a colon-separated list
 * read aloud sounds like a dictionary being recited and gives the listener no
 * sense of the conversation.
 */
function buildSpokenScript(cut, settings) {
  const parts = []
  if (cut.explanation) parts.push(ensureSentence(cut.explanation))
  for (const w of cut.words ?? []) {
    if (!w.term) continue
    parts.push(w.meaning
      ? `وكلمة ${w.term} تعني ${w.meaning}.`
      : `وكلمة ${w.term} مفتاح في هذا المقطع.`)
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim()
}
