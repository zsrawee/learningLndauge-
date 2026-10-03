/* Voice Tutor — client.
 *
 * Deliberately thin: upload, wait, download. Settings exist but stay collapsed.
 */

const $ = (id) => document.getElementById(id)

const state = { settings: null, busy: false, job: null }

const STAGE_LABEL = {
  start: 'يستلم الملف',
  transcribe: 'يقرأ الصوت على جهازك',
  interview: 'يكتب أسئلة على مقاس هذا المقطع',
  analyze: 'يبحث عن الجمل الصعبة',
  speak: 'يسجّل الشرح',
  edit: 'يقص ويركّب الصوت',
  done: 'جاهز',
  error: 'خطأ',
}

const STAGE_PROGRESS = { transcribe: 15, interview: 25, analyze: 40, speak: 70, edit: 88, done: 100 }

function showError(message) {
  const el = $('error')
  el.textContent = message
  el.hidden = false
}

function clearError() { $('error').hidden = true }

async function api(path, options = {}) {
  const res = await fetch(path, {
    method: options.method ?? 'GET',
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  })
  try { return await res.json() } catch { return { ok: false, message: `HTTP ${res.status}` } }
}

/* ------------------------------------------------------------------ boot */

async function boot() {
  const s = await api('/api/state')
  if (!s.ok) { showError('تعذّر تحميل الإعدادات'); return }
  state.settings = s.settings
  applySettings(s.settings, s.secrets)
  loadBrief()
  loadVoices()
  checkRuntime()
  offerResume()
}

/**
 * A run that was cut short — the tab was closed, refreshed, or cancelled —
 * leaves its stages on disk. Without this the only way back is to re-upload,
 * which re-transcribes for nothing. On boot, surface the newest unfinished
 * job as a one-press resume.
 */
async function offerResume() {
  if (state.busy) return
  const r = await api('/api/pending')
  if (!r.ok || !r.job) return
  retryJob = { id: r.job.id, name: r.job.name }
  const note = $('retryNote')
  if (note) {
    note.textContent = r.job.analyzed
      ? `التسجيل والتحليل محفوظان${r.job.spoken ? ` (${r.job.spoken} شرح مسجّل)` : ''} — تتابع من حيث توقّفت.`
      : 'التفريغ الصوتي محفوظ — تتابع من حيث توقّفت.'
  }
  $('retryCard').hidden = false
  $('retryCard').scrollIntoView({ behavior: 'smooth', block: 'center' })
}

/** mm:ss for a number of seconds, matching the live timer. */
function formatClock(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds))
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}

function applySettings(s, secrets) {
  $('targetLanguage').value = s.targetLanguage ?? 'id'
  $('nativeLanguage').value = s.nativeLanguage ?? 'ar'
  $('provider').value = s.analysis?.provider ?? ''
  $('model').value = s.analysis?.model ?? ''
  $('speechEngine').value = s.speechEngine ?? 'free'
  $('replayPassage').checked = s.replayPassage !== false
  $('speechBase').value = s.speech?.baseURL ?? ''
  $('providerSpeech').hidden = (s.speechEngine ?? 'free') !== 'provider'
  updateKeyHints(secrets)
}

/** Keys are write-only: show a hint when one is stored, never the value. */
function updateKeyHints(secrets) {
  if (!secrets) return
  const a = $('analysisKey')
  const sp = $('speechKey')
  a.placeholder = secrets.analysisApiKey === 'set' ? '•••••••• (محفوظ)' : '••••••••'
  sp.placeholder = secrets.speechApiKey === 'set' ? '•••••••• (محفوظ)' : '••••••••'
}

async function checkRuntime() {
  const r = await api('/api/runtime')
  const el = $('whisperState')
  if (r.ok && r.whisper?.ok) {
    el.textContent = `✅ التفريغ المحلي جاهز (faster-whisper ${r.whisper.version})`
  } else {
    el.textContent = `⚠️ ${r.whisper?.message ?? 'فشل فحص محرك التفريغ'}`
  }
}

/* ---------------------------------------------------------------- voices */

async function loadVoices() {
  const r = await api('/api/voices')
  const sel = $('voice')
  if (!r.ok) {
    sel.innerHTML = '<option value="">افتراضي</option>'
    return
  }
  const lang = $('nativeLanguage').value || 'ar'
  const list = (r.byLocale?.[lang] ?? r.voices ?? []).slice(0, 40)
  sel.innerHTML = '<option value="">افتراضي حسب اللغة</option>' +
    list.map(v => `<option value="${v.name}">${v.name} · ${v.gender}</option>`).join('')
  sel.value = state.settings?.voice ?? ''
}

/* ---------------------------------------------------------------- upload */

/** The file last uploaded, so a retry can name it without a re-upload. */
let lastFileName = ''

async function upload(file) {
  if (!file || state.busy) return
  clearError()

  // A previous job may be waiting for answers; uploading instead starts over,
  // which is a deliberate choice, so its pending state is dropped here.
  pendingJob = null

  const ext = (file.name.match(/\.[^.]+$/) ?? [''])[0].toLowerCase()
  const ok = ['.mp3', '.wav', '.m4a', '.ogg', '.opus', '.webm', '.mp4', '.flac', '.aac']
  if (ext && !ok.includes(ext)) {
    showError(`صيغة غير مدعومة: ${ext}`)
    return
  }

  lastFileName = file.name
  await runJob({ file, name: file.name })
}

/**
 * Run (or resume) a job.
 *
 * A retry passes the existing jobId, so the server skips every stage it
 * already saved — most importantly the transcription.
 */
async function runJob({ file, name, jobId }) {
  if (state.busy) return
  state.busy = true

  $('uploadCard').querySelector('.drop').hidden = true
  $('run').hidden = false
  $('liveBox').hidden = false
  $('resultCard').hidden = true
  $('retryCard').hidden = true
  clearError()

  setStage('start', `«${name}»`, 2)
  liveReset()
  liveAppend('start', jobId ? `إعادة المحاولة على «${name}»` : name)

  const query = new URLSearchParams({ name })
  if (jobId) query.set('jobId', jobId)

  try {
    const res = await fetch('/api/tutor?' + query.toString(), {
      method: 'POST',
      body: file ?? new Blob([]),
    })
    const result = await res.json()
    if (!result.ok) {
      liveAppend('error', result.message ?? 'فشل', 'error')
      clearInterval(liveTimer)
      showFailure(result)
      return
    }
    // The pipeline stopped to ask the learner something. Hand over the
    // questions; the transcript is already saved, so resuming is free.
    if (result.needAnswers) {
      pendingJob = { id: result.jobId, name: result.name ?? lastFileName }
      retryJob = null
      showInterview(result.questions ?? [])
      return
    }
    pendingJob = null
    retryJob = null
    showResult(result)
  } catch (error) {
    liveAppend('error', error.message, 'error')
    clearInterval(liveTimer)
    showError('انقطع الاتصال: ' + error.message)
    resetUpload()
  } finally {
    state.busy = false
  }
}

/**
 * Turn a pipeline failure into something actionable.
 *
 * A failure after transcription is not fatal: the transcript is saved on disk,
 * so the user can fix a setting and retry without paying for it again.
 */
function showFailure(result) {
  const message = result.message ?? 'فشل'
  const stage = result.stage ?? ''

  if (/model is unavailable|model not found|no such model|invalid model|not a valid model/i.test(message)) {
    showError(
      `الموديل «${$('model').value.trim()}» غير متاح عند مزودك.\n` +
      'افتح ⚙️ الإعدادات واضغط «جلب الموديلات» لاختيار موديل متاح.',
    )
  } else {
    showError(message + (stage ? ` (المرحلة: ${STAGE_LABEL[stage] ?? stage})` : ''))
  }

  // Offer a resume whenever the expensive part survived.
  if (result.canRetry && result.jobId) {
    showRetry(result)
  } else if (result.needsSettings || /unavailable|key|مفتاح|موديل/i.test(message)) {
    $('settings').open = true
  }
}

/* ------------------------------------------------------------ resume a job */

/** The job waiting to be retried, if any. */
let retryJob = null

function showRetry(result) {
  retryJob = { id: result.jobId, name: result.name ?? lastFileName }

  $('retryNote').textContent = result.needsSettings
    ? 'المشكلة في إعدادات المزود أو المفتاح. عدّلها ثم اضغط «أعد المحاولة».'
    : 'يمكنك تعديل الإعدادات ثم إعادة المحاولة، أو المحاولة كما هي.'

  // Say exactly what will be skipped, using the stages the server reported.
  const saved = result.saved ?? {}
  const kept = []
  if (saved.transcript) kept.push('التفريغ الصوتي')
  if (saved.analysis) kept.push('التحليل')
  if (saved.speech) kept.push('الشرح المسجّل')

  $('retryCard').querySelector('.retry-saved').innerHTML = kept.length
    ? `✅ <b>محفوظ ولن يُعاد:</b> ${kept.join('، ')}. ` +
      '«أعد المحاولة» يكمل من حيث توقّف.'
    : '✅ لن تحتاج إلى رفع المقطع مرة أخرى.'

  $('retryCard').hidden = false
  $('retryCard').scrollIntoView({ behavior: 'smooth', block: 'center' })
}

$('retryBtn').onclick = async () => {
  if (!retryJob) return
  const btn = $('retryBtn')
  btn.disabled = true
  btn.textContent = 'جارٍ الإعادة…'
  await runJob({ jobId: retryJob.id, name: retryJob.name })
  btn.disabled = false
  btn.textContent = '🔄 أعد المحاولة'
}

$('retrySettings').onclick = () => {
  $('settings').open = true
  $('settings').scrollIntoView({ behavior: 'smooth', block: 'start' })
  $('retryCard').hidden = true
}

$('retryCancel').onclick = () => {
  $('retryCard').hidden = true
  retryJob = null
  resetUpload()
}

function setStage(stage, detail, progress) {
  $('runStage').textContent = STAGE_LABEL[stage] ?? stage
  $('runDetail').textContent = detail ?? ''
  if (progress !== undefined) $('bar').style.width = progress + '%'
}

/**
 * Show the questions the pipeline paused on.
 *
 * In fixed mode the questions are already rendered and prefilled from the
 * brief, so this is a single button press. In AI mode the questions were just
 * written for this recording and must be rendered now.
 */
function showInterview(questions) {
  if (questions?.length) {
    const answers = {}
    $('questionBox').innerHTML = questions.map(q => questionHtml(q, answers[q.id])).join('')
    $('interviewHint').textContent = 'أسئلة مكتوبة خصيصاً لهذا المقطع.'
    $('interviewState').textContent = 'الذكاء ينتظر إجاباتك'
  }

  $('run').hidden = true
  $('liveBox').hidden = true
  clearInterval(liveTimer)
  // The drop area stays reachable: an abandoned interview must not trap the
  // learner out of the app. The pending job's transcript is already saved.
  $('uploadCard').querySelector('.drop').hidden = false
  $('interviewDone').hidden = false
  $('interviewCard').open = true
  $('interviewCard').scrollIntoView({ behavior: 'smooth', block: 'center' })
}

function resetUpload() {
  $('run').hidden = true
  $('uploadCard').querySelector('.drop').hidden = false
  $('bar').style.width = '0%'
  $('file').value = ''
  clearInterval(liveTimer)
}

function showResult(result) {
  state.job = result
  $('run').hidden = true
  $('resultCard').hidden = false

  $('player').src = `/file/${result.id}`
  $('download').href = `/file/${result.id}`
  $('download').download = result.downloadName ?? 'tutor.mp3'

  const saved = Math.max(0, Math.round((result.originalDuration ?? 0)))
  state.lastDuration = saved
  $('stats').innerHTML = `
    <div class="stat">المدة الأصلية <b>${fmt(saved)}</b></div>
    <div class="stat">بعد الشرح <b>${fmt(Math.round(result.duration ?? 0))}</b></div>
    <div class="stat">عدد الشروح <b>${result.cuts}</b></div>
    <div class="stat">اللغة <b>${result.language || '—'}</b></div>`

  $('cutCount').textContent = String((result.items ?? []).filter(i => !i.intro).length)
  $('lessons').innerHTML = (result.items ?? []).map(item => `
    <div class="lesson-item">
      <div class="lesson-time">${item.intro ? 'المقدمة' : `${fmt(item.start)} → ${fmt(item.end)}`}</div>
      ${item.quote ? `<div class="lesson-quote">«${esc(item.quote)}»</div>` : ''}
      ${item.explanation ? `<div class="lesson-expl">${esc(item.explanation)}</div>` : ''}
      ${item.words?.length ? `<div class="lesson-words">${item.words.map(w =>
        `<span class="word"><b>${esc(w.term)}</b>${w.meaning ? ' — ' + esc(w.meaning) : ''}</span>`).join('')}</div>` : ''}
    </div>`).join('')

  $('resultCard').scrollIntoView({ behavior: 'smooth', block: 'start' })
}

function fmt(seconds) {
  const s = Math.max(0, Math.round(seconds))
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

/* ----------------------------------------------------------------- events */

$('pick').onclick = () => $('file').click()
$('file').onchange = (e) => upload(e.target.files?.[0])

const drop = $('drop')
;['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, (e) => {
  e.preventDefault(); drop.classList.add('over')
}))
;['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, (e) => {
  e.preventDefault(); drop.classList.remove('over')
}))
drop.addEventListener('drop', (e) => upload(e.dataTransfer?.files?.[0]))

$('again').onclick = () => {
  $('resultCard').hidden = true
  resetUpload()
  window.scrollTo({ top: 0, behavior: 'smooth' })
}

/* settings persistence (debounced) */
let saveTimer
function save(patch) {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(async () => {
    const r = await api('/api/settings', { method: 'POST', body: patch })
    if (r.ok) state.settings = r.settings
  }, 400)
}

$('targetLanguage').onchange = (e) => save({ targetLanguage: e.target.value.trim() })
$('nativeLanguage').onchange = (e) => { save({ nativeLanguage: e.target.value.trim() }); loadVoices() }

/* ------------------------------------------------------------ interview */

/** The job waiting for answers, when the pipeline pauses to ask. */
let pendingJob = null
/** Cached fixed questions, so the interview renders before any upload. */
let fixedQuestions = []

/**
 * Prefill the two fields and saved answers.
 *
 * These are read fresh on every run server-side, so a save here cannot be
 * swallowed by a stale in-memory copy.
 */
async function loadBrief() {
  const r = await api('/api/brief')
  if (!r.ok) return
  const b = r.brief ?? {}
  state.brief = b
  $('briefWants').value = b.wants ?? ''
  $('briefAvoid').value = b.avoid ?? ''
  $('briefMode').value = b.mode === 'ai' ? 'ai' : 'fixed'
  renderQuestions()
  updateInterviewState()
}

/**
 * Show whether the intake is done, and keep the card out of the way once it is.
 *
 * A learner who has answered should not see a wall of questions on every visit,
 * so the card collapses. A first-timer sees it open, since nothing sensible can
 * be taught until they describe themselves.
 */
function updateInterviewState() {
  const count = Object.keys(state.brief?.answers ?? {}).length
  const el = $('interviewState')
  if (count > 0) {
    el.textContent = `✓ ${count} إجابات محفوظة`
    $('interviewCard').open = false
  } else {
    el.textContent = 'لم تُجب بعد'
    $('interviewCard').open = true
  }
}

/** The intake questions to render now — fixed ones need no model call. */
async function renderQuestions() {
  if (!fixedQuestions.length) {
    const r = await api('/api/questions')
    if (r.ok) fixedQuestions = r.questions ?? []
  }
  const answers = state.brief?.answers ?? {}
  $('questionBox').innerHTML = fixedQuestions.map(q => questionHtml(q, answers[q.id])).join('')
  $('briefMode').dispatchEvent(new Event('change'))
}

/**
 * One question as HTML. 'choices' is a multi-select; 'choice' is one; 'text'
 * is the learner's own words. Every answer is saved as it is typed.
 */
function questionHtml(q, saved) {
  const cls = `q ${q.type === 'text' ? 'q-text' : 'q-choice'}`
  if (q.type === 'text') {
    return `<label class="${cls}">
      <span class="q-text-label">${esc(q.text)}</span>
      <textarea data-q="${esc(q.id)}" rows="2" placeholder="${esc(q.placeholder ?? '')}">${esc(saved ?? '')}</textarea>
    </label>`
  }
  const opts = (q.options ?? []).map(o => {
    const on = Array.isArray(saved) ? saved.includes(o) : saved === o
    return `<label class="q-opt">
      <input type="${q.type === 'choices' ? 'checkbox' : 'radio'}" name="q-${esc(q.id)}" data-q="${esc(q.id)}" value="${esc(o)}" ${on ? 'checked' : ''} />
      <span>${esc(o)}</span>
    </label>`
  }).join('')
  return `<div class="${cls}">
    <span class="q-text-label">${esc(q.text)}</span>
    <div class="q-opts">${opts}</div>
  </div>`
}

/** Collect the current answers from the rendered questions. */
function collectAnswers() {
  const out = {}
  const box = $('questionBox')
  if (!box) return out
  box.querySelectorAll('[data-q]').forEach(el => {
    const id = el.dataset.q
    if (el.type === 'checkbox') {
      out[id] = out[id] ?? []
      if (el.checked) out[id].push(el.value)
    } else if (el.type === 'radio') {
      if (el.checked) out[id] = el.value
    } else {
      out[id] = el.value.trim()
    }
  })
  // An empty checkbox group should not be stored as an empty array key.
  for (const [k, v] of Object.entries(out)) {
    if (Array.isArray(v) && v.length === 0) delete out[k]
  }
  return out
}

/** Save the two free-text fields; debounced so typing does not hit the disk. */
let briefTimer
function saveBriefDebounced(patch) {
  clearTimeout(briefTimer)
  briefTimer = setTimeout(() => api('/api/brief', { method: 'POST', body: patch }), 500)
}

$('briefWants').oninput = (e) => saveBriefDebounced({ wants: e.target.value })
$('briefAvoid').oninput = (e) => saveBriefDebounced({ avoid: e.target.value })

$('briefMode').onchange = (e) => {
  const ai = e.target.value === 'ai'
  saveBriefDebounced({ mode: ai ? 'ai' : 'fixed' })
  $('interviewHint').textContent = ai
    ? 'بعد قراءة الصوت، سأكتب لك أسئلة على هذا المقطع تحديداً.'
    : 'نفس الأسئلة في كل مرة — تجاوبها مرة وحدة وتتحفظ.'
}

// Save an answer the moment it is given, so a crash never loses it.
$('questionBox').onchange = () => {
  saveBriefDebounced({ answers: collectAnswers() })
}
$('questionBox').oninput = (e) => {
  if (e.target.matches('textarea')) saveBriefDebounced({ answers: collectAnswers() })
}

$('interviewDone').onclick = async () => {
  const btn = $('interviewDone')
  btn.disabled = true
  btn.textContent = 'جارٍ المتابعة…'

  // Send the answers for THIS job, then the pipeline resumes from the transcript.
  const answers = collectAnswers()
  const wants = $('briefWants').value.trim()
  const avoid = $('briefAvoid').value.trim()

  await api('/api/brief', { method: 'POST', body: { wants, avoid, mode: $('briefMode').value } })

  // No pending job means the learner filled the intake outside a run; the card
  // just folds away and the next upload uses these answers.
  if (!pendingJob) {
    btn.disabled = false
    btn.textContent = 'ابدأ الشرح ▶'
    btn.hidden = true
    state.brief = { ...(state.brief ?? {}), wants, avoid, answers }
    updateInterviewState()
    return
  }

  // The resume runs the whole rest of the pipeline, which is minutes of work.
  // Show the live box again so the wait is not a frozen button.
  state.busy = true
  $('interviewCard').open = false
  $('uploadCard').querySelector('.drop').hidden = true
  $('run').hidden = false
  $('liveBox').hidden = false
  setStage('analyze', `«${pendingJob.name}» — متابعة بعد إجاباتك`, 40)
  liveReset()
  liveAppend('start', `استئناف «${pendingJob.name}»`)

  try {
    var res = await api(`/api/answer?jobId=${encodeURIComponent(pendingJob.id)}`, {
      method: 'POST', body: { answers },
    })
  } finally {
    state.busy = false
  }

  btn.disabled = false
  btn.textContent = 'ابدأ الشرح ▶'
  btn.hidden = true
  state.brief = { ...(state.brief ?? {}), wants, avoid, answers }
  updateInterviewState()

  if (!res.ok) {
    liveAppend('error', res.message ?? 'فشل', 'error')
    clearInterval(liveTimer)
    showFailure(res)
    return
  }
  pendingJob = null
  showResult(res)
}
$('provider').onchange = (e) => save({ analysis: { provider: e.target.value.trim() } })
$('model').onchange = (e) => save({ analysis: { model: e.target.value.trim() } })
$('replayPassage').onchange = (e) => save({ replayPassage: e.target.checked })
$('voice').onchange = (e) => save({ voice: e.target.value })
$('speechBase').onchange = (e) => save({ speech: { baseURL: e.target.value.trim() } })

$('speechEngine').onchange = (e) => {
  $('providerSpeech').hidden = e.target.value !== 'provider'
  save({ speechEngine: e.target.value })
}

$('analysisKey').onchange = async (e) => {
  const v = e.target.value.trim()
  if (!v) return
  const r = await api('/api/secrets', { method: 'POST', body: { analysisApiKey: v } })
  if (r.ok) { updateKeyHints(r.secrets); e.target.value = '' }
}

$('speechKey').onchange = async (e) => {
  const v = e.target.value.trim()
  if (!v) return
  const r = await api('/api/secrets', { method: 'POST', body: { speechApiKey: v } })
  if (r.ok) { updateKeyHints(r.secrets); e.target.value = '' }
}

/* ---------------------------------------------------- model chooser + live */

/** Models returned by the last fetch, kept so the list can be searched. */
let fetchedModels = []
/** The provider URL the current list came from. */
let fetchedFrom = ''

$('fetchModels').onclick = async (e) => {
  const btn = e.currentTarget
  const original = btn.textContent
  btn.textContent = 'جارٍ الجلب…'
  btn.disabled = true
  clearError()

  const baseURL = $('provider').value.trim()
  const apiKey = $('analysisKey').value.trim()

  const r = await api('/api/models', { method: 'POST', body: { baseURL, apiKey } })
  btn.textContent = original
  btn.disabled = false

  if (!r.ok) {
    showError(`تعذّر جلب الموديلات: ${r.message}`)
    $('modelHint').textContent = 'تحقق من العنوان والمفتاح.'
    return
  }

  fetchedModels = r.models ?? []
  fetchedFrom = baseURL
  $('modelHint').textContent = `تم جلب ${fetchedModels.length} موديل من ${baseURL}. اختر واحداً من القائمة.`
  renderModelChooser('')
  $('modelBox').hidden = false
  $('modelSearch').value = ''
  $('modelSearch').focus()
}

/** Render the fetched list as a clickable chooser. */
function renderModelChooser(query) {
  const q = String(query ?? '').trim().toLowerCase()
  const shown = q ? fetchedModels.filter(m => m.toLowerCase().includes(q)) : fetchedModels

  $('modelBoxCount').textContent = q
    ? `${shown.length} من ${fetchedModels.length}`
    : `${fetchedModels.length} موديل`

  if (shown.length === 0) {
    $('modelListBody').innerHTML = '<div class="empty">لا يوجد موديل بهذا الاسم.</div>'
    return
  }

  const current = $('model').value.trim()
  // Show the most plausible teaching models first: cheap, fast, general.
  const preferred = /(flash|mini|haiku|small|lite|turbo|free)/i
  const sorted = [...shown].sort((a, b) => {
    if (a === current) return -1
    if (b === current) return 1
    return Number(preferred.test(b)) - Number(preferred.test(a))
  })

  $('modelListBody').innerHTML = sorted.map(m => `
    <div class="mrow ${m === current ? 'is-active' : ''}" data-model="${esc(m)}">
      <span class="mid">${esc(m)}</span>
      <span class="mpick">${m === current ? '✓ المختار' : 'اختيار'}</span>
    </div>`).join('')

  $('modelListBody').querySelectorAll('[data-model]').forEach(row => {
    row.onclick = () => chooseModel(row.dataset.model)
  })
}

function chooseModel(model) {
  $('model').value = model
  save({ analysis: { model } })
  $('modelBox').hidden = true
  $('modelHint').textContent = `تم اختيار: ${model}`
  showModelCurrent()
  clearError()
}

function showModelCurrent() {
  const model = $('model').value.trim()
  const provider = $('provider').value.trim()
  $('modelCurrent').textContent = model
    ? `الموديل الحالي: ${model}${provider ? ' — ' + provider : ''}`
    : ''
}

$('modelSearch').oninput = (e) => renderModelChooser(e.target.value)
$('modelClose').onclick = () => { $('modelBox').hidden = true }
$('model').onchange = showModelCurrent

/* --------------------------------------------- provider / key consistency */

/** Base URLs for the services we can recognise from a key's shape. */
const OWNER_URL = {
  openrouter: 'https://openrouter.ai/api/v1',
  openai: 'https://api.openai.com/v1',
  google: 'https://generativelanguage.googleapis.com/v1beta/openai',
  anthropic: 'https://api.anthropic.com/v1',
  groq: 'https://api.groq.com/openai/v1',
  xai: 'https://api.x.ai/v1',
}

const OWNER_LABEL = {
  openrouter: 'OpenRouter',
  openai: 'OpenAI',
  google: 'Google AI Studio',
  anthropic: 'Anthropic',
  groq: 'Groq',
  xai: 'xAI',
}

/**
 * Say which service the typed key belongs to, and offer to fix the URL.
 *
 * Pasting a Google key into the OpenRouter field is the single most common
 * setup mistake, and it surfaces as a misleading "model unavailable" error.
 */
function checkProviderKey() {
  const key = $('analysisKey').value.trim()
  const url = $('provider').value.trim()

  // Discover the key owner without sending the key anywhere.
  const owner = detectOwner(key)
  const urlOwner = detectUrlOwner(url)
  const note = $('keyOwner')

  if (!key) { note.textContent = ''; note.className = 'hint'; return }
  if (!owner) { note.textContent = ''; note.className = 'hint'; return }

  if (urlOwner && owner !== urlOwner && OWNER_URL[owner]) {
    note.textContent = `🔎 يبدو أنه مفتاح ${OWNER_LABEL[owner]} وأنت تستخدم عنوان ${OWNER_LABEL[urlOwner] ?? urlOwner}. ` +
      'إن فشل الطلب، اضغط «اكتشف تلقائياً».'
    note.className = 'hint warn'
    return
  }

  note.textContent = `المفتاح يبدو من ${OWNER_LABEL[owner] ?? owner}.`
  note.className = 'hint ok'
}

/** Client-side key shape detection. Only a hint — the server tests for real. */
function detectOwner(key) {
  const k = String(key ?? '').trim()
  if (!k) return null
  if (k.startsWith('sk-or-v1-')) return 'openrouter'
  if (k.startsWith('sk-ant-')) return 'anthropic'
  if (k.startsWith('sk-proj-')) return 'openai'
  if (k.startsWith('gsk_')) return 'groq'
  if (k.startsWith('xai-')) return 'xai'
  if (k.startsWith('AIza') || k.startsWith('AQ.')) return 'google'
  return null
}

function detectUrlOwner(url) {
  const u = String(url ?? '').toLowerCase()
  if (!u) return null
  if (u.includes('openrouter.ai')) return 'openrouter'
  if (u.includes('anthropic.com')) return 'anthropic'
  if (u.includes('openai.com')) return 'openai'
  if (u.includes('generativelanguage.googleapis.com')) return 'google'
  if (u.includes('groq.com')) return 'groq'
  if (u.includes('x.ai')) return 'xai'
  return null
}

$('analysisKey').oninput = checkProviderKey
$('provider').oninput = checkProviderKey

$('autoProvider').onclick = async () => {
  const key = $('analysisKey').value.trim()
  if (!key) {
    showError('أدخل مفتاح الـAPI أولاً.')
    return
  }

  const btn = $('autoProvider')
  const original = btn.textContent
  btn.textContent = 'جارٍ البحث…'
  btn.disabled = true
  clearError()

  // Ask the server to try each known provider, since a key's shape alone is
  // not a reliable way to tell services apart.
  const r = await api('/api/detect-provider', { method: 'POST', body: { apiKey: key } })

  btn.textContent = original
  btn.disabled = false

  if (!r.ok) {
    showError(r.message)
    $('provider').value = ''
    return
  }

  $('provider').value = r.provider
  await save({ analysis: { provider: r.provider } })

  fetchedModels = r.models ?? []
  fetchedFrom = r.provider
  $('modelHint').textContent =
    `تعرّفت على المزود: ${OWNER_LABEL[r.owner] ?? r.owner} — ${fetchedModels.length} موديل. اختر واحداً.`
  renderModelChooser('')
  $('modelBox').hidden = false
  $('modelSearch').value = ''
  $('modelSearch').focus()
  checkProviderKey()
}

/* --------------------------------------------------------- live progress */

let liveTimer = null
let liveStarted = 0

function liveReset() {
  $('liveLog').innerHTML = ''
  $('liveElapsed').textContent = '0:00'
  liveStarted = Date.now()
  clearInterval(liveTimer)
  liveTimer = setInterval(() => {
    const s = Math.floor((Date.now() - liveStarted) / 1000)
    $('liveElapsed').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
  }, 1000)
}

function liveAppend(stage, detail, kind) {
  const li = document.createElement('li')
  if (kind) li.className = `is-${kind}`
  const at = Math.floor((Date.now() - liveStarted) / 1000)
  li.innerHTML = `<span class="lt">${Math.floor(at / 60)}:${String(at % 60).padStart(2, '0')}</span>` +
    `<span class="lm">${esc(liveLabel(stage, detail))}</span>`
  const log = $('liveLog')
  log.appendChild(li)
  log.scrollTop = log.scrollHeight
}

/** Turn a raw pipeline step into something a person reads. */
function liveLabel(stage, detail) {
  const map = {
    start: () => `استُلم الملف${detail ? ' — ' + detail : ''}`,
    transcribe: () => 'التفريغ الصوتي على جهازك',
    interview: () => detail || 'كتابة أسئلة على مقاس هذا المقطع',
    analyze: () => detail?.startsWith('Found') ? detail : 'البحث عن الجمل الصعبة',
    speak: () => detail || 'تسجيل الشرح',
    edit: () => detail || 'قص وتركيب الصوت',
    done: () => 'الملف جاهز',
    error: () => `خطأ: ${detail}`,
  }
  return (map[stage] ?? (() => `${stage}${detail ? ' — ' + detail : ''}`))()
}

/** Open the stream once and leave it open. */
function watchProgress() {
  try {
    const source = new EventSource('/api/progress')
    source.onmessage = (event) => {
      let msg
      try { msg = JSON.parse(event.data) } catch { return }
      if (msg.type === 'step') {
        const kind = msg.stage === 'error' ? 'error' : msg.stage === 'done' ? 'done' : null
        liveAppend(msg.stage, msg.detail, kind)
        const pct = { start: 2, transcribe: 35, interview: 45, analyze: 60, speak: 80, edit: 92, done: 100 }[msg.stage]
        if (pct !== undefined) $('bar').style.width = pct + '%'
        setStage(msg.stage, msg.detail, pct)
      } else if (msg.type === 'finish') {
        clearInterval(liveTimer)
      }
    }
    source.onerror = () => { /* the browser retries on its own */ }
  } catch { /* live view is optional */ }
}

boot()
watchProgress()
showModelCurrent()
