// ─── STATE ───────────────────────────────────────────────────────────────────
const state = {
  provider: 'openai',
  apiKey: '',
  baseUrl: '',
  model: '',
  connected: false,
  phase: 'story',
  messages: [],
  currentSessionId: null,
  sessions: [],
  activeTab: 'chat',
  rightPanelOpen: false,
  enabledModels: [],
  boardMedia: {},
  mediaShareEnabled: true,
  boardPlanIndex: null
}

// ─── WANGP MODELS REGISTRY ──────────────────────────────────────────────────
const WANGP_MODELS = [
  { id: 'z-image',    name: 'Z-Image (Turbo 6B / TwinFlow)',       type: 'image', desc: 'Keyframe images, character portraits, reference stills. Steps: 2-4, Guidance: 1.',              on: true },
  { id: 'ltx2',       name: 'LTX-2 2.3 22B (Distilled GGUF)',     type: 'video', desc: 'Text-to-video up to ~30s, 720p. Steps: 4-8, Guidance: 1.',                                     on: true },
  { id: 'vace',       name: 'Wan 2.1 VACE',                       type: 'video', desc: 'Face injection, inpainting, outpainting, background replacement. Needs control video + mask.',   on: false },
  { id: 'animate',    name: 'Wan 2.2 Animate',                    type: 'video', desc: 'Motion transfer, performer replacement, relighting. Pose video + MatAnyone mask.',               on: false },
  { id: 'lynx',       name: 'Lynx / Vace Lynx',                   type: 'video', desc: 'Identity-preserving face swap. Reference portraits + VACE pass.',                               on: false },
  { id: 'qwen',       name: 'Qwen Image Edit',                    type: 'edit',  desc: 'High-res image editing, inpainting. Instruction-style prompts (add/remove/replace).',            on: false },
  { id: 'multitalk',  name: 'MultiTalk / InfiniteTalk',           type: 'audio', desc: 'Multi-speaker lip-sync, long dialogue. Audio tracks per speaker.',                              on: false },
  { id: 'ovi',        name: 'Ovi 1.1',                            type: 'video', desc: 'Fast talking character videos 5-10s. 6-8GB VRAM, FastWan.',                                    on: false },
  { id: 'chatterbox', name: 'Chatterbox',                         type: 'audio', desc: 'Voice cloning, dubbing. Needs 10-15s clean voice sample.',                                     on: false }
]

function getDefaultEnabledModels() {
  return WANGP_MODELS.filter(m => m.on).map(m => m.id)
}

function getEnabledModelsList() {
  return WANGP_MODELS.filter(m => state.enabledModels.includes(m.id))
}

function hasEnabledType(type) {
  return getEnabledModelsList().some(m => m.type === type)
}

// ─── PLAN TOOL DEFINITION ────────────────────────────────────────────────────
function buildPlanTool() {
  const enabled = getEnabledModelsList()
  const hasImage = enabled.some(m => m.type === 'image')
  const hasVideo = enabled.some(m => m.type === 'video')
  const clipTypes = []
  if (hasImage) clipTypes.push('image')
  if (hasVideo) clipTypes.push('video')
  if (clipTypes.length === 0) clipTypes.push('video')

  return {
    name: 'create_production_plan',
    description: 'Output the complete WanGP video production plan as structured data. Call this when asked to generate prompts.',
    parameters: {
      type: 'object',
      required: ['title', 'clips'],
      properties: {
        title: { type: 'string', description: 'Title of the production' },
        clips: {
          type: 'array',
          items: {
            type: 'object',
            required: ['number', 'clip_type', 'model', 'prompt'],
            properties: {
              number:           { type: 'integer' },
              clip_type:        { type: 'string', enum: clipTypes, description: `ONLY use: ${clipTypes.join(', ')}. ${!hasImage ? 'No image model is enabled — do NOT create image clips.' : ''}` },
              model:            { type: 'string', description: 'Exact WanGP model name from the enabled list' },
              duration:         { type: 'string', description: '"Keyframe" for images, seconds for video e.g. "12s"' },
              prompt:           { type: 'string', description: 'Full prompt, English, single paragraph, no line breaks' },
              start_image_clip: { type: ['integer', 'null'], description: hasImage ? 'Clip number of an image clip to use as start image, or null' : 'Always null — no image model enabled' },
              end_image_clip:   { type: ['integer', 'null'], description: hasImage ? 'Clip number of an image clip to use as end image, or null' : 'Always null — no image model enabled' },
              notes:            { type: 'string', description: 'Workflow note for the human operator' }
            }
          }
        }
      }
    }
  }
}

// ─── SYSTEM PROMPT ───────────────────────────────────────────────────────────
function buildSystemPrompt() {
  const enabled = getEnabledModelsList()
  const modelsTable = enabled.map(m => `| ${m.name} | ${m.type} | ${m.desc} |`).join('\n')
  const hasImage = enabled.some(m => m.type === 'image')
  const hasVideo = enabled.some(m => m.type === 'video')

  let sys = `You are StoryDirector, the AI engine of DaProdCreazioni.
Your job: help users develop stories and plan video productions for WanGP.

## CRITICAL BEHAVIOR RULE — READ THIS FIRST
You operate in TWO separate modes. The mode is determined by the system, NOT by the user asking.

### CHAT MODE (default — this is what you are in right now)
In chat mode you MUST:
- Discuss the story, characters, setting, mood, structure, scenes
- Ask clarifying questions if the idea is vague
- Propose scene breakdowns, shot lists, narrative arcs
- Discuss modifications to existing clips when media is loaded
- Answer questions about WanGP workflow

In chat mode you MUST NEVER:
- Write WanGP prompts or anything that looks like a prompt
- Write "CLIP 1", "CLIP 2" structured output
- Write prompt-like English descriptions of shots (e.g. "A tall figure walks through narrow streets, cinematic lighting, 8K")
- Include "24fps", "8K", "cinematic", camera directions, or any prompt language
- Output any structured production plan

If the user asks you to "generate prompts" or "create the plan" in chat, reply: "Click the green **Generate Prompts** button in the top bar — I'll create the full structured plan with all prompts ready to copy."

### PROMPT MODE (only when the system provides you with the create_production_plan tool)
Only in this mode do you generate the actual production plan using the tool. The prompt rules below apply ONLY in this mode.

## Enabled WanGP Models

| Model | Type | Description |
|-------|------|-------------|
${modelsTable}

Use ONLY models from this list.`

  // Critical: tell the AI what types are available
  if (!hasImage && hasVideo) {
    sys += `

## IMPORTANT — NO IMAGE MODEL ENABLED
The user has ONLY video models enabled. You must NOT create any image clips.
ALL clips must be video clips. Do NOT use start_image_clip or end_image_clip (set them to null).
If the workflow would benefit from keyframe images, mention this in the notes field as a suggestion, but generate only video clips.`
  } else if (hasImage && !hasVideo) {
    sys += `

## IMPORTANT — NO VIDEO MODEL ENABLED
The user has ONLY image models enabled. You must NOT create any video clips.
ALL clips must be image clips with duration "Keyframe".`
  } else if (hasImage && hasVideo) {
    sys += `

## Workflow Strategy
Create keyframe images FIRST using image models, then reference them as start_image_clip in video clips.
This ensures visual consistency across the production. Each video clip should reference which keyframe image to use as start frame.`
  }

  sys += `

## Prompt Rules (ONLY for create_production_plan tool calls)
- Image models: describe the static image — subject, pose, background, lighting, style
- Video models: describe motion, action, camera movement
- FORBIDDEN in prompts: "24fps", "fps", framerate mentions of any kind. WanGP sets framerate automatically. NEVER EVER write 24fps or any fps value.
- Every prompt ends with exactly one period at the very end. No periods mid-sentence.
- Dialogue, text on screen, or audio content goes in double quotes: a man says "attento quella è pericolosa" while running
- Repeat the full character description in every prompt featuring that character
- English only. Single paragraph. No line breaks.

## Start/End Image Rules
- ONE start image max, optionally ONE end image per video clip
- Image clips: duration = "Keyframe"
- Keyframes first, then video clips in scene order
- The "notes" field should contain clear workflow instructions for the human operator`

  // Include board media status (only if sharing toggle is on)
  if (state.mediaShareEnabled) {
    const mediaClips = Object.keys(state.boardMedia).map(Number).sort((a, b) => a - b)
    if (mediaClips.length > 0) {
      const latestPlan = getLatestPlan()
      const mediaDetails = mediaClips.map(n => {
        const m = state.boardMedia[n]
        const clip = latestPlan?.clips?.find(c => c.number === n)
        return `- CLIP ${n}: ${m.type} ${clip ? '(' + clip.model + ')' : 'loaded'}`
      }).join('\n')
      sys += `\n\n## Media on Board\nThe user has loaded these media files into the board:\n${mediaDetails}\n\nYou can reference these clips when discussing changes. If the user asks to modify a clip, suggest new prompt text or explain what to change in WanGP.\n`
    }
  }

  return sys
}

// ─── PROVIDERS ────────────────────────────────────────────────────────────────
const PROVIDERS = {
  openai:       { name: 'OpenAI',     baseUrl: 'https://api.openai.com/v1',      models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo'],                  needsKey: true },
  anthropic:    { name: 'Anthropic',   baseUrl: 'https://api.anthropic.com/v1',   models: ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'], needsKey: true },
  groq:         { name: 'Groq',        baseUrl: 'https://api.groq.com/openai/v1', models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768'], needsKey: true },
  ollama_local: { name: 'Ollama Local',baseUrl: 'http://localhost:11434',          models: [],                                                         needsKey: false },
  ollama_cloud: { name: 'Ollama Cloud',baseUrl: 'https://ollama.com',             models: ['minimax-m2.7:cloud', 'nemotron-3-super:latest', 'gpt-oss:120b', 'llama3.3:70b'], needsKey: true },
  custom:       { name: 'Custom',      baseUrl: '',                               models: [],                                                         needsKey: false }
}

function onProviderChange() {
  const p = document.getElementById('providerSelect').value
  state.provider = p
  const cfg = PROVIDERS[p]
  document.getElementById('apiKeyField').classList.toggle('hidden', !cfg.needsKey)
  document.getElementById('baseUrlField').classList.toggle('hidden', p !== 'ollama_local' && p !== 'custom')
  if (p === 'ollama_local') document.getElementById('baseUrlInput').value = 'http://localhost:11434'
  const sel = document.getElementById('modelSelect')
  const custom = document.getElementById('modelCustom')
  if (cfg.models.length > 0) {
    sel.innerHTML = cfg.models.map(m => `<option value="${m}">${m}</option>`).join('')
    sel.classList.remove('hidden')
    custom.classList.add('hidden')
  } else {
    sel.classList.add('hidden')
    custom.classList.remove('hidden')
    custom.placeholder = p === 'ollama_local' ? 'llama3.1, mistral, qwen...' : 'model name...'
  }
}

async function connectProvider() {
  const p = state.provider
  const cfg = PROVIDERS[p]
  const dot = document.getElementById('statusDot')
  dot.className = 'status-dot'
  state.apiKey  = document.getElementById('apiKeyInput').value.trim()
  state.baseUrl = document.getElementById('baseUrlInput').value.trim() || cfg.baseUrl
  const sel = document.getElementById('modelSelect')
  const customInput = document.getElementById('modelCustom')
  state.model = sel.classList.contains('hidden') ? customInput.value.trim() : sel.value
  if (!state.model) { showNotif('Enter a model name', 'error'); return }
  if (cfg.needsKey && !state.apiKey) { showNotif('API Key required', 'error'); return }
  if (p === 'ollama_local') {
    try {
      const res = await window.api.fetchAI(`${state.baseUrl}/api/tags`, { method: 'GET', headers: {} })
      if (res.ok) {
        const data = JSON.parse(res.body)
        if (data.models && data.models.length > 0) {
          const names = data.models.map(m => m.name)
          sel.innerHTML = names.map(n => `<option value="${n}">${n}</option>`).join('')
          sel.classList.remove('hidden')
          customInput.classList.add('hidden')
          if (!state.model || !names.includes(state.model)) state.model = names[0]
          sel.value = state.model
        }
      }
    } catch (e) {}
  }
  state.connected = true
  dot.className = 'status-dot connected'
  document.getElementById('topbarModel').textContent = `${cfg.name} · ${state.model}`
  document.getElementById('sendBtn').disabled = false
  document.getElementById('genPromptsBtn').disabled = false
  saveSettings()
  showNotif(`Connected to ${cfg.name}`, 'success')
}

// ─── MARKDOWN RENDERER ───────────────────────────────────────────────────────
function renderMarkdown(text) {
  let html = escapeHtml(text)
  html = html.replace(/```[\w]*\n?([\s\S]*?)```/g, '<pre><code>$1</code></pre>')
  html = html.replace(/`([^`]+)`/g, '<code style="background:rgba(255,255,255,0.08);padding:1px 5px;border-radius:3px;font-size:0.9em">$1</code>')
  html = html.replace(/^---+$/gm, '<hr style="border:none;border-top:1px solid #333;margin:12px 0">')
  html = html.replace(/^### (.+)$/gm, '<h3 style="font-size:13px;font-weight:700;color:#b0a0e8;margin:10px 0 4px">$1</h3>')
  html = html.replace(/^## (.+)$/gm, '<h2 style="font-size:15px;font-weight:700;color:#c0b0f0;margin:12px 0 6px">$1</h2>')
  html = html.replace(/^# (.+)$/gm, '<h1 style="font-size:17px;font-weight:700;color:#d0c0ff;margin:14px 0 8px">$1</h1>')
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  html = html.replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
  html = html.replace(/(\|.+\|\n)+/g, (table) => {
    const rows = table.trim().split('\n')
    let out = '<table style="border-collapse:collapse;width:100%;font-size:12px;margin:8px 0">'
    rows.forEach((row, i) => {
      if (row.match(/^\|[-| ]+\|$/)) return
      const cells = row.split('|').filter((_, idx) => idx > 0 && idx < row.split('|').length - 1)
      const tag = i === 0 ? 'th' : 'td'
      const st = i === 0
        ? 'background:rgba(124,111,205,0.2);padding:5px 10px;text-align:left;font-weight:600;border:1px solid #333'
        : 'padding:4px 10px;border:1px solid #2a2a2a'
      out += '<tr>' + cells.map(c => `<${tag} style="${st}">${c.trim()}</${tag}>`).join('') + '</tr>'
    })
    return out + '</table>'
  })
  html = html.replace(/^[-*] (.+)$/gm, '<li style="margin:2px 0 2px 16px;list-style:disc">$1</li>')
  html = html.replace(/(<li.*<\/li>\n?)+/g, m => `<ul style="margin:6px 0">${m}</ul>`)
  html = html.replace(/^\d+\. (.+)$/gm, '<li style="margin:2px 0 2px 16px;list-style:decimal">$1</li>')
  html = html.replace(/\n\n/g, '</p><p style="margin:6px 0">')
  html = html.replace(/\n/g, '<br>')
  return `<p style="margin:0">${html}</p>`
}

// ─── PLAN RENDERER (JSON-based) ──────────────────────────────────────────────
window._planPrompts = []

function renderPlanFromJSON(planData) {
  window._planPrompts = []
  const clips = planData.clips || []
  let html = clips.map(c => renderClipCardJSON(c)).join('')

  const rows = clips.map(c => {
    const si = c.start_image_clip ? `CLIP ${c.start_image_clip}` : '—'
    const ei = c.end_image_clip   ? `CLIP ${c.end_image_clip}`   : '—'
    const dur = c.duration || (c.clip_type === 'image' ? 'Keyframe' : '—')
    return `| ${c.number} | ${c.clip_type === 'image' ? 'Image' : 'Video'} | ${c.model} | ${dur} | ${si} | ${ei} |`
  }).join('\n')

  html += `<div class="plan-section md" style="margin-top:12px">${renderMarkdown(
    `## Summary — ${clips.length} clips\n\n| # | Type | Model | Duration | Start | End |\n|---|------|-------|----------|-------|-----|\n${rows}`
  )}</div>`
  return html
}

function renderClipCardJSON(clip) {
  const isImage = clip.clip_type === 'image'
  const typeLabel = isImage ? 'Image' : 'Video'
  const typeIcon  = isImage ? '🖼' : '🎬'
  const dur = clip.duration || (isImage ? 'Keyframe' : '—')
  const si = clip.start_image_clip ? `→ Start Image: CLIP ${clip.start_image_clip}` : ''
  const ei = clip.end_image_clip   ? ` — End Image: CLIP ${clip.end_image_clip}` : ''
  const workflow = si ? (si + ei) : ''
  const idx = window._planPrompts.length
  window._planPrompts.push(clip.prompt || '')
  const modelShort = (clip.model || '').replace('(Turbo 6B / TwinFlow)', '').replace('(Distilled GGUF)', '').trim()

  return `<div class="clip-card">
    <div class="clip-card-header"><div class="clip-card-meta">
      <span class="clip-num">CLIP ${clip.number}</span>
      <span class="clip-badge ${isImage ? 'image' : 'video'}">${typeIcon} ${typeLabel}</span>
      ${clip.model ? `<span class="clip-model-tag">${escapeHtml(modelShort)}</span>` : ''}
      <span class="clip-duration-tag">${escapeHtml(dur)}</span>
    </div></div>
    ${workflow ? `<div class="clip-workflow">${escapeHtml(workflow)}</div>` : ''}
    <div class="clip-body">
      ${clip.prompt ? `<div class="clip-prompt-wrap">
        <div class="clip-prompt-label"><span>Prompt</span>
          <button class="copy-prompt-btn" onclick="copyClipPrompt(${idx}, this)">Copy Prompt</button>
        </div>
        <div class="clip-prompt-text">${escapeHtml(clip.prompt)}</div>
      </div>` : ''}
      ${clip.notes ? `<div class="clip-notes-row">${escapeHtml(clip.notes)}</div>` : ''}
    </div>
  </div>`
}

function copyClipPrompt(idx, btn) {
  const text = window._planPrompts[idx]
  if (!text) { showNotif('Nothing to copy', 'error'); return }
  navigator.clipboard.writeText(text).then(() => {
    btn.textContent = '✓ Copied!'; btn.classList.add('copied')
    const card = btn.closest('.clip-card') || btn.closest('.board-clip')
    if (card) card.classList.add('prompt-copied')
    setTimeout(() => { btn.textContent = 'Copied'; btn.classList.add('copied') }, 1800)
  }).catch(() => {
    fallbackCopy(text, btn)
    const card = btn.closest('.clip-card') || btn.closest('.board-clip')
    if (card) card.classList.add('prompt-copied')
  })
}

function fallbackCopy(text, btn) {
  const ta = document.createElement('textarea')
  ta.value = text; ta.style.cssText = 'position:fixed;opacity:0'
  document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta)
  if (btn) {
    btn.textContent = '✓ Copied!'; btn.classList.add('copied')
    setTimeout(() => { btn.textContent = 'Copy Prompt'; btn.classList.remove('copied') }, 1800)
  }
}

// Legacy text-plan fallback (old sessions)
function isProductionPlan(content) {
  return (content.match(/CLIP\s+\d+/gi) || []).length >= 2
}
function renderPlanLegacy(content) {
  window._planPrompts = []
  const parts = content.split(/\n(?=CLIP\s+\d+\b)/i)
  let html = ''
  for (const part of parts) {
    const t = part.trim()
    if (!t) continue
    if (/^CLIP\s+\d+/i.test(t)) {
      const endIdx = t.search(/\n(?=#{1,3}\s|\*\*Total|Total:|Summary)/i)
      html += renderClipLegacy(endIdx > 0 ? t.slice(0, endIdx) : t)
      if (endIdx > 0) html += `<div class="plan-section md">${renderMarkdown(t.slice(endIdx).trim())}</div>`
    } else if (t.length > 10) {
      html += `<div class="plan-section md">${renderMarkdown(t)}</div>`
    }
  }
  return html || `<div class="plan-section md">${renderMarkdown(content)}</div>`
}
function renderClipLegacy(block) {
  const headerLine  = block.split('\n')[0] || ''
  const num   = (headerLine.match(/CLIP\s+(\d+)/i) || [])[1] || '?'
  const durM  = headerLine.match(/(\d+)\s*s\b/i)
  const model = (block.match(/^MODEL:\s*(.+)$/im) || [])[1]?.trim() || ''
  const typeRaw = (block.match(/^TYPE:\s*(.+)$/im) || [])[1]?.trim().toLowerCase() || ''
  const notes = (block.match(/^NOTES:\s*(.+)$/im) || [])[1]?.trim() || ''
  const isImage = typeRaw.includes('image') || /keyframe/i.test(headerLine) || model.toLowerCase().includes('z-image')
  const duration = isImage ? 'Keyframe' : (durM && parseInt(durM[1]) > 0 ? durM[1] + 's' : '—')
  let promptText = ''
  const pm = block.match(/^PROMPT:\s*\n([\s\S]*?)(?=\n(?:NOTES|MODEL|TYPE):|\s*$)/im)
  if (pm) promptText = pm[1].trim()
  const idx = window._planPrompts.length
  window._planPrompts.push(promptText)
  return `<div class="clip-card">
    <div class="clip-card-header"><div class="clip-card-meta">
      <span class="clip-num">CLIP ${num}</span>
      <span class="clip-badge ${isImage ? 'image' : 'video'}">${isImage ? '🖼 Image' : '🎬 Video'}</span>
      ${model ? `<span class="clip-model-tag">${escapeHtml(model)}</span>` : ''}
      <span class="clip-duration-tag">${duration}</span>
    </div></div>
    <div class="clip-body">
      ${promptText ? `<div class="clip-prompt-wrap">
        <div class="clip-prompt-label"><span>Prompt</span>
          <button class="copy-prompt-btn" onclick="copyClipPrompt(${idx}, this)">Copy Prompt</button>
        </div>
        <div class="clip-prompt-text">${escapeHtml(promptText)}</div>
      </div>` : ''}
    </div></div>`
}

// ─── SESSIONS (= Projects) ──────────────────────────────────────────────────
function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}

async function createNewSession(title) {
  const id = generateId()
  const sessionTitle = title || 'New Project'
  const session = {
    id,
    title: sessionTitle,
    messages: [],
    phase: 'story',
    enabledModels: [...state.enabledModels],
    timestamp: Date.now()
  }
  state.sessions.unshift(session)
  state.currentSessionId = id
  state.messages = session.messages
  state.phase = 'story'
  state.boardMedia = {}
  state.boardPlanIndex = null

  // Initialize project folder with template files
  await window.api.initProject(id, sessionTitle)

  saveSessions()
  renderSessionList()
  updateOpenFolderBtn()
  return session
}

async function loadSession(id) {
  const session = state.sessions.find(s => s.id === id)
  if (!session) return
  state.currentSessionId = id
  state.messages = session.messages
  state.phase = session.phase || 'story'
  state.enabledModels = session.enabledModels || getDefaultEnabledModels()
  state.boardMedia = {}
  state.boardPlanIndex = null

  updatePhaseBadge()
  renderModelCards()
  updateOpenFolderBtn()

  const chat = document.getElementById('chatArea')
  chat.innerHTML = ''
  if (session.messages.length === 0) {
    showWelcome()
  } else {
    session.messages.forEach(m => {
      if (m.isPlan && m.planData) renderMessage('assistant', m.content, true, m.planData)
      else if (m.role === 'assistant' && isProductionPlan(m.content)) renderMessage('assistant', m.content, true, null)
      else renderMessage(m.role, m.content)
    })
  }
  renderSessionList()
  await loadBoardMedia()
}

function updateCurrentSession() {
  const session = state.sessions.find(s => s.id === state.currentSessionId)
  if (!session) return
  session.messages = state.messages
  session.phase = state.phase
  session.enabledModels = state.enabledModels
  if (session.title === 'New Project' && state.messages.length > 0) {
    const first = state.messages.find(m => m.role === 'user')
    if (first) session.title = first.content.slice(0, 40) + (first.content.length > 40 ? '…' : '')
  }
  session.timestamp = Date.now()
  saveSessions()
  renderSessionList()
}

function deleteSession(id, e) {
  e.stopPropagation()
  state.sessions = state.sessions.filter(s => s.id !== id)
  if (state.currentSessionId === id) {
    state.sessions.length > 0 ? loadSession(state.sessions[0].id) : startFreshChat()
  }
  saveSessions()
  renderSessionList()
}

function renderSessionList() {
  const list = document.getElementById('sessionList')
  if (!list) return
  if (state.sessions.length === 0) {
    list.innerHTML = '<div style="font-size:12px;color:var(--text2);padding:4px 8px">No projects yet</div>'
    return
  }
  list.innerHTML = state.sessions.map(s => {
    const active = s.id === state.currentSessionId
    const date = new Date(s.timestamp).toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit' })
    const planCount = (s.messages || []).filter(m => m.isPlan).length
    const icon = planCount > 0 ? '🎬' : '📝'
    return `<div class="session-item ${active ? 'active' : ''}" onclick="loadSession('${s.id}')">
      <span class="session-phase">${icon}</span>
      <div class="session-info">
        <div class="session-title">${escapeHtml(s.title)}</div>
        <div class="session-date">${date} · ${s.messages.length} msg${planCount > 0 ? ` · ${planCount} plan${planCount > 1 ? 's' : ''}` : ''}</div>
      </div>
      <button class="session-del" onclick="deleteSession('${s.id}', event)" title="Delete">&times;</button>
    </div>`
  }).join('')
}

async function saveSessions() {
  const settings = await window.api.loadSettings()
  settings.sessions = state.sessions
  settings.currentSessionId = state.currentSessionId
  await window.api.saveSettings(settings)
}

function updateOpenFolderBtn() {
  const btn = document.getElementById('openFolderBtn')
  if (btn) btn.classList.toggle('hidden', !state.currentSessionId)
}

async function openCurrentProjectFolder() {
  if (state.currentSessionId) {
    await window.api.openProjectFolder(state.currentSessionId)
  }
}

// ─── CHAT ─────────────────────────────────────────────────────────────────────
function showWelcome() {
  document.getElementById('chatArea').innerHTML = `
    <div class="welcome" id="welcomeScreen">
      <div style="font-size:48px">🎬</div>
      <h2>DaProdCreazioni</h2>
      <p>Connect an AI model on the left, then describe your story idea.<br>
      Each chat creates a project folder with all your files.</p>
      <div style="display:flex;gap:12px;margin-top:16px;flex-wrap:wrap;justify-content:center">
        <div style="background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:10px 14px;text-align:center;min-width:120px">
          <div style="font-size:20px;margin-bottom:4px">💬</div>
          <div style="font-size:11px;font-weight:600;color:var(--text)">Chat</div>
          <div style="font-size:10px;color:var(--text2)">Develop story</div>
        </div>
        <div style="background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:10px 14px;text-align:center;min-width:120px">
          <div style="font-size:20px;margin-bottom:4px">📋</div>
          <div style="font-size:11px;font-weight:600;color:var(--text)">Board</div>
          <div style="font-size:10px;color:var(--text2)">Manage clips & media</div>
        </div>
        <div style="background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:10px 14px;text-align:center;min-width:120px">
          <div style="font-size:20px;margin-bottom:4px">🔧</div>
          <div style="font-size:11px;font-weight:600;color:var(--text)">Models</div>
          <div style="font-size:10px;color:var(--text2)">Toggle WanGP models</div>
        </div>
      </div>
    </div>`
}

function hideWelcome() {
  const w = document.getElementById('welcomeScreen')
  if (w) w.remove()
}

function addMessage(role, content, isPlan, planData) {
  const msg = { role, content }
  if (isPlan) { msg.isPlan = true; msg.planData = planData }
  state.messages.push(msg)
  renderMessage(role, content, isPlan, planData)
  updateCurrentSession()
  // Auto-refresh board when a new plan is generated
  if (isPlan && planData) {
    state.boardPlanIndex = null // reset to show latest plan
    if (state.activeTab === 'board') renderBoard()
    // Save plan to project folder
    saveProjectPlan(planData)
  }
}

async function saveProjectPlan(planData) {
  if (!state.currentSessionId) return
  try {
    const proj = await window.api.readProject(state.currentSessionId)
    if (proj) {
      if (!proj.plans) proj.plans = []
      proj.plans.push({
        title: planData.title,
        clips: planData.clips.length,
        generated: new Date().toISOString()
      })
      proj.title = planData.title || proj.title
      await window.api.writeProject(state.currentSessionId, proj)
    }
  } catch (e) {}
}

function renderMessage(role, content, isPlan, planData) {
  const chat = document.getElementById('chatArea')
  hideWelcome()

  if (isPlan && planData) {
    const div = document.createElement('div')
    div.className = 'production-plan'

    const allText = (planData.clips || []).map(c =>
      `CLIP ${c.number} — ${c.duration || (c.clip_type === 'image' ? 'Keyframe' : '')}\nMODEL: ${c.model}\n\nPROMPT:\n${c.prompt}\n${c.notes ? `\nNOTES: ${c.notes}\n` : ''}`
    ).join('\n---\n\n')

    const header = document.createElement('div')
    header.className = 'plan-header'
    header.innerHTML = `<span>🎬 ${escapeHtml(planData.title || 'Production Plan')} — ${(planData.clips || []).length} clips</span>`
    const copyAllBtn = document.createElement('button')
    copyAllBtn.className = 'copy-btn'
    copyAllBtn.textContent = 'Copy All Prompts'
    copyAllBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(allText)
        .then(() => { copyAllBtn.textContent = 'Copied!'; setTimeout(() => copyAllBtn.textContent = 'Copy All Prompts', 1800) })
        .catch(() => fallbackCopy(allText, null))
    })
    header.appendChild(copyAllBtn)
    div.appendChild(header)
    div.insertAdjacentHTML('beforeend', renderPlanFromJSON(planData))
    chat.appendChild(div)
  } else if (isPlan && !planData && isProductionPlan(content)) {
    const div = document.createElement('div')
    div.className = 'production-plan'
    const header = document.createElement('div')
    header.className = 'plan-header'
    header.innerHTML = '<span>Production Plan</span>'
    div.appendChild(header)
    div.insertAdjacentHTML('beforeend', renderPlanLegacy(content))
    chat.appendChild(div)
  } else {
    const div = document.createElement('div')
    div.className = `message ${role}`
    const avatar = role === 'user' ? '<div class="msg-avatar user-av">👤</div>' : '<div class="msg-avatar ai-av">🎬</div>'
    const bubble = role === 'user'
      ? `<div class="msg-bubble">${escapeHtml(content)}</div>`
      : `<div class="msg-bubble md">${renderMarkdown(content)}</div>`
    div.innerHTML = avatar + bubble
    chat.appendChild(div)
  }

  chat.scrollTop = chat.scrollHeight
}

function showThinking(label) {
  const chat = document.getElementById('chatArea')
  const div = document.createElement('div')
  div.className = 'message assistant'; div.id = 'thinking'
  div.innerHTML = `<div class="msg-avatar ai-av">🎬</div>
    <div class="msg-bubble"><div class="thinking-row">
      <div class="thinking"><span></span><span></span><span></span></div>
      <span class="thinking-label">${label || 'Generating...'}</span>
    </div></div>`
  chat.appendChild(div)
  chat.scrollTop = chat.scrollHeight
}

function removeThinking() {
  const t = document.getElementById('thinking')
  if (t) t.remove()
}

async function sendMessage() {
  const input = document.getElementById('userInput')
  const content = input.value.trim()
  if (!content || !state.connected) return
  input.value = ''; autoResize(input)
  if (!state.currentSessionId) await createNewSession()
  addMessage('user', content)
  document.getElementById('sendBtn').disabled = true
  showThinking('Thinking...')
  try {
    const reply = await callAI(buildConversationForAI())
    removeThinking()
    addMessage('assistant', reply)
  } catch (e) {
    removeThinking()
    addMessage('assistant', `Error: ${e.message}`)
  }
  document.getElementById('sendBtn').disabled = false
  document.getElementById('userInput').focus()
}

async function generatePrompts() {
  if (!state.connected) return
  if (!state.currentSessionId) await createNewSession()
  state.phase = 'prompts'
  updatePhaseBadge()

  const genInstruction = 'Now generate the complete WanGP production plan. Use the create_production_plan tool. Include ALL clips in scene order.'
  const contextMessages = [...buildConversationForAI(), { role: 'user', content: genInstruction }]

  addMessage('user', 'Generate the complete WanGP production plan.')
  document.getElementById('genPromptsBtn').disabled = true
  showThinking('Building production plan...')

  try {
    const planTool = buildPlanTool()
    const planData = await callAIWithTool(contextMessages, planTool)
    removeThinking()

    if (planData && planData.clips && planData.clips.length > 0) {
      addMessage('assistant', `Production plan: ${planData.title} — ${planData.clips.length} clips`, true, planData)
      showNotif(`Plan created: ${planData.clips.length} clips`, 'success')
    } else {
      showThinking('Generating (text fallback)...')
      const text = await callAI(contextMessages)
      removeThinking()
      if (isProductionPlan(text)) {
        addMessage('assistant', text, true, null)
        showNotif('Plan created (text mode)', 'success')
      } else {
        addMessage('assistant', text)
      }
    }
  } catch (e) {
    removeThinking()
    addMessage('assistant', `Error: ${e.message}`)
  }
  document.getElementById('genPromptsBtn').disabled = false
}

function buildConversationForAI() {
  return state.messages.map(m => {
    if (m.isPlan && m.planData)
      return { role: 'assistant', content: `I created the production plan "${m.planData.title}" with ${m.planData.clips.length} clips.` }
    return { role: m.role, content: m.content }
  })
}

function startFreshChat() {
  state.messages = []; state.phase = 'story'; state.currentSessionId = null; state.boardMedia = {}; state.boardPlanIndex = null
  updatePhaseBadge(); showWelcome(); renderSessionList(); updateOpenFolderBtn()
  switchTab('chat')
}

function updatePhaseBadge() {
  const badge = document.getElementById('phaseBadge')
  badge.className = state.phase === 'prompts' ? 'phase-badge phase-prompts' : 'phase-badge phase-story'
  badge.textContent = state.phase === 'prompts' ? 'Prompt Mode' : 'Story Mode'
}

// ─── AI CALLS ─────────────────────────────────────────────────────────────────
async function callAI(messages) {
  const sys = buildSystemPrompt()
  if (state.provider === 'anthropic') return callAnthropic(sys, messages)
  if (state.provider === 'ollama_local' || state.provider === 'ollama_cloud') return callOllama(sys, messages)
  return callOpenAI(sys, messages)
}

async function callAIWithTool(messages, planTool) {
  const sys = buildSystemPrompt()
  try {
    if (state.provider === 'anthropic') return await callAnthropicTool(sys, messages, planTool)
    if (state.provider === 'ollama_local' || state.provider === 'ollama_cloud') return await callOllamaTool(sys, messages, planTool)
    return await callOpenAITool(sys, messages, planTool)
  } catch (e) {
    console.warn('Tool call failed:', e.message)
    return null
  }
}

// OpenAI / Groq / Custom
async function callOpenAI(sys, messages) {
  const baseUrl = state.baseUrl || PROVIDERS[state.provider].baseUrl
  const headers = { 'Content-Type': 'application/json' }
  if (state.apiKey) headers['Authorization'] = `Bearer ${state.apiKey}`
  const res = await window.api.fetchAI(`${baseUrl}/chat/completions`, {
    method: 'POST', headers,
    body: JSON.stringify({ model: state.model, messages: [{ role: 'system', content: sys }, ...messages], temperature: 0.7, max_tokens: 4096 })
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.body.slice(0, 200)}`)
  return JSON.parse(res.body).choices[0].message.content
}

async function callOpenAITool(sys, messages, planTool) {
  const baseUrl = state.baseUrl || PROVIDERS[state.provider].baseUrl
  const headers = { 'Content-Type': 'application/json' }
  if (state.apiKey) headers['Authorization'] = `Bearer ${state.apiKey}`
  const res = await window.api.fetchAI(`${baseUrl}/chat/completions`, {
    method: 'POST', headers,
    body: JSON.stringify({
      model: state.model,
      messages: [{ role: 'system', content: sys }, ...messages],
      tools: [{ type: 'function', function: planTool }],
      tool_choice: { type: 'function', function: { name: planTool.name } },
      temperature: 0.7, max_tokens: 8192
    })
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.body.slice(0, 300)}`)
  const data = JSON.parse(res.body)
  const tc = data.choices?.[0]?.message?.tool_calls?.[0]
  if (!tc) return null
  return typeof tc.function.arguments === 'string' ? JSON.parse(tc.function.arguments) : tc.function.arguments
}

// Anthropic
async function callAnthropic(sys, messages) {
  const res = await window.api.fetchAI('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': state.apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: state.model, system: sys, messages, max_tokens: 4096 })
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.body.slice(0, 200)}`)
  return JSON.parse(res.body).content[0].text
}

async function callAnthropicTool(sys, messages, planTool) {
  const res = await window.api.fetchAI('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': state.apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: state.model, system: sys, messages, max_tokens: 8192,
      tools: [{ name: planTool.name, description: planTool.description, input_schema: planTool.parameters }],
      tool_choice: { type: 'tool', name: planTool.name }
    })
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.body.slice(0, 300)}`)
  const data = JSON.parse(res.body)
  const block = (data.content || []).find(b => b.type === 'tool_use' && b.name === planTool.name)
  return block ? block.input : null
}

// Ollama
async function callOllama(sys, messages) {
  const baseUrl = state.baseUrl || PROVIDERS[state.provider].baseUrl
  const headers = { 'Content-Type': 'application/json' }
  if (state.provider === 'ollama_cloud' && state.apiKey) headers['Authorization'] = `Bearer ${state.apiKey}`
  const res = await window.api.fetchAI(`${baseUrl}/api/chat`, {
    method: 'POST', headers,
    body: JSON.stringify({ model: state.model, messages: [{ role: 'system', content: sys }, ...messages], stream: false }),
    timeout: 300000
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.body.slice(0, 200)}`)
  return JSON.parse(res.body).message.content
}

async function callOllamaTool(sys, messages, planTool) {
  const baseUrl = state.baseUrl || PROVIDERS[state.provider].baseUrl
  const headers = { 'Content-Type': 'application/json' }
  if (state.provider === 'ollama_cloud' && state.apiKey) headers['Authorization'] = `Bearer ${state.apiKey}`
  const res = await window.api.fetchAI(`${baseUrl}/api/chat`, {
    method: 'POST', headers,
    body: JSON.stringify({
      model: state.model,
      messages: [{ role: 'system', content: sys }, ...messages],
      tools: [{ type: 'function', function: planTool }],
      stream: false
    }),
    timeout: 300000
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.body.slice(0, 300)}`)
  const data = JSON.parse(res.body)
  const tc = data.message?.tool_calls?.[0]
  if (!tc) return null
  return typeof tc.function.arguments === 'string' ? JSON.parse(tc.function.arguments) : tc.function.arguments
}

// ─── TAB SWITCHING ────────────────────────────────────────────────────────────
function switchTab(tab) {
  state.activeTab = tab
  document.getElementById('tabChat').classList.toggle('active', tab === 'chat')
  document.getElementById('tabBoard').classList.toggle('active', tab === 'board')
  document.getElementById('chatView').classList.toggle('hidden', tab !== 'chat')
  document.getElementById('boardView').classList.toggle('hidden', tab !== 'board')
  if (tab === 'board') renderBoard()
}

// ─── RIGHT PANEL — MODEL MANAGER ─────────────────────────────────────────────
function toggleRightPanel() {
  state.rightPanelOpen = !state.rightPanelOpen
  document.getElementById('rightPanel').classList.toggle('collapsed', !state.rightPanelOpen)
  document.getElementById('panelToggleBtn').classList.toggle('active', state.rightPanelOpen)
}

function renderModelCards() {
  const container = document.getElementById('modelCards')
  if (!container) return
  container.innerHTML = WANGP_MODELS.map(m => {
    const enabled = state.enabledModels.includes(m.id)
    const typeClass = m.type === 'image' ? 't-image' : m.type === 'video' ? 't-video' : m.type === 'audio' ? 't-audio' : 't-edit'
    return `<div class="model-card ${enabled ? 'enabled' : ''}" id="mc_${m.id}">
      <div class="model-card-info">
        <div class="model-card-name">${escapeHtml(m.name)}</div>
        <div class="model-card-desc">${escapeHtml(m.desc)}</div>
        <span class="model-card-type ${typeClass}">${m.type}</span>
      </div>
      <label class="toggle">
        <input type="checkbox" ${enabled ? 'checked' : ''} onchange="toggleModel('${m.id}', this.checked)">
        <div class="toggle-track"></div>
      </label>
    </div>`
  }).join('')
}

function toggleModel(modelId, enabled) {
  if (enabled && !state.enabledModels.includes(modelId)) {
    state.enabledModels.push(modelId)
  } else if (!enabled) {
    state.enabledModels = state.enabledModels.filter(id => id !== modelId)
  }
  const card = document.getElementById(`mc_${modelId}`)
  if (card) card.classList.toggle('enabled', enabled)
  updateCurrentSession()
}

// ─── BOARD VIEW ───────────────────────────────────────────────────────────────
function getAllPlans() {
  return state.messages.filter(m => m.isPlan && m.planData).map((m, i) => ({ index: i, planData: m.planData }))
}

function getLatestPlan() {
  const msg = [...state.messages].reverse().find(m => m.isPlan && m.planData)
  return msg ? msg.planData : null
}

function getActiveBoardPlan() {
  const plans = getAllPlans()
  if (plans.length === 0) return null
  if (state.boardPlanIndex !== null && state.boardPlanIndex < plans.length) return plans[state.boardPlanIndex].planData
  return plans[plans.length - 1].planData
}

function renderBoard() {
  const container = document.getElementById('boardContent')
  const plans = getAllPlans()
  const plan = getActiveBoardPlan()

  if (!plan) {
    container.innerHTML = `<div class="board-empty">
      <div style="font-size:48px">📋</div>
      <h3>No Production Plan Yet</h3>
      <p style="color:var(--text2);font-size:13px;max-width:400px">
        Go to the Chat tab, describe your story, and click "Generate Prompts" to create a plan.<br>
        Then come back here to manage your clips and drag & drop media files.
      </p>
    </div>`
    return
  }

  // Plan selector (if multiple plans)
  let planSelector = ''
  if (plans.length > 1) {
    const activeIdx = state.boardPlanIndex !== null ? state.boardPlanIndex : plans.length - 1
    const opts = plans.map((p, i) =>
      `<option value="${i}" ${i === activeIdx ? 'selected' : ''}>Plan ${i + 1}: ${escapeHtml((p.planData.title || 'Untitled').slice(0, 30))} (${p.planData.clips.length} clips)</option>`
    ).join('')
    planSelector = `<select class="plan-selector" onchange="switchBoardPlan(parseInt(this.value))">${opts}</select>`
  }

  // Media share toggle
  const toggleChecked = state.mediaShareEnabled ? 'checked' : ''
  const shareToggle = `<label class="media-toggle-label">
    <input type="checkbox" ${toggleChecked} onchange="toggleMediaShare(this.checked)">
    Share media with AI
  </label>`

  let html = `<div class="board-toolbar">
    <div>
      <h2>${escapeHtml(plan.title || 'Production Plan')}</h2>
      <span style="font-size:12px;color:var(--text2)">${plan.clips.length} clips · drag & drop images and videos</span>
    </div>
    <div class="board-toolbar-right">
      ${shareToggle}
      ${planSelector}
    </div>
  </div>
  <div class="board-grid">`

  for (const clip of plan.clips) {
    const isImage = clip.clip_type === 'image'
    const media = state.boardMedia[clip.number]
    const hasMedia = !!media
    const si = clip.start_image_clip ? `Start: CLIP ${clip.start_image_clip}` : ''
    const ei = clip.end_image_clip ? `End: CLIP ${clip.end_image_clip}` : ''
    const wf = [si, ei].filter(Boolean).join(' · ')
    const dur = clip.duration || (isImage ? 'Keyframe' : '—')
    const modelShort = (clip.model || '').replace('(Turbo 6B / TwinFlow)', '').replace('(Distilled GGUF)', '').trim()

    let mediaHtml = ''
    if (hasMedia && media.type === 'video') {
      mediaHtml = `<video src="${escapeHtml(media.path || media.dataUrl)}" style="width:100%;height:auto;max-height:280px;object-fit:cover;display:block" muted></video>
        <div class="media-type-badge">VIDEO</div>
        <div class="img-overlay">
          <button class="img-overlay-btn" onclick="replaceBoardMedia(${clip.number})">Replace</button>
          <button class="img-overlay-btn delete" onclick="removeBoardMedia(${clip.number})">Remove</button>
          <button class="img-overlay-btn" onclick="previewVideo(${clip.number})">Play</button>
        </div>`
    } else if (hasMedia && media.type === 'image') {
      mediaHtml = `<img src="${media.dataUrl}" alt="CLIP ${clip.number}">
        <div class="img-overlay">
          <button class="img-overlay-btn" onclick="replaceBoardMedia(${clip.number})">Replace</button>
          <button class="img-overlay-btn delete" onclick="removeBoardMedia(${clip.number})">Remove</button>
        </div>`
    } else {
      mediaHtml = `<div class="drop-zone" id="dz_${clip.number}">
        <span class="drop-zone-icon">📁</span>
        Drop image/video here<br><span style="font-size:10px;opacity:0.6">or click to browse</span>
      </div>`
    }

    html += `<div class="board-clip" data-clip="${clip.number}">
      <div class="board-clip-header">
        <span class="clip-num">CLIP ${clip.number}</span>
        <span class="clip-badge ${isImage ? 'image' : 'video'}">${isImage ? '🖼' : '🎬'} ${isImage ? 'Image' : 'Video'}</span>
        <span class="clip-model-tag">${escapeHtml(modelShort)}</span>
        <span class="clip-duration-tag">${escapeHtml(dur)}</span>
      </div>
      <div class="board-clip-media" id="bimg_${clip.number}"
        ondragover="boardDragOver(event)" ondragleave="boardDragLeave(event)"
        ondrop="boardDrop(event, ${clip.number})">
        ${mediaHtml}
      </div>
      <div class="board-clip-prompt">${escapeHtml((clip.prompt || '').slice(0, 200))}</div>
      <div class="board-clip-footer">
        ${wf ? `<span class="board-clip-workflow">${escapeHtml(wf)}</span>` : '<span></span>'}
        <div class="board-clip-actions">
          <button class="copy-prompt-btn" style="font-size:10px;padding:3px 10px" onclick="copyBoardPrompt(${clip.number}, this)">Copy</button>
        </div>
      </div>
    </div>`
  }

  html += '</div>'

  // Media Review section
  const loadedClips = Object.keys(state.boardMedia).map(Number).sort((a, b) => a - b)
  if (loadedClips.length > 0) {
    html += `<div style="margin-top:24px;padding-top:16px;border-top:1px solid var(--border)">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
        <div>
          <h3 style="font-size:14px;font-weight:700;color:var(--text)">Loaded Media (${loadedClips.length})</h3>
          <span style="font-size:11px;color:var(--text2)">${state.mediaShareEnabled ? 'Visible to the AI in chat' : 'Media sharing with AI is OFF'}</span>
        </div>
        <button class="copy-prompt-btn" style="font-size:11px" onclick="switchTab('chat');document.getElementById('userInput').focus()">
          Back to Chat
        </button>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill, minmax(200px, 1fr));gap:12px">`
    for (const cn of loadedClips) {
      const clip = plan.clips.find(c => c.number === cn)
      const m = state.boardMedia[cn]
      const previewHtml = m.type === 'video'
        ? `<video src="${escapeHtml(m.path || m.dataUrl)}" style="width:100%;height:140px;object-fit:cover;display:block" muted></video>`
        : `<img src="${m.dataUrl}" style="width:100%;height:140px;object-fit:cover;display:block" alt="CLIP ${cn}">`
      html += `<div style="background:var(--bg3);border:1px solid var(--border);border-radius:8px;overflow:hidden">
        ${previewHtml}
        <div style="padding:8px;font-size:11px">
          <div style="font-weight:700;color:var(--text)">CLIP ${cn} ${m.type === 'video' ? '🎬' : '🖼'}</div>
          <div style="color:var(--text2);margin-top:2px">${clip ? escapeHtml((clip.prompt || '').slice(0, 80)) + '...' : ''}</div>
        </div>
      </div>`
    }
    html += '</div></div>'
  }

  // Deepy section
  html += `<div class="deepy-section">
    <div class="deepy-header">
      <span class="deepy-badge">Deepy</span>
      <span style="font-size:13px;font-weight:600;color:var(--text)">WanGP Agent Messages</span>
      <span style="font-size:11px;color:var(--text2)">Generate instructions for Deepy</span>
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">
      <button class="deepy-btn" onclick="generateDeepyForClip('all')">Generate All Clips Workflow</button>
      ${plan.clips.map(c =>
        `<button class="deepy-btn" onclick="generateDeepyForClip(${c.number})">CLIP ${c.number} ${c.clip_type === 'image' ? 'Image' : 'Video'}</button>`
      ).join('')}
    </div>
    <textarea class="deepy-textarea" id="deepyOutput" placeholder="Click a button above to generate a Deepy instruction, then copy and paste it into WanGP's Deepy chat..." readonly></textarea>
    <div class="deepy-actions">
      <button class="deepy-btn primary" onclick="copyDeepyMessage()">Copy Deepy Message</button>
    </div>
  </div>`

  container.innerHTML = html

  // Add click-to-browse on drop zones
  container.querySelectorAll('.drop-zone').forEach(dz => {
    dz.addEventListener('click', () => {
      const clipNum = parseInt(dz.id.replace('dz_', ''))
      browseMedia(clipNum)
    })
  })
}

function switchBoardPlan(idx) {
  state.boardPlanIndex = idx
  renderBoard()
}

function toggleMediaShare(enabled) {
  state.mediaShareEnabled = enabled
}

function copyBoardPrompt(clipNumber, btn) {
  const plan = getActiveBoardPlan()
  if (!plan) return
  const clip = plan.clips.find(c => c.number === clipNumber)
  if (!clip || !clip.prompt) return
  navigator.clipboard.writeText(clip.prompt).then(() => {
    btn.textContent = '✓'; btn.classList.add('copied')
    const card = btn.closest('.board-clip')
    if (card) card.classList.add('prompt-copied')
    setTimeout(() => { btn.textContent = 'Copied'; btn.classList.add('copied') }, 1800)
  }).catch(() => {
    fallbackCopy(clip.prompt, btn)
    const card = btn.closest('.board-clip')
    if (card) card.classList.add('prompt-copied')
  })
}

// ─── BOARD DRAG & DROP + MEDIA ───────────────────────────────────────────────
const MEDIA_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm,video/quicktime,video/x-msvideo,video/x-matroska'

function boardDragOver(e) {
  e.preventDefault()
  e.dataTransfer.dropEffect = 'copy'
  const dz = e.currentTarget.querySelector('.drop-zone')
  if (dz) dz.classList.add('dragover')
}

function boardDragLeave(e) {
  const dz = e.currentTarget.querySelector('.drop-zone')
  if (dz) dz.classList.remove('dragover')
}

async function boardDrop(e, clipNumber) {
  e.preventDefault()
  const dz = e.currentTarget.querySelector('.drop-zone')
  if (dz) dz.classList.remove('dragover')
  const file = e.dataTransfer.files[0]
  if (!file) return
  const isMedia = file.type.startsWith('image/') || file.type.startsWith('video/')
  if (!isMedia) {
    showNotif('Drop an image or video file', 'error')
    return
  }
  await saveMediaForClip(clipNumber, file)
}

function browseMedia(clipNumber) {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = MEDIA_ACCEPT
  input.onchange = async () => {
    if (input.files[0]) await saveMediaForClip(clipNumber, input.files[0])
  }
  input.click()
}

async function saveMediaForClip(clipNumber, file) {
  if (!state.currentSessionId) { showNotif('No session', 'error'); return }
  const isVideo = file.type.startsWith('video/')

  if (isVideo && file.path) {
    // Videos: copy from file path to avoid huge base64
    const res = await window.api.saveMedia(state.currentSessionId, clipNumber, null, file.path)
    if (res.ok) {
      const fp = await window.api.getFilePath(state.currentSessionId, res.filename)
      state.boardMedia[clipNumber] = { type: 'video', path: fp, mime: file.type, filename: res.filename }
      showNotif(`Video saved for CLIP ${clipNumber}`, 'success')
      renderBoard()
    } else {
      showNotif(res.error || 'Failed to save video', 'error')
    }
  } else {
    // Images: use base64 dataUrl
    const reader = new FileReader()
    reader.onload = async () => {
      const dataUrl = reader.result
      const res = await window.api.saveMedia(state.currentSessionId, clipNumber, dataUrl, null)
      if (res.ok) {
        if (res.mediaType === 'video') {
          const fp = await window.api.getFilePath(state.currentSessionId, res.filename)
          state.boardMedia[clipNumber] = { type: 'video', path: fp, mime: file.type, filename: res.filename }
        } else {
          state.boardMedia[clipNumber] = { type: 'image', dataUrl, filename: res.filename }
        }
        showNotif(`${res.mediaType === 'video' ? 'Video' : 'Image'} saved for CLIP ${clipNumber}`, 'success')
        renderBoard()
      } else {
        showNotif(res.error || 'Failed to save media', 'error')
      }
    }
    reader.readAsDataURL(file)
  }
}

function replaceBoardMedia(clipNumber) {
  browseMedia(clipNumber)
}

async function removeBoardMedia(clipNumber) {
  if (!state.currentSessionId) return
  await window.api.deleteMedia(state.currentSessionId, clipNumber)
  delete state.boardMedia[clipNumber]
  showNotif(`Media removed from CLIP ${clipNumber}`)
  renderBoard()
}

function previewVideo(clipNumber) {
  const m = state.boardMedia[clipNumber]
  if (!m || m.type !== 'video') return
  const overlay = document.createElement('div')
  overlay.className = 'video-preview-overlay'
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove() }
  const vid = document.createElement('video')
  vid.src = m.path || m.dataUrl
  vid.controls = true
  vid.autoplay = true
  overlay.appendChild(vid)
  document.body.appendChild(overlay)
}

async function loadBoardMedia() {
  if (!state.currentSessionId) return
  state.boardMedia = {}
  const items = await window.api.listMedia(state.currentSessionId)
  for (const item of items) {
    if (item.clipNumber !== null) {
      const data = await window.api.getMedia(state.currentSessionId, item.filename)
      if (data) {
        if (data.type === 'video') {
          state.boardMedia[item.clipNumber] = { type: 'video', path: data.path, mime: data.mime, filename: item.filename }
        } else if (data.type === 'image') {
          state.boardMedia[item.clipNumber] = { type: 'image', dataUrl: data.dataUrl, filename: item.filename }
        }
      }
    }
  }
  if (state.activeTab === 'board') renderBoard()
}

// ─── DEEPY MESSAGES ──────────────────────────────────────────────────────────
function generateDeepyForClip(clipOrAll) {
  const plan = getActiveBoardPlan()
  if (!plan) return
  const output = document.getElementById('deepyOutput')
  if (!output) return

  if (clipOrAll === 'all') {
    let steps = []
    let stepNum = 1
    const images = plan.clips.filter(c => c.clip_type === 'image')
    const videos = plan.clips.filter(c => c.clip_type === 'video')

    for (const clip of images) {
      steps.push(`${stepNum}) Generate a high quality image: ${clip.prompt}`)
      stepNum++
    }
    for (const clip of videos) {
      let instruction = `${stepNum}) Generate a ${clip.duration || '12s'} video: ${clip.prompt}`
      if (clip.start_image_clip) {
        const siClip = plan.clips.find(c => c.number === clip.start_image_clip)
        if (siClip) instruction += ` Use the image generated in step ${images.indexOf(siClip) + 1} as the start image.`
      }
      if (clip.end_image_clip) {
        const eiClip = plan.clips.find(c => c.number === clip.end_image_clip)
        if (eiClip) instruction += ` Use the image generated in step ${images.indexOf(eiClip) + 1} as the end image.`
      }
      steps.push(instruction)
      stepNum++
    }
    output.value = steps.join('\n')
  } else {
    const clip = plan.clips.find(c => c.number === clipOrAll)
    if (!clip) return

    if (clip.clip_type === 'image') {
      output.value = `Generate a high quality image: ${clip.prompt}`
    } else {
      let msg = `Generate a ${clip.duration || '12s'} video: ${clip.prompt}`
      if (clip.start_image_clip) msg += ` Use the last generated image as the start image.`
      if (clip.end_image_clip) msg += ` Use the last generated image as the end image.`
      output.value = msg
    }
  }
  output.style.height = 'auto'
  output.style.height = Math.max(80, output.scrollHeight) + 'px'
}

function copyDeepyMessage() {
  const output = document.getElementById('deepyOutput')
  if (!output || !output.value) { showNotif('Generate a message first', 'error'); return }
  navigator.clipboard.writeText(output.value).then(() => {
    showNotif('Deepy message copied!', 'success')
  }).catch(() => fallbackCopy(output.value, null))
}

// ─── UI HELPERS ───────────────────────────────────────────────────────────────
function handleKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage() }
}

function autoResize(el) {
  el.style.height = 'auto'
  el.style.height = Math.min(el.scrollHeight, 160) + 'px'
}

function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function showNotif(msg, type = 'success') {
  const n = document.createElement('div')
  n.className = `notif ${type}`
  n.textContent = msg
  document.body.appendChild(n)
  setTimeout(() => n.remove(), 2500)
}

// ─── PERSISTENCE ──────────────────────────────────────────────────────────────
async function saveSettings() {
  const current = await window.api.loadSettings()
  await window.api.saveSettings({
    ...current,
    provider: state.provider,
    apiKey: state.apiKey,
    baseUrl: state.baseUrl,
    model: state.model
  })
}

async function loadSettings() {
  const s = await window.api.loadSettings()
  if (!s || Object.keys(s).length === 0) {
    state.enabledModels = getDefaultEnabledModels()
    renderModelCards()
    return
  }

  // Restore provider
  if (s.provider) {
    document.getElementById('providerSelect').value = s.provider
    state.provider = s.provider
    onProviderChange()
  }
  if (s.apiKey) {
    document.getElementById('apiKeyInput').value = s.apiKey
    state.apiKey = s.apiKey
  }
  if (s.baseUrl) {
    document.getElementById('baseUrlInput').value = s.baseUrl
    state.baseUrl = s.baseUrl
  }
  if (s.model) {
    state.model = s.model
    const sel    = document.getElementById('modelSelect')
    const custom = document.getElementById('modelCustom')
    if (!sel.classList.contains('hidden')) {
      const opt = sel.querySelector(`option[value="${s.model}"]`)
      if (opt) sel.value = s.model; else custom.value = s.model
    } else { custom.value = s.model }
  }

  // Re-establish connection state
  if (state.provider && state.model) {
    state.connected = true
    const cfg = PROVIDERS[state.provider]
    document.getElementById('statusDot').className = 'status-dot connected'
    document.getElementById('topbarModel').textContent = `${cfg.name} · ${state.model}`
    document.getElementById('sendBtn').disabled = false
    document.getElementById('genPromptsBtn').disabled = false
  }

  // Restore sessions
  if (s.sessions && Array.isArray(s.sessions)) {
    state.sessions = s.sessions
    renderSessionList()
    if (s.currentSessionId) {
      const found = state.sessions.find(x => x.id === s.currentSessionId)
      if (found) await loadSession(s.currentSessionId)
    }
  }

  if (state.enabledModels.length === 0) {
    state.enabledModels = getDefaultEnabledModels()
  }
  renderModelCards()
}

// ─── INIT ─────────────────────────────────────────────────────────────────────
onProviderChange()
loadSettings()
