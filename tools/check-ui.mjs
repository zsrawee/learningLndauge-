/**
 * Static check: every element the client reaches for must exist, either in the
 * HTML or created by the client itself. Catches the most common blank-page bug.
 */
import { readFileSync } from 'node:fs'

const html = readFileSync('public/index.html', 'utf8')
const js = readFileSync('public/app.js', 'utf8')

const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]))
const injected = new Set([...js.matchAll(/id="([^"]+)"/g)].map(m => m[1]))
const used = new Set([...js.matchAll(/\$\('([^']+)'\)/g)].map(m => m[1]))
const missing = [...used].filter(i => !ids.has(i) && !injected.has(i))

console.log(`used=${used.size} inHtml=${ids.size} injected=${injected.size}`)
console.log(missing.length ? `MISSING: ${missing.join(', ')}` : 'MISSING: none')

// Also confirm the new UI pieces are wired.
for (const [label, needle] of [
  ['model chooser renders', 'renderModelChooser'],
  ['model choice applies', 'chooseModel'],
  ['live stream opens', 'EventSource'],
  ['live log appends', 'liveAppend'],
  ['unavailable model handled', 'model is unavailable'],
  ['the introduction is labelled in the list', "'المقدمة'"],
  ['the interview card is shown on needAnswers', 'needAnswers'],
  ['answers are collected from the questions', 'collectAnswers'],
  ['brief is prefilled on boot', 'loadBrief'],
  ['fixed questions are rendered before any upload', '/api/questions'],
]) {
  console.log(`${js.includes(needle) ? 'OK  ' : 'FAIL'} ${label}`)
}

// The introduction is spoken but explains no passage, so it must not inflate
// the count of explanations shown to the learner.
const cutCountLine = js.match(/\$\('cutCount'\)[^\n]*/)?.[0] ?? ''
const cutCountOk = /filter\(i => !i\.intro\)/.test(cutCountLine)
console.log(`${cutCountOk ? 'OK  ' : 'FAIL'} the introduction is excluded from the explanation count`)

// The level/density dropdowns are gone; the brief replaced them.
const gone = ['renderDensityHint', 'GAP_SECONDS', "$('level')", "$('density')"]
for (const g of gone) {
  if (js.includes(g)) { console.log(`FAIL  removed UI code still present: ${g}`); process.exit(1) }
}
console.log('OK   level/density UI removed in favour of the brief')

// The pipeline no longer reads settings.level/settings.density as the primary
// driver — the brief decides. Confirm it imports the helpers for that.
const pipeline = readFileSync('lib/pipeline.mjs', 'utf8')
for (const [label, needle] of [
  ['pipeline reads the brief', 'getBrief()'],
  ['pipeline derives spacing from the brief', 'briefToSettings(brief)'],
  ['pipeline can ask the learner', 'needAnswers'],
]) {
  console.log(`${pipeline.includes(needle) ? 'OK  ' : 'FAIL'} ${label}`)
}

process.exit(missing.length === 0 && cutCountOk ? 0 : 1)
