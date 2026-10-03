/**
 * The spacing rule must thin clusters without gutting a good result.
 *
 * A real run produced 37 passages — correctly spread across a 12.5-minute
 * recording — and the thinning step cut them to 5. These cases pin both
 * directions: well-spread passages survive, crammed ones collapse.
 */
import { enforceSpacing, gapFor, targetCount } from '../lib/analyze.mjs'

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ` :: ${detail}` : ''}`) }
}
const mk = (start, len = 6) => ({
  start, end: start + len, segments: ['x'],
  explanation: 'شرح', words: [{ term: 'a', meaning: 'ب' }],
})
const starts = (list) => list.map(x => Math.round(x.start))
const minGap = (list) => {
  let m = Infinity
  for (let i = 1; i < list.length; i++) m = Math.min(m, list[i].start - list[i - 1].start)
  return list.length < 2 ? Infinity : m
}

const gap = gapFor('heavy', 'beginner') // 15

console.log(`\n=== gap = ${gap}s ===\n`)

// The regression that mattered: an already-even answer must not be thinned.
// Step by the gap itself, so the fixture stays honest if the table changes.
const even12 = Array.from({ length: 37 }, (_, i) => mk(Math.round(i * gap * 1.012)))
const keptEven = enforceSpacing(even12, gap, 749)
check('37 evenly spread passages all survive', keptEven.length === 37, `${keptEven.length}`)
check('their spacing is preserved', minGap(keptEven) >= gap - 1, `${minGap(keptEven).toFixed(1)}s`)

// Crammed passages must collapse to one per window.
const crammed = Array.from({ length: 37 }, (_, i) => mk(i * 1.5))
const keptCrammed = enforceSpacing(crammed, gap, 749)
check('37 crammed into a minute collapse', keptCrammed.length <= 4, `${keptCrammed.length}`)
check('what survives is still spaced', minGap(keptCrammed) >= gap, `${minGap(keptCrammed)}s`)

// Four clusters of ten, each cluster stepping just inside one gap. Every
// passage here can be replaced by a later one in the same slot, and a slot
// whose winner drags the anchor forward eats the next slot too — the chain
// collapses to one survivor per cluster. Clusters are spaced far enough apart
// to stay independent.
//
// Within a cluster the grid opens at the first item and then takes the first
// item at or past each following gap. With a 0.85*gap step that is every
// second item, so a cluster of ten yields five — and the bug this pins is
// yielding ONE.
const step = Math.round(gap * 0.85)
const perCluster = Math.ceil(10 / Math.ceil(gap / step))
const clusterSpan = 9 * step
const clusterStride = clusterSpan + 10 * gap
const clustered = []
for (let p = 0; p < 4; p++)
  for (let i = 0; i < 10; i++) clustered.push(mk(p * clusterStride + i * step))
clustered.sort((a, b) => a.start - b.start)
const keptClustered = enforceSpacing(clustered, gap, 3000)
check('a dense run is thinned to what the recording holds, not to one',
  keptClustered.length === perCluster * 4,
  `${keptClustered.length} of ${clustered.length}, expected ${perCluster * 4}`)
check('the thinned run is evenly spaced', minGap(keptClustered) >= gap, `${minGap(keptClustered)}s`)

// The best of a window wins, not the first.
const window = [mk(10), mk(15), mk(19)]
window[1].explanation = 'شرح طويل ومفصّل جداً للمتعلم المبتدئ'.repeat(4)
const best = enforceSpacing(window, gap, 100)
check('the richest candidate represents its window',
  best.length === 1 && best[0].start === 15, `${starts(best)}`)

// Already-far-apart passages are untouched.
const spread = [0, 40, 80, 120, 160].map(s => mk(s))
check('spread passages are left alone',
  starts(enforceSpacing(spread, gap, 200)).join() === '0,40,80,120,160',
  starts(enforceSpacing(spread, gap, 200)).join())

// Overlaps resolve to one.
const overlap = [{ start: 10, end: 40, segments: ['a'], explanation: 'x' },
  { start: 20, end: 50, segments: ['b'], explanation: 'y', words: [{ term: 't', meaning: 'م' }] }]
check('overlapping passages collapse', enforceSpacing(overlap, gap, 100).length === 1)

// Degenerate inputs.
check('one stays one', enforceSpacing([mk(5)], gap, 100).length === 1)
check('none stays none', enforceSpacing([], gap, 100).length === 0)

// A whole-recording check: even output should land near the target count.
const target = targetCount(749, 'heavy', 'beginner')
const ideal = Array.from({ length: target }, (_, i) => mk(i * (749 / target)))
check('a steady answer keeps the target count',
  enforceSpacing(ideal, gap, 749).length === target, `${enforceSpacing(ideal, gap, 749).length}/${target}`)

console.log('\n=== locating must send each passage to its own place ===\n')

const { locateInTranscript } = await import('../lib/analyze.mjs')

// A real transcript contains one-word segments like "Ya.". Treating a segment
// that is a substring of the quote as a match sent EVERY passage to that one
// segment, and the overlap pass then deleted all but a handful.
const segs = [
  { start: 0, end: 2, text: 'Ya.' },
  { start: 10, end: 20, text: 'Saya menghabiskan waktu untuk sekolah' },
  { start: 30, end: 42, text: 'Iya, olahraga seru banget.' },
  { start: 50, end: 64, text: 'Pasal lagi putus, ya, ada lagu itu' },
  { start: 70, end: 80, text: 'Terus sama otak secara otomatis' },
]
const quotes = segs.slice(1).map(s => ({ segments: [s.text], explanation: 'شرح', words: [] }))

const placed = locateInTranscript(quotes, segs)
check('every distinct passage is located', placed.length === 4, `${placed.length}`)
check('none is dragged to the one-word segment',
  placed.every(p => p.start !== 0), placed.map(p => p.start).join())
check('each lands on its own timestamp',
  [10, 30, 50, 70].every(t => placed.some(p => Math.abs(p.start - t) < 0.01)),
  placed.map(p => Math.round(p.start)).join())

// A fuzzy quote should still find its home when wording differs slightly.
const fuzzy = locateInTranscript(
  [{ segments: ['Saya menghabiskan waktu untuk sekolah ya'], explanation: 'ش', words: [] }], segs)
check('a slightly reworded quote still resolves', fuzzy.length === 1 && fuzzy[0].start === 10,
  `${fuzzy.length} @ ${fuzzy[0]?.start}`)

// A quote that matches nothing must be dropped, not forced onto a segment.
const absent = locateInTranscript(
  [{ segments: ['kalimat yang tidak ada sama sekali disini'], explanation: 'ش', words: [] }], segs)
check('an unfindable quote is dropped', absent.length === 0, `${absent.length}`)

console.log(`\n=== ${pass} passed, ${fail} failed ===\n`)
process.exit(fail === 0 ? 0 : 1)
