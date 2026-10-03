/**
 * The tutor's brain: read the transcript and decide where a learner would get lost.
 *
 * The learner's own brief drives this now. Difficulty is not guessed from a
 * level dropdown: the learner says what they want, what they never want, and
 * answers a few precise questions once. Those answers are saved and reused,
 * so the learner pays for them a single time.
 */

const LEVEL_GUIDE = {
  beginner: 'The learner is a beginner. Interrupt often; explain basic words, common verbs, and simple grammar.',
  intermediate: 'The learner is intermediate. Skip everyday vocabulary; focus on idioms, slang, idioms, and dense or fast passages.',
  advanced: 'The learner is advanced. Interrupt rarely; only for rare vocabulary, cultural references, and complex constructions.',
}

/**
 * The questions every new learner answers once.
 *
 * `id` is stable forever, so a saved answer keeps matching its question across
 * versions. `type` is 'choice' (one answer), 'choices' (any number), or
 * 'text' (their own words).
 */
export const FIXED_QUESTIONS = [
  {
    id: 'goal', type: 'text',
    text: 'ما الذي تريد أن تخرج به من هذه المقاطع؟',
    placeholder: 'مثلاً: أفهم المحادثات اليومية، أو أستعد لسفر، أو أطور نطقي',
  },
  {
    id: 'hard', type: 'choices',
    text: 'ما الذي يصعب عليك أكثر من غيره؟ (اختر كل ما ينطبق)',
    options: ['الكلمات الجديدة', 'الجمل الطويلة والمعقدة', 'سرعة الكلام', 'اللهجة العامية', 'القواعد'],
  },
  {
    id: 'style', type: 'choice',
    text: 'كيف تريد أن يشرح لك المعلم؟',
    options: [
      'مفصّل وبسيط، حتى لو طال الشرح',
      'فكرة عامة مع الكلمات المهمة فقط',
      'تلميحات قصيرة جداً، أكتشف بنفسي',
    ],
  },
  {
    id: 'pace', type: 'choice',
    text: 'كل كم ثانية تقريباً تريد من المعلم أن يقاطعك؟',
    options: ['كل 15 إلى 20 ثانية', 'كل 30 ثانية', 'كل دقيقة', 'فقط عند الجمل الصعبة جداً'],
  },
  {
    id: 'level', type: 'choice',
    text: 'كم تفهم من الحديث الذي تسمعه في هذه اللغة؟',
    options: [
      'مبتدئ — أفهم كلمات متفرقة فقط',
      'متوسط — أفهم الجمل البسيطة والروتينية',
      'متقدم — أتابع أغلب الحوار',
    ],
  },
]

/**
 * Turn the learner's answers into the level/density pair the spacing math
 * already understands.
 *
 * The learner never sees the words "beginner" or "heavy" as a setting; they
 * describe themselves in plain language and this maps it. Anything unanswered
 * falls back to a patient mid-level default, so a partial brief still runs.
 */
export function briefToSettings(brief) {
  const answers = brief?.answers ?? {}
  const picked = []
  for (const q of FIXED_QUESTIONS) {
    const v = answers[q.id]
    if (Array.isArray(v)) picked.push(...v.map(x => String(x ?? '')))
    else if (v) picked.push(String(v))
  }
  const has = (s) => picked.some(a => a.includes(s))

  let level = 'intermediate'
  if (has('مبتدئ')) level = 'beginner'
  else if (has('متقدم')) level = 'advanced'

  let density = 'heavy'
  if (has('كل 30 ثانية')) density = 'normal'
  else if (has('كل دقيقة') || has('فقط عند')) density = 'light'

  return { level, density }
}

/**
 * Render the brief as an Arabic profile the model teaches to.
 *
 * The learner's own words are quoted verbatim — they are the authority on the
 * learner, and paraphrasing them would silently drop the detail the user
 * typed. Unanswered questions are omitted rather than shown as blanks.
 */
export function profileText(brief, questions = FIXED_QUESTIONS) {
  if (!brief) return ''
  const lines = []
  if (brief.wants) lines.push(`ما طلبه المتعلم منك صراحةً: «${brief.wants}»`)
  if (brief.avoid) lines.push(`ما نهاك عنه المتعلم تماماً: «${brief.avoid}»`)

  const answered = []
  for (const q of questions) {
    const v = brief.answers?.[q.id]
    if (!v || (Array.isArray(v) ? v.length === 0 : !String(v).trim())) continue
    const display = Array.isArray(v) ? v.join('، ') : String(v)
    answered.push(`س: ${q.text}\nج: ${display}`)
  }
  if (answered.length) {
    lines.push(`وإجاباته عن أسئلة القياس كانت كالتالي:\n${answered.join('\n')}`)
  }
  return lines.join('\n')
}

/**
 * Ask the model to write intake questions for THIS recording.
 *
 * The fixed set covers a learner generally, but it cannot notice that this
 * clip is a cooking demonstration full of measurements, or a news bulletin
 * full of place names. Letting the model read the learner's two fields plus a
 * sample of the transcript lets it ask what actually matters here — which is
 * the precision the learner asked for.
 *
 * Only a sample goes in: this is one request per recording, and a full
 * transcript is a large call to a relay that is already intermittent.
 */
export function buildInterviewPrompt({ targetLanguage, nativeLanguage, wants, avoid, transcriptSample }) {
  return `You are about to prepare listening material for someone learning ${targetLanguage}.
Their native language is ${nativeLanguage}.

You are given what the learner asked for, what they refuse, and a sample of
the transcript of the recording they will listen to.

Write the 4-6 questions whose answers would most change how you teach THIS
recording. Ask about what this clip specifically demands: if it is full of
numbers, ask whether those lose them; if two speakers interrupt each other,
ask whether overlapping voices lose the thread. Do not ask generic study
questions the transcript cannot affect.

Every question must be in ${nativeLanguage}, short and concrete, with 2-4
answer options. At most one question may be open (no options) for the
learner's own words. Never ask for a name, age, or anything personal.

Return STRICT JSON only:
{
  "questions": [
    { "id": "q1", "type": "choice", "text": "السؤال بالعربية", "options": ["خيار", "خيار"] },
    { "id": "q2", "type": "text", "text": "سؤال مفتوح" }
  ]
}

Output JSON only, no markdown fences, no commentary.`
}

/**
 * Recover questions from a model reply, tolerating prose or code fences.
 *
 * Returns null when nothing usable came back. The caller then falls back to
 * the fixed set rather than blocking the learner — a flaky relay must never
 * be the reason someone cannot use the app.
 */
export function parseInterview(raw) {
  if (typeof raw !== 'string') return null
  let text = raw.trim()
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) text = fence[1].trim()

  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first < 0 || last <= first) return null
  let parsed
  try { parsed = JSON.parse(text.slice(first, last + 1)) } catch { return null }

  const list = Array.isArray(parsed.questions) ? parsed.questions : Array.isArray(parsed) ? parsed : []
  const clean = list.map((q, i) => {
    if (!q || typeof q !== 'object') return null
    const t = String(q.text ?? q.question ?? '').trim()
    if (!t) return null
    const options = Array.isArray(q.options) ? q.options.map(o => String(o).trim()).filter(Boolean) : []
    const type = q.type === 'choices' ? 'choices'
      : (q.type === 'text' || options.length < 2) ? 'text' : 'choice'
    return { id: String(q.id ?? `q${i + 1}`), type, text: t, options: type === 'text' ? [] : options.slice(0, 4) }
  }).filter(Boolean)

  return clean.length > 0 ? clean : null
}

/**
 * How many interruptions to aim for, expressed as seconds of audio between them.
 *
 * These are offered to the user as plain "every N seconds" choices, and the
 * same number is used both to instruct the model and to cap its answer.
 */
export const DENSITY = {
  light: { beginner: 45, intermediate: 60, advanced: 90 },
  normal: { beginner: 20, intermediate: 30, advanced: 45 },
  heavy: { beginner: 15, intermediate: 20, advanced: 25 },
}

/** The spacing, in seconds, that a density/level combination aims for. */
export function gapFor(density, level) {
  return DENSITY[density]?.[level] ?? DENSITY.normal.intermediate
}

/**
 * How many interruptions a clip of this length should get.
 *
 * This is the number of `gap`-second slots the recording actually holds, so it
 * agrees with what `enforceSpacing` can keep. Rounding up here would promise
 * the learner more interruptions than the grid has room for, and the count
 * would silently come in under target on every job.
 */
export function targetCount(duration, density, level) {
  const gap = gapFor(density, level)
  return Math.max(1, Math.floor((Number(duration) || 0) / gap))
}

/**
 * Choose how many seconds of transcript to send per request.
 *
 * One request has to produce roughly one explanation per `gap` seconds, and
 * each explanation costs a few hundred tokens of answer. A prepaid account can
 * be capped at a couple of thousand tokens, in which case asking for a
 * three-minute stretch in one go guarantees a truncated reply. Sizing the slice
 * to the budget keeps every answer complete.
 */
export function chooseChunkSeconds({ density, level, budgetTokens = 4000 }) {
  const gap = gapFor(density, level)
  // ~260 tokens of JSON per explanation, plus the prompt overhead.
  const affordable = Math.max(1, Math.floor((budgetTokens - 800) / 260))
  const seconds = affordable * gap
  // Stay within the range the model handles reliably.
  return Math.max(gap * 2, Math.min(180, seconds))
}

/**
 * Split a transcript into chunks small enough that one model reply can hold
 * every passage found in it.
 *
 * Providers impose their own output ceilings, and a long recording can need
 * far more JSON than one reply allows. Asking per chunk keeps each answer
 * comfortably inside any reasonable limit.
 */
export function chunkSegments(segments, chunkSeconds = 180) {
  const chunks = []
  let current = []
  let startAt = segments[0]?.start ?? 0

  for (const seg of segments) {
    if (current.length > 0 && seg.start - startAt >= chunkSeconds) {
      chunks.push(current)
      current = []
      startAt = seg.start
    }
    current.push(seg)
  }
  if (current.length > 0) chunks.push(current)

  // A trailing crumb is not worth a separate request; fold it into the previous
  // chunk so the model sees it in context.
  if (chunks.length > 1 && chunks[chunks.length - 1].length < 3) {
    const tail = chunks.pop()
    chunks[chunks.length - 1] = chunks[chunks.length - 1].concat(tail)
  }
  return chunks
}

/**
 * Build the prompt that asks the model to pick out hard sentences.
 *
 * The learner's own description is the primary input now: it says what they
 * find hard, what they want from the tutor, and what they refuse to hear. The
 * derived `level` remains as a fallback so an unanswered brief still reads
 * sensibly instead of producing an empty prompt.
 */
export function buildAnalysisPrompt({ targetLanguage, nativeLanguage, level, density, duration, part, askFor, brief, questions }) {
  const gap = gapFor(density, level)
  // Tell the model the number explicitly. Left implicit it returns one or two
  // items no matter how long the audio is. `askFor` is set when the caller knows
  // the reply budget is small and must not over-ask.
  const natural = targetCount(duration ?? 0, density, level)
  const wanted = Math.max(1, Math.min(natural, askFor ?? natural))
  // A single answer is acceptable when only one was asked for; otherwise insist
  // on most of them, since an under-delivering reply leaves a silent stretch.
  const minimum = wanted <= 2 ? wanted : Math.max(1, wanted - 1)
  const hasDuration = Number.isFinite(duration) && duration > 0
  const budget = hasDuration
    ? `This part of the recording covers about ${Math.round(duration / 60)} minutes. Return exactly ${wanted}
passages. Fewer than ${minimum} is not acceptable; the learner needs steady support.
Distribute them across the WHOLE part you receive, including its last third.`
    : `Return ${wanted} passages.`

  const partNote = part
    ? `\nNOTE: you are seeing PART ${part.index} of ${part.total}. Other parts are handled
separately, so judge only what you see here. Do not skip passages because they
seem to continue elsewhere.\n`
    : ''

  // The learner's own words are the authority. When nothing is answered yet,
  // fall back to the generic guidance so the prompt is never thin.
  const profile = profileText(brief, questions)
  const learnerBlock = profile
    ? `\nTHE LEARNER, IN THEIR OWN WORDS — this is the authority on what is hard
for them. Judge difficulty by it rather than by guessing a level:
${profile}
`
    : `${LEVEL_GUIDE[level] ?? LEVEL_GUIDE.intermediate}\n`

  const difficultyRule = profile
    ? `- Judge what is hard for THIS learner from the profile above. What they
  called hard is what you flag. What they forbade never appears.`
    : `- Flag genuine language difficulty: idioms, colloquialisms, phrasal verbs,
  cultural references, fast or dense constructions, and vocabulary a ${level}
  learner would not know.`

  return `You are preparing listening material for someone learning ${targetLanguage}.

The learner's native language is ${nativeLanguage}.
${learnerBlock}${partNote}
You will receive a numbered transcript with timestamps, produced by automatic
speech recognition. It WILL contain recognition errors: mangled words, wrong
spelling, missing punctuation. This is expected and is NOT your subject.

Your job is to find passages that are hard for this learner of ${targetLanguage},
and to teach them.

HOW MANY TO RETURN
${budget}

SPACING — THIS IS A HARD REQUIREMENT
The learner listens straight through, so explanations must be spread evenly.
- Leave at least ${gap} seconds of audio between one passage and the next.
- Never return two passages whose timestamps are within ${gap} seconds of each
  other. If two candidates are close, keep the more valuable one and drop the other.
- Walk the transcript from beginning to end and pick one passage per stretch of
  about ${gap} seconds. Do not take several from the opening and skip the middle.
- The last part of the transcript deserves as many passages as the first.

Rules:
- Silently correct obvious transcription noise in your head, then judge the
  sentence the speaker actually said.
- NEVER comment on spelling errors, transcription quality, or unclear words.
  The learner does not care that the transcript is imperfect.
${difficultyRule}
- Also flag passages that carry the speaker's main point: a learner who
  misses them loses the thread of the whole recording.
- Explain the MEANING in ${nativeLanguage} — what the speaker is saying and why
  they say it that way. Not what went wrong in the transcript.
- Each passage must quote transcript lines VERBATIM so it can be located.
- Keep each explanation to 2-3 sentences so the answer is not cut short.

WHAT AN EXPLANATION MUST DO — READ THIS CAREFULLY
The learner is following a conversation and cannot see where it is going. A
translation of one difficult word does NOT help them: they still do not know
what is being discussed. Every explanation must answer all three of these:
  1. WHERE THE DISCUSSION IS — what the speakers are talking about at this
     moment, and how it connects to what came before.
  2. WHAT IS BEING SAID HERE — the meaning of this passage in plain
     ${nativeLanguage}, as a full idea rather than a word list.
  3. WHY IT MATTERS — the point the speaker is making, or the turn the
     discussion takes.
Then, and only then, gloss the difficult words.

Write it so someone who heard nothing before this moment could follow along.
A good explanation reads like a narrator saying "now they are talking about X,
and the speaker is arguing Y because Z" — never like a dictionary entry.

Example of what NOT to write:
  "mengurbankan: يضحي. perhatian: الانتباه."
That is a glossary. The learner learns two words and loses the conversation.

Example of what TO write:
  "الآن ينتقل المتحدث إلى فكرة أن التعليم يستهلك وقت الطالب وانتباهه. يقول إنه
  دفع المال وضحّى بوقته، فمن حقّه أن يغضب عندما تُلغى الحصة — كلمة
  mengurbankan هنا تعني «يضحي بـ»."

Note how the second one tells the learner where the argument is AND teaches the
word. The "words" array is a supplement to that, never a replacement.

Return STRICT JSON only:
{
  "items": [
    {
      "segments": ["the exact transcript line you are flagging, verbatim, errors included"],
      "reason": "one short phrase in ${nativeLanguage}: the kind of difficulty",
      "words": [
        { "term": "the word or phrase as the SPEAKER meant it in ${targetLanguage}", "meaning": "its meaning in ${nativeLanguage}" }
      ],
      "explanation": "2-3 sentences in ${nativeLanguage} teaching this passage"
    }
  ]
}

Output JSON only, no markdown fences, no commentary.`
}

/** Render the transcript as numbered, timestamped lines for the model. */
export function buildTranscriptText(segments) {
  return segments.map((s, i) => {
    const mm = String(Math.floor(s.start / 60)).padStart(2, '0')
    const ss = String(Math.floor(s.start % 60)).padStart(2, '0')
    return `[${i}] ${mm}:${ss} ${s.text}`
  }).join('\n')
}

/**
 * Ask for a short spoken introduction to the whole recording.
 *
 * Without this the learner is dropped into a conversation already in progress
 * and never learns its subject. The overview is spoken once, before the audio.
 */
export function buildOverviewPrompt({ targetLanguage, nativeLanguage, level, brief, questions }) {
  const profile = profileText(brief, questions)
  const learnerBlock = profile
    ? `THE LEARNER, IN THEIR OWN WORDS — pitch the introduction to this person:
${profile}`
    : LEVEL_GUIDE[level] ?? LEVEL_GUIDE.intermediate

  return `You are preparing listening material for someone learning ${targetLanguage}.
${learnerBlock}

You will receive the whole transcript of one recording, produced by automatic
speech recognition. It may contain recognition errors — ignore them.

Write a SHORT spoken introduction in ${nativeLanguage} for a learner who is
about to listen to this recording. It must tell them:
  1. What kind of recording this is and what its main subject is.
  2. Who is speaking, if you can tell — one person or a conversation.
  3. The main points or questions the recording works through, in order.
  4. Anything useful to know before starting, such as recurring terms.

Write 4-6 sentences of natural spoken ${nativeLanguage}. It will be read aloud,
so write prose with no headings, no bullet points, no numbering and no markdown.
Do not summarise every detail — give the listener a map, not a transcript.

Return STRICT JSON only:
{ "overview": "the introduction, in ${nativeLanguage}" }

Output JSON only, no markdown fences, no commentary.`
}

/** Tolerant JSON extraction; models sometimes wrap output in prose or fences. */
/**
 * Recover the complete objects from a JSON reply that was cut off.
 *
 * Scans for `{...}` objects that parse on their own, so a response ending
 * mid-sentence still yields everything written before the cut. Returns
 * undefined when nothing usable is found.
 */
function salvageItems(text) {
  const items = []
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]

    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') { inString = true; continue }

    if (ch === '{') {
      if (depth === 0) start = i
      depth++
      continue
    }
    if (ch !== '}') continue

    depth--
    if (depth < 0) { depth = 0; start = -1; continue }
    if (depth > 0 || start < 0) continue

    // A balanced object at the outermost level. The item objects sit one level
    // inside the wrapper, so an object is kept when it looks like an item —
    // whether it is the wrapper (which parses as {items:[...]}) or an item.
    try {
      const obj = JSON.parse(text.slice(start, i + 1))
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        if (Array.isArray(obj.items)) items.push(...obj.items)
        else if (obj.segments || obj.segment || obj.explanation) items.push(obj)
      }
    } catch { /* incomplete or malformed; skip */ }
    start = -1
  }

  // The wrapper usually never closes on a truncated reply, so its items are
  // still open. Fall back to matching item objects nested one level deep.
  if (items.length === 0) {
    let d = 0
    let s = -1
    inString = false
    escaped = false
    for (let i = 0; i < text.length; i++) {
      const ch = text[i]
      if (inString) {
        if (escaped) escaped = false
        else if (ch === '\\') escaped = true
        else if (ch === '"') inString = false
        continue
      }
      if (ch === '"') { inString = true; continue }
      if (ch === '{') { if (d === 1) s = i; d++; continue }
      if (ch === '}') {
        d--
        if (d === 1 && s >= 0) {
          try {
            const obj = JSON.parse(text.slice(s, i + 1))
            if (obj?.segments || obj?.segment || obj?.explanation) items.push(obj)
          } catch { /* skip */ }
          s = -1
        }
        if (d < 0) d = 0
      }
    }
  }

  const real = items.filter(o => o && typeof o === 'object')
  return real.length > 0 ? { items: real } : undefined
}

/**
 * Pull the introduction out of an overview reply.
 *
 * The reply should be `{ "overview": "..." }`, but a model occasionally answers
 * with the prose alone or wraps it under another key, so all three shapes are
 * accepted. Returns an empty string when nothing usable is found.
 */
export function parseOverview(raw) {
  if (typeof raw !== 'string') return ''
  let text = raw.trim()
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) text = fence[1].trim()

  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first >= 0 && last > first) {
    try {
      const parsed = JSON.parse(text.slice(first, last + 1))
      for (const key of ['overview', 'introduction', 'intro', 'summary', 'text']) {
        if (typeof parsed?.[key] === 'string' && parsed[key].trim()) return parsed[key].trim()
      }
    } catch { /* not JSON — fall through to the truncated case */ }
  }

  // A JSON wrapper whose value was cut off before its closing quote — the model
  // ran out of output budget mid-sentence. The prose written so far is still
  // worth speaking, so recover it rather than shipping no introduction.
  const m = /"(?:overview|introduction|intro|summary|text)"\s*:\s*"([\s\S]*)$/.exec(text)
  if (m) {
    const prose = m[1]
      .replace(/\\n/g, ' ')
      .replace(/\\"/g, '"')
      .replace(/"\s*\}?\s*$/, '')
      .trim()
    if (prose.length > 40) return prose
  }

  // Plain prose: keep it only if it actually looks like an introduction rather
  // than a refusal or an echo of the instructions.
  const plain = text.replace(/^```[a-z]*\s*/i, '').replace(/```$/, '').trim()
  if (plain.length > 60 && !/^[\[{]/.test(plain)) return plain
  return ''
}

export function parseAnalysis(raw) {
  if (typeof raw !== 'string') return undefined
  let text = raw.trim()
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) text = fence[1].trim()

  // Trim to the outermost JSON value. Slicing from the first `{` would strip
  // the brackets off a reply that is a bare array of items.
  const objStart = text.indexOf('{')
  const arrStart = text.indexOf('[')
  const useArray = arrStart >= 0 && (objStart < 0 || arrStart < objStart)
  const first = useArray ? arrStart : objStart
  const last = useArray ? text.lastIndexOf(']') : text.lastIndexOf('}')
  if (first >= 0 && last > first) text = text.slice(first, last + 1)

  let parsed
  try { parsed = JSON.parse(text) } catch {
    // The reply was cut off mid-answer — usually because the model spent its
    // budget on hidden reasoning. Every item before the cut is still complete
    // and useful, so recover those instead of discarding the whole response.
    parsed = salvageItems(text)
    if (!parsed) return undefined
  }
  if (!parsed || typeof parsed !== 'object') return undefined

  const items = Array.isArray(parsed.items) ? parsed.items : Array.isArray(parsed) ? parsed : []
  const cleaned = items.map(item => {
    if (!item || typeof item !== 'object') return undefined
    const segs = Array.isArray(item.segments)
      ? item.segments.filter(s => typeof s === 'string' && s.trim()).map(s => s.trim())
      : typeof item.segment === 'string' ? [item.segment.trim()] : []
    if (segs.length === 0) return undefined
    const words = Array.isArray(item.words)
      ? item.words.map(w => {
          if (typeof w === 'string') return { term: w, meaning: '' }
          if (!w || typeof w !== 'object') return undefined
          const term = w.term ?? w.word ?? w.phrase ?? ''
          const meaning = w.meaning ?? w.definition ?? w.translation ?? ''
          if (!term) return undefined
          return { term: String(term), meaning: String(meaning) }
        }).filter(Boolean).slice(0, 10)
      : []
    return {
      segments: segs,
      reason: String(item.reason ?? '').trim(),
      words,
      explanation: String(item.explanation ?? item.summary ?? '').trim(),
    }
  }).filter(Boolean)

  return { items: cleaned }
}

/**
 * Locate flagged transcript text back to timestamps in the original audio.
 *
 * Matching is fuzzy because the model may quote with slightly different
 * punctuation or casing than the transcript carries.
 */
export function locateInTranscript(items, segments) {
  const normalize = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim()

  const located = []
  for (const item of items) {
    let bestStart = null
    let bestEnd = null

    for (const quote of item.segments) {
      const target = normalize(quote)
      if (target.length < 4) continue

      // Exact-ish match against one segment first.
      //
      // `target.includes(t)` is deliberately NOT used: a one-word segment like
      // "Ya." is a substring of almost any quote, so every passage in the
      // recording would resolve to that one segment and the rest would be
      // discarded as overlapping it.
      let hit = segments.find(s => {
        const t = normalize(s.text)
        return t.length >= 4 && (t === target || t.includes(target))
      })

      // Fall back to a token-overlap search across the whole transcript.
      if (!hit) {
        const targetWords = new Set(target.split(' ').filter(w => w.length > 2))
        let best = null
        let bestScore = 0
        for (const s of segments) {
          const words = normalize(s.text).split(' ').filter(w => w.length > 2)
          if (words.length === 0) continue
          const overlap = words.filter(w => targetWords.has(w)).length
          const score = overlap / Math.max(1, Math.min(words.length, targetWords.size))
          if (score > bestScore) { bestScore = score; best = s }
        }
        // A loose match is only worth trusting when it is clearly better than a
        // guess. At a low threshold many different quotes all resolve to the
        // same segment, and the overlap pass then deletes all but one.
        if (best && bestScore >= 0.72) hit = best
      }

      if (hit) {
        bestStart = bestStart === null ? hit.start : Math.min(bestStart, hit.start)
        bestEnd = bestEnd === null ? hit.end : Math.max(bestEnd, hit.end)
      }
    }

    if (bestStart !== null && bestEnd !== null) {
      located.push({ ...item, start: bestStart, end: bestEnd })
    }
  }

  // Order by position and drop overlaps so the cut list stays sane.
  located.sort((a, b) => a.start - b.start)
  const merged = []
  for (const item of located) {
    const last = merged[merged.length - 1]
    if (last && item.start < last.end) {
      // Overlapping interruption: keep the longer explanation, widen the span.
      if ((item.explanation?.length ?? 0) > (last.explanation?.length ?? 0)) {
        merged[merged.length - 1] = { ...item, start: last.start }
      } else {
        last.end = Math.max(last.end, item.end)
      }
      continue
    }
    merged.push({ ...item })
  }
  return merged
}

/** Enforce the requested density: keep the most valuable interruptions only. */
export function thinByDensity(items, { density, level, duration }) {
  const gap = DENSITY[density]?.[level] ?? DENSITY.normal.intermediate
  const maxCount = Math.max(1, Math.floor(duration / gap))
  if (items.length <= maxCount) return items

  // Keep entries with the most explanation value, then restore time order.
  const scored = items
    .map(item => ({ item, score: (item.explanation?.length ?? 0) + (item.words?.length ?? 0) * 40 }))
    .sort((a, b) => b.score - a.score)
    .slice(0, maxCount)
    .map(x => x.item)
  return scored.sort((a, b) => a.start - b.start)
}

/**
 * Spread interruptions evenly instead of letting them bunch up.
 *
 * Each chunk of a long recording is analysed on its own, so chunks can return
 * several passages from their opening seconds and leave the rest untaught.
 * Walking the timeline greedily keeps the first good candidate in each window
 * and drops the rest, which is what "one every N seconds" has to mean.
 */
/**
 * Thin the passages so the learner hears help at a steady rhythm.
 *
 * Chunked analysis usually returns more passages than needed — the model
 * dutifully finds ten per slice — so the job here is to spread them out without
 * gutting the result. Two findings one second apart teach the same thing once;
 * two findings a minute apart are both worth keeping.
 *
 * Selection is greedy in time order: walk the passages and keep one whenever it
 * sits at least `gap` past the last one kept. Within a window of competing
 * candidates the richest one wins, so thinning picks the best, not the first.
 * Nothing is ever removed for being merely close when the recording has room.
 */
export function enforceSpacing(items, gap, duration) {
  if (items.length <= 1 || gap <= 0) return items
  const sorted = [...items].sort((a, b) => a.start - b.start)

  // A passage's value: a real explanation with vocabulary beats a bare quote.
  const value = (x) => (x.explanation?.length ?? 0) + (x.words?.length ?? 0) * 40
  const endOf = (x) => Math.max(x.end ?? x.start, x.start)

  // 1. Resolve overlaps — two passages covering the same seconds teach once.
  const deduped = []
  for (const item of sorted) {
    const prev = deduped[deduped.length - 1]
    if (prev && item.start < endOf(prev)) {
      if (value(item) > value(prev)) deduped[deduped.length - 1] = item
      continue
    }
    deduped.push(item)
  }

  // 2. Lay the recording out as a fixed grid of `gap`-second slots and let each
  //    slot keep its single best passage.
  //
  //    The grid matters. A slot's boundaries are fixed in advance, so a slot
  //    cannot be pushed along by whatever wins inside it: the winner may sit
  //    anywhere in its slot, but the next slot still begins on the grid line.
  //    Anchoring each slot to the previous winner instead would let a run of
  //    replacements drift the whole layout forward, and passages 17s apart
  //    under a 20s gap would collapse from the twenty the recording has room
  //    for down to one per cluster.
  const kept = []
  let slotEnd = -Infinity // exclusive end of the slot being filled
  let best = null // richest passage seen in that slot

  for (const item of deduped) {
    if (item.start >= slotEnd) {
      // The previous slot is closed; settle it and open the next grid line.
      if (best) kept.push(best)
      best = item
      slotEnd = item.start + gap
      continue
    }
    if (!best || value(item) > value(best)) best = item
  }
  if (best) kept.push(best)

  return kept.length > 0 ? kept : deduped
}
