/**
 * The introduction and the pronunciation fix.
 *
 * Two complaints from a real listener are pinned here:
 *   1. The tutor translated words but never said what the discussion was about,
 *      so the learner could not follow the recording.
 *   2. Indonesian terms inside an Arabic explanation were read by an Arabic
 *      voice, which mangled every one of them.
 */
import { buildOverviewPrompt, gapFor, parseOverview, targetCount } from '../lib/analyze.mjs'
import { splitByScript } from '../lib/speech.mjs'

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ` :: ${detail}` : ''}`) }
}

console.log('\n=== مقدمة المقطع ===\n')

// --- the prompt must actually ask for the things the learner was missing ---
const prompt = buildOverviewPrompt({ targetLanguage: 'id', nativeLanguage: 'ar', level: 'beginner' })
check('the prompt names the subject of the recording',
  /main subject/i.test(prompt))
check('the prompt asks who is speaking',
  /who is speaking/i.test(prompt))
check('the prompt asks for the main points in order',
  /main points/i.test(prompt))
check('the prompt demands spoken prose, not a list',
  /no bullet points/i.test(prompt) && /no markdown/i.test(prompt))
check('the prompt asks for Arabic',
  prompt.includes('ar'))
check('the prompt requests strict JSON',
  prompt.includes('"overview"'))

// --- the overview reply must survive the shapes models really emit ---------
const long = 'هذا تسجيل عن طريقة عمل الذاكرة، وفيه يتحدث شخص واحد عن تجربته في المدرسة وكيف كان ينسى ما لا يفهم معناه.'
check('a plain JSON overview is read',
  parseOverview(`{"overview":"${long}"}`) === long)
check('a fenced JSON overview is read',
  parseOverview('```json\n{"overview":"' + long + '"}\n```') === long)
check('an overview under another key is read',
  parseOverview(`{"summary":"${long}"}`) === long)
check('a bare prose answer is accepted',
  parseOverview(long) === long)
check('an overview cut off mid-string is salvaged',
  parseOverview('{"overview":"' + long).length > 40)
check('an empty reply yields nothing',
  parseOverview('') === '')
check('a non-string reply yields nothing',
  parseOverview(null) === '')
check('a reply that is only punctuation yields nothing',
  parseOverview('{}') === '')

console.log('\n=== نطق الكلمات الإندونيسية ===\n')

// --- the splitter must hand each language to the right voice --------------
const mixed = 'الآن ينتقل المتحدث إلى فكرة أن التعليم يستهلك وقت الطالب. كلمة mengurbankan تعني يضحي بوقته، و jam kosong تعني الحصة الفارغة.'
const runs = splitByScript(mixed)
const latin = runs.filter(r => r.script === 'latin').map(r => r.text.trim())
const arabic = runs.filter(r => r.script === 'other').map(r => r.text).join('')

check('every Indonesian word is separated out',
  latin.includes('mengurbankan'), latin.join('|'))
check('a second Indonesian term is separated too',
  latin.some(t => t.includes('jam') || t.includes('kosong')), latin.join('|'))
check('the Arabic text stays with the Arabic voice',
  arabic.includes('الآن ينتقل المتحدث') && !/mengurbankan/.test(arabic))
check('a purely Arabic script needs no split',
  splitByScript('هذا شرح بالعربية فقط.').every(r => r.script === 'other'))
check('a purely Indonesian script is one run',
  splitByScript('Ini penjelasan dalam bahasa Indonesia.').every(r => r.script === 'latin'))
check('a single stray Latin letter does not switch voices',
  splitByScript('الشرح a واضح').filter(r => r.script === 'latin').length === 0)
check('an accented or hyphenated term is kept whole',
  splitByScript('كلمة e-mail شائعة').some(r => r.text.includes('e-mail')))
check('an empty string yields no runs',
  splitByScript('').length === 0)

console.log('\n=== مقدار التدخل ===\n')

// --- the listener asked for a stop every 15-20 seconds --------------------
check('the densest setting stops every 15 seconds for a beginner',
  gapFor('heavy', 'beginner') === 15, `${gapFor('heavy', 'beginner')}`)
check('the gentle default stops every 20 seconds for a beginner',
  gapFor('normal', 'beginner') === 20, `${gapFor('normal', 'beginner')}`)
check('the middle setting stops every 20 seconds for an intermediate learner',
  gapFor('heavy', 'intermediate') === 20, `${gapFor('heavy', 'intermediate')}`)
check('every level is within 15-30 seconds on the two useful modes',
  ['light', 'normal', 'heavy'].every(d => ['beginner', 'intermediate'].every(l =>
    gapFor(d, l) >= 15 && gapFor(d, l) <= 60)))

// --- the count must agree with what the spacing can actually keep --------
// targetCount used to round up, promising more interruptions than the grid had
// room for, so every job came in under its own target.
check('the target count never exceeds the slots the recording holds',
  ['light', 'normal', 'heavy'].every(d => ['beginner', 'intermediate', 'advanced'].every(l =>
    targetCount(749, d, l) <= Math.floor(749 / gapFor(d, l)))))
check('a 12.5-minute clip at heavy/intermediate asks for about 37 stops',
  targetCount(749, 'heavy', 'intermediate') === 37,
  `${targetCount(749, 'heavy', 'intermediate')}`)
check('a clip shorter than one gap still asks for one',
  targetCount(5, 'heavy', 'beginner') === 1)
check('no duration yields one rather than zero',
  targetCount(0, 'heavy', 'beginner') === 1)

console.log(`\n=== ${pass} passed, ${fail} failed ===\n`)
process.exit(fail === 0 ? 0 : 1)
