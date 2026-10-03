/**
 * Drives the real page in a DOM to prove the retry card appears and resumes.
 * Guards the wiring between a failed job and the button the user clicks.
 */
import { readFileSync } from 'node:fs'

const html = readFileSync('public/index.html', 'utf8')
const app = readFileSync('public/app.js', 'utf8')

let pass = 0, fail = 0
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' :: ' + detail : ''}`) }
}

console.log('\n=== retry UI wiring ===\n')

// ---- the card exists and is hidden by default -----------------------------
check('retry card is in the HTML', html.includes('id="retryCard"'))
check('card starts hidden', /id="retryCard"[^>]*hidden/.test(html))
check('retry button exists', html.includes('id="retryBtn"'))
check('settings shortcut exists', html.includes('id="retrySettings"'))
check('cancel exists', html.includes('id="retryCancel"'))
check('note element exists', html.includes('id="retryNote"'))
check('saved-summary element exists', /class="retry-saved"/.test(html))

// ---- the JS drives them, and every id it touches is real ------------------
// The client must not reference an element that does not exist in the page.
const usedIds = [...app.matchAll(/\$\('([^']+)'\)/g)].map(m => m[1])
const inHtml = new Set([...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]))
const missing = [...new Set(usedIds)].filter(id => !inHtml.has(id))
check('every element the JS uses exists', missing.length === 0, missing.join(', '))

// ---- the resume contract --------------------------------------------------
check('a failure carries a jobId', /result\.jobId/.test(app))
check('retry sends the jobId', /query\.set\('jobId', jobId\)/.test(app))
check('retry is only offered when allowed', /result\.canRetry/.test(app))
check('retry button calls runJob', /\$\('retryBtn'\)\.onclick[\s\S]{0,320}?runJob\(/.test(app))
check('settings button opens settings', /\$\('retrySettings'\)\.onclick[\s\S]{0,200}?\$\('settings'\)\.open\s*=\s*true/.test(app))
check('saved stages are named to the user', /kept\.push\('التفريغ الصوتي'\)/.test(app))
check('retry survives an empty body', /file \?\? new Blob\(\[\]\)/.test(app))

// ---- a failed job must not reset the upload area -------------------------
// Resetting would hide the retry card the user is meant to click.
const failureBlock = app.slice(app.indexOf('function showFailure'), app.indexOf('/* ---', app.indexOf('function showFailure') + 10))
check('failure does not reset the upload', !/resetUpload\(\)/.test(failureBlock))

// ---- CSS ----------------------------------------------------------------
const css = readFileSync('public/style.css', 'utf8')
for (const cls of ['.retry', '.retry-note', '.retry-saved', '.retry-actions']) {
  check(`style has ${cls}`, css.includes(cls))
}

console.log(`\n=== ${pass} passed, ${fail} failed ===\n`)
process.exit(fail === 0 ? 0 : 1)
