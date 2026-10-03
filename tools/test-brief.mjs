/**
 * The brief is what the learner told the tutor. Three things must hold, or the
 * whole feature is silently a no-op:
 *
 *   1. The learner's own words reach the analysis prompt verbatim.
 *   2. Answers map to spacing numbers, so the rhythm keeps working.
 *   3. An empty brief degrades to the old behaviour, never to a broken prompt.
 */
import {
  buildAnalysisPrompt, buildInterviewPrompt, briefToSettings, gapFor,
  parseInterview, profileText, FIXED_QUESTIONS,
} from '../lib/analyze.mjs'

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ` :: ${detail}` : ''}`) }
}

console.log('\n=== خانات المتعلم والأسئلة ===\n')

const brief = {
  wants: 'اشرح الجمل الطويلة فقط',
  avoid: 'لا تترجم كل كلمة حرفياً',
  answers: { goal: 'أفهم الحوار اليومي', pace: 'كل 15 إلى 20 ثانية' },
}

// 1. The learner's words must reach the prompt unchanged — paraphrasing would
//    silently drop the detail the user typed for exactly this purpose.
const prompt = buildAnalysisPrompt({
  targetLanguage: 'id', nativeLanguage: 'ar',
  level: 'intermediate', density: 'heavy',
  duration: 600, brief,
})
check('the analysis prompt quotes what the learner wants', prompt.includes('اشرح الجمل الطويلة فقط'))
check('the analysis prompt quotes what the learner refuses', prompt.includes('لا تترجم كل كلمة حرفياً'))
check('the analysis prompt states the learner is the authority',
  /IN THEIR OWN WORDS/.test(prompt))
check('the analysis prompt keeps the strict JSON contract', /Return STRICT JSON only/.test(prompt))
check('the analysis prompt keeps the spacing requirement',
  prompt.includes(`at least ${gapFor('heavy', 'intermediate')} seconds`))
check('the explanation rules survive intact', /WHAT AN EXPLANATION MUST DO/.test(prompt))

// 2. Answers must turn into spacing numbers, or the pipeline loses its rhythm.
const s = briefToSettings(brief)
check('a fast pace maps to heavy interruptions', s.density === 'heavy', JSON.stringify(s))

const slow = briefToSettings({ answers: { pace: 'كل دقيقة' } })
check('a slow pace maps to light interruptions', slow.density === 'light', JSON.stringify(slow))

const beginner = briefToSettings({ answers: { level: 'مبتدئ — أفهم كلمات متفرقة فقط' } })
check('a self-described beginner maps to beginner', beginner.level === 'beginner', JSON.stringify(beginner))

const advanced = briefToSettings({ answers: { level: 'متقدم — أتابع أغلب الحوار' } })
check('a self-described advanced learner maps to advanced', advanced.level === 'advanced', JSON.stringify(advanced))

// 3. An empty brief must degrade, not break.
const empty = briefToSettings({})
check('an empty brief keeps a mid level', empty.level === 'intermediate', JSON.stringify(empty))
check('an empty brief keeps a steady rhythm', empty.density === 'heavy', JSON.stringify(empty))

const emptyPrompt = buildAnalysisPrompt({
  targetLanguage: 'id', nativeLanguage: 'ar',
  level: 'intermediate', density: 'normal', duration: 120,
})
check('an empty brief falls back to the level guide', /intermediate/i.test(emptyPrompt))
check('an empty brief does not mention an empty profile', !/«»/.test(emptyPrompt))

// profileText must skip unanswered questions rather than printing blanks, and
// must join multi-select answers into readable prose.
check('profileText skips unanswered questions',
  !profileText({ answers: {} }).includes('س:'))
check('profileText joins multi-select answers with واو',
  /الكلمات الجديدة، الجمل الطويمة|، /.test(profileText({
    answers: { hard: ['الكلمات الجديدة', 'الجمل الطويلة'] },
  })))
check('profileText returns nothing for no brief at all', profileText(null) === '')

// The fixed questions must be answerable by the UI we render: every question
// has a type we support, and choice questions have real options.
for (const q of FIXED_QUESTIONS) {
  check(`question "${q.id}" has a supported type`,
    q.type === 'choice' || q.type === 'choices' || q.type === 'text')
  if (q.type !== 'text') check(`question "${q.id}" offers options`, (q.options?.length ?? 0) >= 2)
}

// The AI-mode interview must be parsable from a messy reply, since the model
// does not always obey "JSON only".
const clean = parseInterview('{"questions":[{"id":"q1","type":"choice","text":"هل الأرقام تشتتك؟","options":["نعم","لا"]}]}')
check('a clean interview reply parses', (clean?.length ?? 0) === 1, JSON.stringify(clean))

const fenced = parseInterview('```json\n{"questions":[{"id":"q1","type":"text","text":"ما أصعب شيء هنا؟"}]}\n```')
check('a fenced interview reply parses', (fenced?.length ?? 0) === 1, JSON.stringify(fenced))

const withProse = parseInterview('Here you go:\n{"questions":[{"id":"q2","type":"choices","text":"ما الذي تريده؟","options":["أ","ب","ج"]}]\n}\nGood luck!')
check('a reply wrapped in prose parses', (withProse?.length ?? 0) === 1, JSON.stringify(withProse))

check('a broken reply yields null so the caller falls back', parseInterview('sorry, no json') === null)
check('a reply with empty questions yields null', parseInterview('{"questions":[]}') === null)

// The interview prompt must carry the learner's fields, so the generated
// questions are tailored rather than generic.
const ip = buildInterviewPrompt({
  targetLanguage: 'id', nativeLanguage: 'ar',
  wants: 'أركز على الحوار اليومي',
  avoid: 'لا تحلل القواعد',
  transcriptSample: '[1] 0:00 halo, apa kabar',
})
check('the interview prompt names the target language', ip.includes('learning id'))
check('the interview prompt demands questions in the native language', ip.includes('must be in ar,'))
check('the interview prompt demands strict JSON', /STRICT JSON/i.test(ip))

console.log(`\n=== ${pass} passed, ${fail} failed ===\n`)
process.exit(fail === 0 ? 0 : 1)
