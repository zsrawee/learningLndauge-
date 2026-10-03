/**
 * Guards the failures that made a finished recording unusable:
 *   1. the download route rejected the job ids the app actually generates
 *   2. a long recording produced only one interruption
 *   3. a reply cut off mid-JSON was thrown away whole
 *
 * They were all silent: the file was built correctly, so nothing in the logs
 * complained. These assertions are the alarm.
 *
 * Needs the server running:  node server.mjs
 */
const BASE = 'http://127.0.0.1:4180'

// Wait briefly for a server that is still starting, instead of reporting a
// connection error as a test failure.
let up = false
for (let i = 0; i < 20 && !up; i++) {
  try { up = (await fetch(`${BASE}/api/state`)).ok } catch { await new Promise(r => setTimeout(r, 1000)) }
}
if (!up) {
  console.log(`\n  the server is not answering on ${BASE}`)
  console.log('  start it first:  node server.mjs\n')
  process.exit(1)
}

let pass = 0, fail = 0
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' :: ' + detail : ''}`) }
}

console.log('\n=== produced files must be downloadable ===\n')

const { newJobId, isJobId } = await import('../lib/jobs.mjs')

// ---- the id shape -------------------------------------------------------
console.log('job id shape')
const ids = Array.from({ length: 200 }, () => newJobId())
check('ids are unique', new Set(ids).size === ids.length)
check('every generated id validates', ids.every(isJobId),
  ids.find(i => !isJobId(i)) ?? '')

// The old download route demanded a UUID, which no generated id is. That
// mismatch is exactly what produced 0-second downloads.
const uuid = /^[a-f0-9-]{36}$/i
check('generated ids are NOT uuids (the old check)', !ids.some(i => uuid.test(i)),
  'if this fails the route rewrite was unnecessary')
// Old jobs were named with uuids; those files may still exist on disk, but the
// download route no longer needs to accept them — only ids this build produces.
check('a bare uuid is not a job id', isJobId('86b376cd-74ab-4345-a602-10932bddcb4b') === false)

// ---- rejects anything that is not an id ---------------------------------
console.log('\nrejects bad input (path traversal and friends)')
for (const bad of ['', '../etc/passwd', '..%2f..%2fetc', 'j/../../x', 'x'.repeat(60),
  'JOB-1', 'j; rm -rf /', 'j' + 'a'.repeat(40)]) {
  check(`rejects ${JSON.stringify(bad).slice(0, 28)}`, isJobId(bad) === false)
}

// ---- the route actually serves the bytes --------------------------------
console.log('\nthe download route serves real bytes')
const state = await (await fetch(`${BASE}/api/state`)).json()
// Prefer the newest finished job; fall back to one already on disk so the byte
// checks still run on a freshly started server.
const { readdirSync, statSync } = await import('node:fs')
const onDisk = (() => {
  try {
    return readdirSync('data/output')
      .filter(f => f.endsWith('.mp3'))
      .map(f => ({ id: f.replace(/\.mp3$/, ''), mtime: statSync(`data/output/${f}`).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)[0]?.id
  } catch { return undefined }
})()
const lastId = state.last?.id ?? onDisk
check('a produced file is available to test', typeof lastId === 'string' && lastId.length > 0,
  String(lastId))

if (lastId) {
  const res = await fetch(`${BASE}/file/${lastId}`)
  check('route returns 200', res.status === 200, String(res.status))
  check('route declares audio', (res.headers.get('content-type') ?? '').includes('audio'))

  const declared = Number(res.headers.get('content-length'))
  const body = Buffer.from(await res.arrayBuffer())
  check('body is not empty', body.length > 0, `${body.length} bytes`)
  check('body matches the declared length', body.length === declared,
    `${body.length} vs ${declared}`)
  check('body is a real mp3', body.slice(0, 3).toString('hex') === '494433' ||
    body.slice(0, 2).toString('hex') === 'fffb', body.slice(0, 3).toString('hex'))
}

// ---- a bad id must not be served ----------------------------------------
const traversal = await fetch(`${BASE}/file/..%2f..%2fdata%2fsecrets.json`)
check('traversal is refused', traversal.status === 404, String(traversal.status))

console.log('\n=== spacing: a long recording needs many interruptions ===\n')

const { enforceSpacing, targetCount, gapFor } = await import('../lib/analyze.mjs')
const mk = (s, e, v = 120) => ({ start: s, end: e, explanation: 'x'.repeat(v), words: [{ term: 'a' }] })
const gapsOf = a => { const g = []; for (let i = 1; i < a.length; i++) g.push(a[i].start - a[i - 1].start); return g }
const gap = gapFor('heavy', 'beginner')

// A 12-minute recording must ask for a useful number of interruptions.
check('12 min asks for many, not one', targetCount(749, 'heavy', 'beginner') >= 30,
  String(targetCount(749, 'heavy', 'beginner')))
check('30 s clip still asks for one', targetCount(30, 'heavy', 'beginner') >= 1)

// The real failure: 40 findings all 17 s apart collapsed to a handful.
const dense = []
for (let p = 0; p < 4; p++) for (let i = 0; i < 10; i++) dense.push(mk(p * 180 + i * 17, p * 180 + i * 17 + 4, 100 + i * 5))
dense.sort((a, b) => a.start - b.start)

const thinned = enforceSpacing(dense, gap, 749)
const g1 = gapsOf(thinned)
// 40 passages crammed into four clusters must spread out, but a well-covered
// recording must still be well covered: one per 20s window across 749s.
check('keeps a substantial share', thinned.length >= 20, `${thinned.length} of ${dense.length}`)
check('removes clustering', Math.min(...g1) >= gap, `${Math.min(...g1)}s`)
check('leaves no long silence', Math.max(...g1) < 400, `${Math.max(...g1)}s`)
check('output stays time-ordered',
  thinned.every((c, i) => i === 0 || c.start >= thinned[i - 1].start))

// Already-spread passages must survive untouched.
const spread = [0, 60, 120, 180, 240].map(s => mk(s, s + 5))
check('spread passages are left alone', enforceSpacing(spread, gap, 300).length === 5)

// Overlaps teach once.
check('overlapping passages collapse', enforceSpacing([mk(10, 20, 200), mk(12, 18, 100)], gap, 300).length === 1)

check('one stays one', enforceSpacing([mk(5, 10)], gap, 100).length === 1)
check('none stays none', enforceSpacing([], gap, 100).length === 0)

console.log('\n=== a reply cut off mid-JSON must still teach ===\n')

const { parseAnalysis } = await import('../lib/analyze.mjs')

// Models spend part of the budget on hidden reasoning and get cut off with
// finish_reason "length". Every item before the cut is complete and useful.
const whole = (n) => Array.from({ length: n }, (_, i) =>
  `{"segments":["baris ${i}"],"reason":"sebab","words":[{"term":"kata${i}","meaning":"كلمة"}],"explanation":"شرح بالعربية رقم ${i}"}`)

const truncated = `{"items": [${whole(5).join(', ')}, {"segments": ["terputus"], "reason":`
const recovered = parseAnalysis(truncated)
check('recovers the complete items', recovered?.items.length === 5, `${recovered?.items.length ?? 0}`)
check('the recovered items carry explanations',
  recovered?.items.every(i => i.explanation.includes('شرح')) === true)
check('the recovered items carry vocabulary',
  recovered?.items.every(i => i.words.length === 1) === true)

// Truncation inside the first item leaves nothing to salvage.
check('nothing invented from a stub', parseAnalysis('{"items": [{"segments": ["a"') === undefined)

// Braces inside strings must not be mistaken for structure.
const braces = `{"items": [{"segments": ["a {b} c"], "explanation": "شرح } { داخل النص"}]}`
check('braces inside strings survive', parseAnalysis(braces)?.items.length === 1)

// A complete reply is unaffected by the salvage path.
const full = parseAnalysis(`{"items": [${whole(3).join(', ')}]}`)
check('a complete reply still parses', full?.items.length === 3, `${full?.items.length ?? 0}`)

// The array-only shape some models emit.
const bare = parseAnalysis(`[{"segments": ["x"], "explanation": "شرح"}]`)
check('a bare array parses', bare?.items.length === 1)

check('garbage yields nothing', parseAnalysis('hello world') === undefined)
check('empty yields nothing', parseAnalysis('') === undefined)
check('non-string yields nothing', parseAnalysis(null) === undefined)

console.log('\n=== a small reply budget must shrink the request ===\n')

const { chooseChunkSeconds, buildAnalysisPrompt, chunkSegments } = await import('../lib/analyze.mjs')

// A prepaid key may only afford ~2300 tokens. Sizing the slice to the budget is
// what keeps each reply complete; ignoring it produced a 2-intervention result.
const rich = chooseChunkSeconds({ density: 'heavy', level: 'beginner', budgetTokens: 8000 })
const poor = chooseChunkSeconds({ density: 'heavy', level: 'beginner', budgetTokens: 2300 })
check('a large budget allows a bigger slice', rich > poor, `${rich} vs ${poor}`)
check('a small budget still asks for more than one', poor >= 40, `${poor}s`)
check('the slice never exceeds the safe maximum', rich <= 180, `${rich}s`)

// Smaller slices must ask for proportionally fewer passages.
const segs = Array.from({ length: 200 }, (_, i) => ({ start: i * 3, end: i * 3 + 3, text: `line ${i}` }))
const coarse = chunkSegments(segs, 180)
const fine = chunkSegments(segs, 60)
check('a smaller slice makes more chunks', fine.length > coarse.length, `${fine.length} vs ${coarse.length}`)
check('chunks cover the whole transcript',
  coarse[0][0].start === segs[0].start &&
  coarse[coarse.length - 1][coarse[coarse.length - 1].length - 1].end === segs[segs.length - 1].end,
  `${coarse.length} chunks`)
check('chunks do not overlap',
  coarse.every((c, i) => i === 0 || c[0].start >= coarse[i - 1][coarse[i - 1].length - 1].end))

// The prompt must not ask for more than the reply can hold.
const small = buildAnalysisPrompt({
  targetLanguage: 'id', nativeLanguage: 'ar', level: 'beginner',
  density: 'heavy', duration: 600, askFor: 5,
})
check('the ask is capped by the budget', /Return exactly 5/.test(small), small.match(/Return exactly \d+/)?.[0] ?? '')
const large = buildAnalysisPrompt({
  targetLanguage: 'id', nativeLanguage: 'ar', level: 'beginner',
  density: 'heavy', duration: 90,
})
check('a short part is not over-asked', /Return exactly [1-9]\b/.test(large), large.match(/Return exactly \d+/)?.[0] ?? '')

console.log(`\n=== ${pass} passed, ${fail} failed ===\n`)
process.exit(fail === 0 ? 0 : 1)
