/**
 * Minimal OpenAI-compatible chat client.
 *
 * Only text is needed here, so this is far smaller than a full provider card.
 * Transient network failures are retried: a long job should not die because a
 * single connection blipped.
 */

// This relay answers intermittently: identical requests succeed and then fail
// with 502 for minutes at a time. Three quick retries inside 15s never outlast
// one of those outages, so a job that could have finished dies instead. Back
// off long enough for the relay to recover — the job is long-running anyway.
const RETRY_DELAYS = [10_000, 30_000, 90_000, 240_000]

// A slow relay can take minutes to think through a long transcript. 180s was
// too tight: a real provider answered a one-item request in 65s, so a request
// for ten passages never finished and the job died after four retries.
const DEFAULT_TIMEOUT = 20 * 60 * 1000

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

/**
 * @returns {Promise<{ok:boolean, text?:string, message?:string}>}
 */
/**
 * Build the chat-completions URL for a provider base URL.
 *
 * Three shapes are in the wild and all must work:
 *   https://openrouter.ai/api/v1                                  → .../chat/completions
 *   http://localhost:1234                                         → .../v1/chat/completions
 *   https://generativelanguage.googleapis.com/v1beta/openai       → .../chat/completions
 * A base that already ends in a version segment, or in the OpenAI-compatibility
 * path Google uses, must NOT get another `/v1` appended.
 */
export function chatUrl(baseURL) {
  const base = String(baseURL ?? '').trim().replace(/\/+$/, '')
  if (!base) return ''
  // Endpoints that are already complete: .../v1, .../v1beta, .../openai
  const complete = /\/(v\d+[a-z]*|openai)$/.test(base)
  return complete ? `${base}/chat/completions` : `${base}/v1/chat/completions`
}

/**
 * Recognise which service an API key belongs to from its shape.
 *
 * This is only a hint and must never be treated as authoritative: services hand
 * out keys in shapes we cannot know, and a wrong guess is worse than none. Use
 * it to pre-fill a URL the user can correct, never to block a request.
 */
export function detectKeyOwner(apiKey) {
  const key = String(apiKey ?? '').trim()
  if (!key) return null
  // Specific prefixes first; the generic `sk-` family last so it cannot
  // swallow the keys that have their own prefix.
  if (key.startsWith('sk-or-v1-')) return 'openrouter'
  if (key.startsWith('sk-ant-')) return 'anthropic'
  if (key.startsWith('sk-proj-')) return 'openai'
  if (key.startsWith('gsk_')) return 'groq'
  if (key.startsWith('xai-')) return 'xai'
  if (key.startsWith('AIza')) return 'google'
  if (key.startsWith('AQ.')) return 'google'
  if (key.startsWith('r8_')) return 'replicate'
  // `sk-` alone is used by OpenAI and by many unrelated services
  // (sk-tinyfish-…, for example), so it is only a weak signal.
  if (key.startsWith('sk-')) return 'openai'
  return null
}

/** Services a base URL clearly belongs to, for the same mismatch check. */
export function detectUrlOwner(baseURL) {
  const url = String(baseURL ?? '').toLowerCase()
  if (!url) return null
  if (url.includes('openrouter.ai')) return 'openrouter'
  if (url.includes('anthropic.com')) return 'anthropic'
  if (url.includes('generativelanguage.googleapis.com')) return 'google'
  if (url.includes('openai.com')) return 'openai'
  if (url.includes('groq.com')) return 'groq'
  if (url.includes('x.ai')) return 'xai'
  return null
}

/**
 * Base URLs to try, in order, when the user asks us to work it out.
 * A bare `sk-` key is ambiguous, so OpenAI is offered before the others.
 */
export const OWNER_URLS = {
  openrouter: ['https://openrouter.ai/api/v1'],
  openai: ['https://api.openai.com/v1'],
  google: ['https://generativelanguage.googleapis.com/v1beta/openai'],
  anthropic: ['https://api.anthropic.com/v1'],
  groq: ['https://api.groq.com/openai/v1'],
  xai: ['https://api.x.ai/v1'],
}

/**
 * Check whether a key is genuinely accepted by a provider.
 *
 * Listing models is NOT proof: OpenRouter serves its catalogue to anonymous
 * callers, so a bad key still gets a 200 with hundreds of models. Only a real
 * authenticated request tells the truth.
 */
export async function verifyKey(baseURL, apiKey, model) {
  if (!apiKey) return { ok: false, reason: 'no-key' }
  const url = chatUrl(baseURL)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20_000)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
      }),
      signal: controller.signal,
    })
    const text = await res.text()

    if (res.status === 401 || res.status === 403) return { ok: false, reason: 'unauthorized' }
    // Any other answer proves the key was accepted far enough to be judged:
    // a bad model (400/404) still means authentication succeeded.
    if (res.ok) return { ok: true }
    if (/auth|api key|unauthorized|credential/i.test(text)) return { ok: false, reason: 'unauthorized' }
    return { ok: true, note: `HTTP ${res.status}` }
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Find the provider a key actually works with by asking each one in turn.
 *
 * Guessing from the key's prefix is unreliable, so this settles the question
 * with a real authenticated request and returns the first provider that
 * accepts the key.
 */
export async function resolveProvider(apiKey, onProgress) {
  const key = String(apiKey ?? '').trim()
  if (!key) return { ok: false, message: 'أدخل مفتاح الـAPI أولاً.' }

  // Try the likely owner first, then the rest.
  const guessed = detectKeyOwner(key)
  const order = Object.keys(OWNER_URLS)
  if (guessed && order.includes(guessed)) {
    order.splice(order.indexOf(guessed), 1)
    order.unshift(guessed)
  }

  const tried = []
  for (const owner of order) {
    const baseURL = OWNER_URLS[owner][0]
    onProgress?.(`أتحقق من ${owner}…`)

    const listed = await fetchModels({ baseURL, apiKey: key, skipMatchCheck: true })
    if (!listed.ok || listed.models.length === 0) { tried.push(owner); continue }

    // Listing alone is not proof the key is valid, so confirm with a real call.
    const probe = listed.models.find(m => /flash|mini|haiku|small|lite|turbo/i.test(m))
      ?? listed.models[0]
    const verified = await verifyKey(baseURL, key, probe)
    if (!verified.ok) { tried.push(owner); continue }

    return { ok: true, provider: baseURL, owner, models: listed.models }
  }

  return {
    ok: false,
    message: `لم يقبل أي مزود معروف هذا المفتاح (جرّبت: ${tried.join(', ')}). ` +
      'تأكد من نسخ المفتاح كاملاً ومن أنه ما زال فعالاً، أو أدخل عنوان المزود يدوياً.',
  }
}

/**
 * Notice when a key clearly belongs to a different service than the base URL.
 *
 * This is advisory only. A key's prefix is not reliable (many services issue
 * `sk-…` keys that are not OpenAI's), so the mismatch is reported to help the
 * user rather than used to refuse the request — the provider itself is the
 * final judge. Returns null when there is nothing worth saying.
 */
export function checkKeyMatch(baseURL, apiKey) {
  const keyOwner = detectKeyOwner(apiKey)
  const urlOwner = detectUrlOwner(baseURL)
  if (!keyOwner || !urlOwner || keyOwner === urlOwner) return null
  // Only warn on prefixes we are confident about; a bare `sk-` is too weak.
  if (keyOwner === 'openai' && !String(apiKey).startsWith('sk-proj-')) return null

  const fix = OWNER_URLS[keyOwner]?.[0]
  return {
    keyOwner,
    urlOwner,
    message:
      `يبدو أن المفتاح يخص ${keyOwner} بينما العنوان يخص ${urlOwner}. ` +
      'إن فشل الطلب، اضغط «اكتشف تلقائياً» ليجرب المزودين تلقائياً.' +
      (fix ? ` العنوان المقترح: ${fix}` : ''),
  }
}

/**
 * Read the token budget a provider says it can afford.
 *
 * OpenRouter reports this when a prepaid balance cannot cover the requested
 * maximum: "you requested up to 4080 tokens, but can only afford 3927".
 * Returning that number lets the caller shrink the request instead of failing.
 */
export function affordableTokens(message) {
  const m = /can only afford\s+(\d+)/i.exec(String(message ?? ''))
  if (!m) return 0
  const n = Number(m[1])
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** Turn a provider failure into something the user can act on, in Arabic. */
export function describeProviderError(status, raw) {
  const text = String(raw ?? '')

  if (/can only afford|more credits|insufficient|quota|billing/i.test(text)) {
    return 'رصيد المفتاح لا يكفي لهذا الطلب. اشحن الحساب أو اختر موديلاً مجانياً، ثم اضغط «أعد المحاولة».\n' +
      `(تفاصيل من المزود: ${text.slice(0, 160)})`
  }
  if (status === 401 || status === 403 || /api key|unauthorized|credential/i.test(text)) {
    return 'المفتاح غير صحيح أو منتهي. عدّل المفتاح في الإعدادات ثم اضغط «أعد المحاولة».\n' +
      `(تفاصيل من المزود: ${text.slice(0, 160)})`
  }
  if (status === 402) {
    return 'المزود يطلب رصيداً مدفوعاً لهذا الطلب. جرّب موديلاً مجانياً من قائمة الموديلات.\n' +
      `(تفاصيل من المزود: ${text.slice(0, 160)})`
  }
  if (status === 404 || /model.*(not|un)?available|no such model/i.test(text)) {
    return 'الموديل غير متاح. اختر موديلاً آخر من «اختر موديلاً».\n' +
      `(تفاصيل من المزود: ${text.slice(0, 160)})`
  }
  if (status === 429) {
    return 'تجاوزت الحد المسموح مؤقتاً. انتظر قليلاً ثم اضغط «أعد المحاولة».'
  }
  return `فشل التحليل (${status}): ${text.slice(0, 200)}`
}

export async function chat({ baseURL, apiKey, model, messages, maxTokens = 2000, temperature = 0.2, timeout = DEFAULT_TIMEOUT, onProgress }) {
  if (!baseURL) return { ok: false, message: 'No provider base URL configured.' }
  if (!model) return { ok: false, message: 'No model selected.' }

  const url = chatUrl(baseURL)

  let lastError = 'unknown failure'
  let budget = maxTokens

  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    const payload = JSON.stringify({ model, messages, max_tokens: budget, temperature })
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: payload,
        signal: controller.signal,
      })
      const text = await res.text()
      let body
      try { body = JSON.parse(text) } catch { body = undefined }

      if (!res.ok) {
        // A prepaid account can be limited by the answer's maximum length, not
        // by the request itself. The provider says how much it can afford, so
        // shrink the budget to fit and try again rather than failing the job.
        const affordable = affordableTokens(body?.error?.message ?? text)
        if (affordable && affordable < budget) {
          // Not a failure — just a smaller answer than we asked for. Only
          // complain when even the reduced budget cannot hold a single item.
          if (affordable >= 600) {
            onProgress?.(`المزود يسمح بـ ${affordable} رمزاً — تقليل الطلب وإعادة المحاولة`)
            budget = Math.max(256, affordable)
            continue
          }
          return {
            ok: false, budget,
            message: 'رصيد المفتاح لا يكفي لأي شرح. اشحن الحساب أو اختر موديلاً مجانياً آخر، ثم «أعد المحاولة».',
          }
        }

        // 5xx and 429 are worth retrying; 4xx generally are not.
        if ((res.status >= 500 || res.status === 429) && attempt < RETRY_DELAYS.length) {
          lastError = `Provider HTTP ${res.status}`
          // Surface the wait so a long pause is not mistaken for a hang.
          onProgress?.(`المزود مشغول (${res.status}) — إعادة المحاولة ${attempt + 1} من ${RETRY_DELAYS.length}`)
          await sleep(RETRY_DELAYS[attempt])
          continue
        }
        const raw = body?.error?.message ?? text.slice(0, 240)
        return { ok: false, message: describeProviderError(res.status, raw), raw: String(raw), budget }
      }

      // A gateway can answer 200 with an error object instead of choices — a
      // relayed upstream failure. Treating that as success hides the real cause
      // behind a vague "empty response".
      if (body?.error && !body?.choices) {
        const raw = String(body.error.message ?? JSON.stringify(body.error))
        const retryable = /overloaded|unavailable|temporarily|rate.?limit|timeout/i.test(raw)
        if (retryable && attempt < RETRY_DELAYS.length) {
          lastError = raw
          onProgress?.(`المزود مشغول — إعادة المحاولة ${attempt + 1} من ${RETRY_DELAYS.length}`)
          await sleep(RETRY_DELAYS[attempt])
          continue
        }
        return { ok: false, message: describeProviderError(503, raw), raw }
      }

      const out = body?.choices?.[0]?.message?.content
      if (typeof out !== 'string' || out.trim().length === 0) {
        // A reasoning model can return no visible text while still reporting a
        // successful call — say so, rather than blaming the provider.
        const reason = body?.choices?.[0]?.finish_reason
        return {
          ok: false,
          message: reason === 'length'
            ? 'الموديل استهلك حدّ الإخراج في التفكير ولم يُرجع شرحاً. جرّب موديلاً آخر.'
            : 'الموديل لم يُرجع أي شرح. جرّب موديلاً آخر ثم «أعد المحاولة».',
        }
      }
      return { ok: true, text: out, budget }
    } catch (error) {
      // A dropped connection or timeout: retry before giving up.
      lastError = String(error?.message ?? error)
      if (attempt < RETRY_DELAYS.length) {
        await sleep(RETRY_DELAYS[attempt])
        continue
      }
      return { ok: false, message: `Request failed after ${attempt + 1} attempts: ${lastError}` }
    } finally {
      clearTimeout(timer)
    }
  }

  return { ok: false, message: `Request failed: ${lastError}` }
}

/** Ask an OpenAI-compatible endpoint which models it serves. */
export async function fetchModels({ baseURL, apiKey, skipMatchCheck = false }) {
  if (!baseURL) return { ok: false, message: 'أدخل عنوان المزود أولاً.' }

  // Advisory only: a mismatched key may still be valid for another service, so
  // this is surfaced to the user rather than used to refuse the request.
  const mismatch = skipMatchCheck ? null : checkKeyMatch(baseURL, apiKey)

  const base = String(baseURL).replace(/\/+$/, '')
  const url = /\/(v\d+[a-z]*|openai)$/.test(base) ? `${base}/models` : `${base}/v1/models`
  try {
    const res = await fetch(url, {
      headers: { accept: 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      let detail = text.slice(0, 300)
      try { detail = JSON.parse(text)?.error?.message ?? detail } catch { /* keep raw */ }
      return {
        ok: false,
        message: `فشل جلب الموديلات (HTTP ${res.status})${detail ? ': ' + detail : ''}`,
      }
    }
    const body = await res.json()
    const raw = body?.data ?? body?.models ?? []
    const models = (Array.isArray(raw) ? raw : [])
      .map(m => (typeof m === 'string' ? m : m?.id))
      // Google lists models as "models/gemini-2.5-flash" but the chat API
      // expects the bare id, so strip the prefix it advertises.
      .map(id => typeof id === 'string' ? id.replace(/^models\//, '') : id)
      .filter(id => typeof id === 'string' && id.length > 0)

    // Google also lists embeddings, TTS and image models, which cannot be used
    // for chat. Filtering them here saves a confusing failure later.
    const unusable = /(embedding|embed|aqa|tts|image|vision-only|native-audio|robotics|learnlm)/i
    const usable = models.filter(id => !unusable.test(id))
    if (models.length === 0) return { ok: false, message: 'لم يعرض المزود أي موديل.' }
    // Fall back to the unfiltered list if the filter removed everything.
    return {
      ok: true,
      models: usable.length > 0 ? usable : models,
      // Advisory note, if the key looks like it belongs elsewhere.
      ...(mismatch ? { warning: mismatch.message } : {}),
    }
  } catch (error) {
    return { ok: false, message: `Could not reach ${url}: ${String(error?.message ?? error)}` }
  }
}
