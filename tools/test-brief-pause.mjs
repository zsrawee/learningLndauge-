/**
 * The pause: in AI mode the pipeline must stop after transcription, hand the
 * learner questions written for THIS recording, and resume from the saved
 * transcript once they answer.
 *
 * This is the riskiest new behaviour, because it turns one call into two with a
 * human in between. What must be true:
 *   - the first call returns the questions, not a finished job;
 *   - nothing is analysed before the learner speaks;
 *   - the second call does NOT re-read the audio;
 *   - the answers actually reach the prompt on resume.
 */
import { createServer } from 'node:http'
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { runPipeline } from '../lib/pipeline.mjs'
import { getBrief, saveBrief } from '../lib/store.mjs'
import { JOBS_DIR, readStage, writeStage } from '../lib/jobs.mjs'

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ` :: ${detail}` : ''}`) }
}

const QUOTE = 'Jadi gini cara kerja otak itu adalah mereka hanya akan mengingat sesuatu yang menurut mereka penting,'
const sent = []
let nQuestions = 0

const server = createServer(async (req, res) => {
  let body = ''
  for await (const chunk of req) body += chunk
  const parsed = JSON.parse(body)
  sent.push(parsed)

  const sys = parsed.messages?.[0]?.content ?? ''
  const isInterview = sys.includes('Write the 4-6 questions')
  const isOverview = sys.includes('SHORT spoken introduction')
  const content = isInterview
    ? (++nQuestions, JSON.stringify({
        questions: [
          { id: 'q1', type: 'choice', text: 'هل الأرقام في هذا المقطع تشتتك؟', options: ['نعم', 'لا'] },
          { id: 'q2', type: 'text', text: 'ما أكثر كلمة تتكرر هنا وتجهلها؟' },
        ],
      }))
    : isOverview
      ? JSON.stringify({ overview: 'هذا تسجيل عن عمل الدماغ وكيفية الحفظ.' })
      : JSON.stringify({
          items: [{
            segments: [QUOTE],
            reason: 'جملة طويلة',
            words: [{ term: 'penting', meaning: 'مهم' }],
            explanation: 'الآن يتحدث المتحدث عن كيف يعمل الدماغ: لا يحفظ إلا ما يبدو له مهماً.',
          }],
        })
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({
    id: 'x', object: 'chat.completion', model: 'stub',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
  }))
})

await new Promise(r => server.listen(0, '127.0.0.1', r))
const baseURL = `http://127.0.0.1:${server.address().port}/v1`

console.log('\n=== التوقف والاستئناف في وضع الذكاء ===\n')

const savedBrief = getBrief()
const jobId = 'j' + Date.now().toString(36) + 'paus001'
const jobDir = join(JOBS_DIR, jobId)
mkdirSync(jobDir, { recursive: true })
copyFileSync('data/jobs/jmuph8nk71emtnc/source.bin', join(jobDir, 'source.bin'))
copyFileSync('data/jobs/jmuph8nk71emtnc/transcript.json', join(jobDir, 'transcript.json'))

const settings = {
  targetLanguage: 'id', nativeLanguage: 'ar',
  replayPassage: true, speechEngine: 'free', voice: 'ar-KW-FahedNeural',
  transcription: { model: 'base', beamSize: 1,
    cacheDir: 'D:\\Projects\\anything\\voice-tutor\\.models' },
  analysis: { provider: baseURL, model: 'stub-model' },
}
const secrets = { analysisApiKey: 'stub-key', speechApiKey: '' }

try {
  saveBrief({ wants: 'أركز على الحوار', avoid: 'لا تحلل القواعد', mode: 'ai', answers: {} })

  const first = await runPipeline({
    jobId, file: join(jobDir, 'source.bin'), name: 'probe.mp3',
    settings, secrets, onProgress: () => {},
  })

  check('the first call stops rather than finishing', first.ok === true && first.needAnswers === true,
    JSON.stringify({ ok: first.ok, needAnswers: first.needAnswers, message: first.message }))
  check('the stop hands back questions for this recording',
    Array.isArray(first.questions) && first.questions.length === 2,
    `${first.questions?.length ?? 0} questions`)
  check('the generated questions are in the learner\'s language',
    first.questions?.some(q => /أرقام/.test(q.text)) ?? false)
  check('the interview was saved so a resume finds it',
    Array.isArray(readStage(jobId, 'interview')?.questions))
  check('nothing was analysed before the learner answered',
    !existsSync(join(jobDir, 'analysis.json')))

  // The questions call happened exactly once: the resume must not regenerate.
  check('questions were requested once', nQuestions === 1, `${nQuestions} calls`)

  // Now the learner answers. The server stores these on the job, not the brief.
  writeStage(jobId, 'interview', {
    questions: first.questions,
    answers: { q1: 'نعم', q2: 'الانتباه' },
    mode: 'ai',
  })

  const second = await runPipeline({
    jobId, file: join(jobDir, 'source.bin'), name: 'probe.mp3',
    settings, secrets, onProgress: () => {},
  })

  check('the resume finishes the job', second.ok === true, second.message ?? '')
  check('the resume did not ask for questions again', nQuestions === 1, `${nQuestions} calls`)
  check('the resume produced explanations', (second.items ?? []).length > 0,
    `${second.items?.length ?? 0} items`)

  // The answers the learner gave must appear in the prompt the model received
  // on resume — otherwise the pause was theatre. This must hold on EVERY
  // analysis request, including the split-and-retry ones: they outnumber the
  // first pass on a long recording, so losing the profile there would quietly
  // teach most of the clip to a generic intermediate learner.
  const analysisPrompts = sent
    .filter(m => /hard for this learner/i.test(m.messages?.[0]?.content ?? ''))
    .map(m => m.messages[0].content)
  check('an analysis prompt was sent on resume', analysisPrompts.length > 0,
    `${analysisPrompts.length} prompts`)
  check('every analysis prompt carries the learner profile',
    analysisPrompts.length > 0 && analysisPrompts.every(p => p.includes('IN THEIR OWN WORDS')))
  check('every analysis prompt carries the wants field',
    analysisPrompts.length > 0 && analysisPrompts.every(p => p.includes('أركز على الحوار')))
  check('the learner\'s answer reached every prompt',
    analysisPrompts.length > 0 && analysisPrompts.every(p => p.includes('الانتباه')))
  check('the recording-specific question text reached every prompt',
    analysisPrompts.length > 0 && analysisPrompts.every(p => p.includes('هل الأرقام في هذا المقطع تشتتك؟')))
} finally {
  saveBrief(savedBrief)
  server.close()
  rmSync(jobDir, { recursive: true, force: true })
  const out = join('data', 'output', `${jobId}.mp3`)
  if (existsSync(out)) rmSync(out, { force: true })
}

console.log(`\n=== ${pass} passed, ${fail} failed ===\n`)
process.exit(fail === 0 ? 0 : 1)
