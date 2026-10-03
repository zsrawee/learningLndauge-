/**
 * Prove the pipeline delivers many well-spaced interventions when the model
 * replies freely.
 *
 * The live key cannot afford a long recording, so this stands in a local
 * OpenAI-compatible endpoint that answers with correct JSON. That isolates the
 * question "does the pipeline distribute explanations properly?" from
 * "can this account pay for them?".
 */
import { createServer } from 'node:http'
import { readStage } from '../lib/jobs.mjs'

const PORT = 4199

// Quote real lines from the transcript the pipeline is analysing, so the
// locator can resolve them exactly as it would for a live model.
let LINES = []
try {
  const tr = readStage('jmuofeez4d2fa2f', 'transcript')
  LINES = tr.segments.map(s => s.text.trim()).filter(t => t.length > 25 && t.length < 120)
} catch { /* the long fixture is not on disk; fall back to the request text */ }

/**
 * Lines worth quoting, taken from whatever transcript this request carries.
 *
 * A short clip has its own segments, not the long fixture's, so the usable
 * lines are read back out of the request body.
 */
function linesIn(body) {
  const found = []
  // Transcript lines are sent as "[n] mm:ss text"; the body is JSON, so the
  // separator arrives escaped.
  for (const line of body.split(/\\n|\n/)) {
    const m = /^\[\d+\]\s+\d+:\d+(?::\d+)?\s+(.+)$/.exec(line.trim())
    if (!m) continue
    const text = m[1].trim().replace(/\\+$/, '')
    if (text.length >= 8 && text.length < 160) found.push(text)
  }
  return found
}

const server = createServer(async (req, res) => {
  if (!req.url.includes('/chat/completions')) {
    res.writeHead(404).end('{}')
    return
  }
  let body = ''
  for await (const chunk of req) body += chunk

  // The introduction is asked for separately and answered with its own key.
  // The prompt arrives as JSON, so its quotes are escaped in the raw body —
  // matching the bare word avoids depending on how it was serialized.
  if (body.includes('overview') && !body.includes('items')) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      id: 'stub', object: 'chat.completion', model: 'stub',
      choices: [{
        index: 0, finish_reason: 'stop',
        message: {
          role: 'assistant',
          content: JSON.stringify({
            overview: 'هذا تسجيل حوار عن التعليم وتجربة الطالب. يتحدث شخص واحد '
              + 'عن الوقت والانتباه الذين يستهلكهما التعليم، ويذكر أنه دفع المال '
              + 'وضحّى بوقته. ثم ينتقل إلى فكرة أن من حقّه أن يغضب عندما تُلغى '
              + 'الحصة. الكلمة المفتاحية المتكررة هي perhatian أي الانتباه.',
          }),
        },
      }],
      usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 },
    }))
    return
  }

  // Answer with exactly as many passages as this request asked for, quoting
  // lines that appear in THIS request — a model can only quote what it was
  // sent, and quoting elsewhere would fail the locator.
  const asked = Number(/(?:Return exactly|Aim for roughly)\s+(\d+)/.exec(body)?.[1] ?? 5)
  const count = Math.max(1, Math.min(asked, 20))

  const inRequest = linesIn(body)
  const usable = inRequest.length > 0 ? inRequest : LINES
  const take = Math.min(count, usable.length)
  const items = Array.from({ length: take }, (_, i) => {
    // Spread across the slice so the passages do not crowd one region.
    const line = usable[Math.floor((i * usable.length) / take)]
    return {
      segments: [line],
      reason: 'تركيب صعب',
      words: [{ term: 'kata' + i, meaning: 'كلمة رقم ' + i }],
      explanation: `الشرح رقم ${i + 1}: المتحدث هنا يستخدم تعبيراً عامياً يحتاج توضيحاً للمتعلم العربي.`,
    }
  })

  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({
    id: 'stub', object: 'chat.completion', model: 'stub',
    choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify({ items }) }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 100, completion_tokens: 800, total_tokens: 900 },
  }))
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`stub provider on http://127.0.0.1:${PORT}/v1 — ${LINES.length} quotable lines`)
})

export { server }
