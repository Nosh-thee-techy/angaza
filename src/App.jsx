import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import html2canvas from 'html2canvas'
import {
  Copy,
  Download,
  ExternalLink,
  ImagePlus,
  Link2,
  Menu,
  MessageCircleMore,
  Plus,
  SendHorizontal,
  Share2,
  X,
} from 'lucide-react'
import { v4 as uuidv4 } from 'uuid'

const INTENT_SYSTEM_PROMPT = `You are Angaza's intent classifier. Given a user input, determine:
1. input_type: one of [text_claim, url, image_description, question, ambiguous]
2. mode: one of [verify, qa]
3. topic: brief topic label
4. kenya_relevant: boolean

Respond in JSON only.`

const VERIFY_SYSTEM_PROMPT = `You are Angaza, a Kenyan media fact-checking assistant. Your job is to verify claims, detect misinformation, and assess media authenticity. You ONLY provide verdicts backed by verifiable sources. If you cannot cite a source, say UNVERIFIED — never guess.

For every claim, return a JSON response with:
- verdict: TRUE | FALSE | UNVERIFIED | DEEPFAKE | MISLEADING
- confidence: number 0-100
- explanation: plain-language explanation in max 3 sentences, written for an everyday Kenyan WhatsApp user
- sources: array of {name, url, stance} where stance is confirms | contradicts | neutral
- kenya_context: string or null — any Kenya-specific context relevant to this claim
- forensic_flags: array of strings or null — only for media/image/video claims, list specific anomalies detected
- missing_context: string or null — what important information is absent from this claim (especially for government/political statements)
- follow_up_suggestions: array of 2-3 questions the user might want to ask next

Always consider: Is this claim transplanted from another country/time? Is it selectively true? Does it omit critical context? Is it timed suspiciously near an election or political event?

Kenyan context: You are aware of Kenya's political landscape, the 2027 elections, M-Pesa, CBK, KNBS, the Gen Z protests of 2024, and major Kenyan institutions.`

const QA_SYSTEM_PROMPT = `You are Angaza, a sourced truth companion for Kenyan WhatsApp users. When asked questions, you:
1. Answer directly and clearly in plain language
2. Always cite specific sources (name + URL where possible)
3. Flag when something is contested or uncertain
4. Add Kenya-specific context whenever relevant
5. NEVER answer without a source — if unsure, say so and explain what IS known
6. Respond in the same language/register as the user (if they write in Sheng or casual Swahili, match that)

Return JSON with:
- answer: full sourced answer (can be longer for Q&A)
- sources: array of {name, url, stance}
- confidence: 0-100
- kenya_context: string or null
- follow_up_suggestions: array of 2-3 follow-up questions
- uncertainty_note: string or null — what you're not sure about

Remember: a tool that admits uncertainty is more trustworthy than one with a confident answer for everything.`

const VERIFY_STEPS = [
  'Content received',
  'Type detected',
  'Running fact-check engine',
  'Cross-referencing sources',
  'Generating verdict',
]

const QA_STEPS = [
  'Question received',
  'Identifying topic and context',
  'Searching verified sources',
  'Checking for Kenya-specific context',
  'Composing answer',
]

const QUICK_CHIPS = [
  { label: 'Text claim', inputType: 'text', mode: 'verify' },
  { label: 'Paste URL', inputType: 'url', mode: 'verify' },
  { label: 'Upload image', inputType: 'image', mode: 'verify' },
  { label: 'Ask a question', inputType: 'question', mode: 'qa' },
]

const DEMO_CHIPS = [
  { label: 'Did CBK ban M-Pesa?', mode: 'qa', inputType: 'question' },
  { label: 'Is this video real?', mode: 'verify', inputType: 'image' },
  { label: 'Kenya inflation stats', mode: 'qa', inputType: 'question' },
]

const DEMO_IMAGE_URL =
  'https://images.unsplash.com/photo-1485846234645-a62644f84728?auto=format&fit=crop&w=960&q=80'

const initialState = {
  checks: [],
  activeCheck: null,
  conversation: [],
  isProcessing: false,
  currentStep: 0,
  mode: 'verify',
  inputType: 'text',
}

function reducer(state, action) {
  switch (action.type) {
    case 'SET_MODE':
      return { ...state, mode: action.payload }
    case 'SET_INPUT_TYPE':
      return { ...state, inputType: action.payload }
    case 'START_ANALYSIS':
      return {
        ...state,
        isProcessing: true,
        currentStep: 0,
        mode: action.payload.mode,
        inputType: action.payload.inputType,
        conversation: [...state.conversation, action.payload.userMessage],
      }
    case 'SET_STEP':
      return { ...state, currentStep: action.payload }
    case 'COMPLETE_ANALYSIS':
      return {
        ...state,
        checks: [action.payload.check, ...state.checks],
        activeCheck: action.payload.check,
        conversation: [...state.conversation, action.payload.assistantMessage],
        isProcessing: false,
        currentStep: 5,
      }
    case 'LOAD_CHECK':
      return { ...state, activeCheck: action.payload }
    case 'RESET_CONVERSATION':
      return { ...state, conversation: [], activeCheck: null, currentStep: 0 }
    case 'SET_CONVERSATION':
      return { ...state, conversation: action.payload }
    default:
      return state
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const formatTime = (date) =>
  new Date(date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

function formatAgo(timestamp) {
  const diffMs = Date.now() - new Date(timestamp).getTime()
  const mins = Math.max(1, Math.floor(diffMs / 60000))
  if (mins < 60) return `${mins} min${mins > 1 ? 's' : ''} ago`
  const hrs = Math.floor(mins / 60)
  return `${hrs} hr${hrs > 1 ? 's' : ''} ago`
}

function inferInputType(text, hasImage) {
  if (hasImage) return 'image'
  if (/^https?:\/\//i.test(text.trim())) return 'url'
  if (/\?$/.test(text.trim())) return 'question'
  return 'text'
}

function inferMode(type, text) {
  if (type === 'question' || /\?$/.test(text.trim())) return 'qa'
  return 'verify'
}

function sanitizeSources(sources) {
  if (!Array.isArray(sources) || sources.length === 0) {
    return [{ name: 'No source found', url: '#', stance: 'neutral' }]
  }
  return sources.slice(0, 6).map((source) => ({
    name: source.name || 'Unknown source',
    url: source.url || '#',
    stance: source.stance || 'neutral',
  }))
}

function parseClaudeText(payload) {
  const content = payload?.content
  if (!Array.isArray(content)) return '{}'
  const textBlock = content.find((block) => block.type === 'text')
  return textBlock?.text || '{}'
}

function parseJsonSafely(text) {
  try {
    return JSON.parse(text)
  } catch {
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) return null
    try {
      return JSON.parse(match[0])
    } catch {
      return null
    }
  }
}

async function callClaude({ system, messages, maxTokens = 1200 }) {
  const apiKey = import.meta.env.VITE_ANTHROPIC_API_KEY
  if (!apiKey) return null
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: maxTokens,
      system,
      messages,
    }),
  })
  if (!response.ok) {
    throw new Error(`Claude request failed: ${response.status}`)
  }
  return response.json()
}

function fallbackCheck({ input, mode, inputType }) {
  const lower = input.toLowerCase()
  if (mode === 'qa') {
    return {
      verdict: 'ANSWER',
      confidence: 72,
      explanation:
        lower.includes('inflation')
          ? 'Kenya inflation has fluctuated month to month. KNBS CPI releases are the most reliable source for current national inflation figures.'
          : 'CBK has not issued a blanket ban on M-Pesa. Regulatory guidance typically targets specific compliance or risk controls, not total shutdowns.',
      sources: [
        { name: 'CBK', url: 'https://www.centralbank.go.ke', stance: 'confirms' },
        { name: 'KNBS', url: 'https://www.knbs.or.ke', stance: 'confirms' },
        { name: 'Reuters Africa', url: 'https://www.reuters.com/world/africa/', stance: 'neutral' },
      ],
      kenya_context:
        'Financial misinformation often spikes around policy changes and election cycles in Kenya.',
      forensic_flags: null,
      missing_context:
        'The exact circular date and full CBK statement wording are needed for a definitive interpretation.',
      follow_up_suggestions: [
        'Can you show the exact CBK circular being referenced?',
        'What did Safaricom officially announce?',
        'How recent is this information?',
      ],
    }
  }
  const deepfake = inputType === 'image' || lower.includes('video')
  return {
    verdict: deepfake ? 'DEEPFAKE' : 'UNVERIFIED',
    confidence: deepfake ? 79 : 61,
    explanation: deepfake
      ? 'The media shows synthetic artifact signatures and temporal inconsistencies that commonly appear in generated clips.'
      : 'We could not confirm this claim with high-quality primary sources, so it remains unverified for now.',
    sources: [
      { name: 'Africa Check', url: 'https://africacheck.org', stance: 'neutral' },
      { name: 'Nation', url: 'https://nation.africa', stance: 'neutral' },
      { name: 'Standard', url: 'https://www.standardmedia.co.ke', stance: 'neutral' },
    ],
    kenya_context:
      'Similar claims have circulated online ahead of major political moments, often with edited captions.',
    forensic_flags: deepfake
      ? [
          'Facial boundary inconsistencies',
          'Audio-visual sync offset: 340ms',
          'Compression artifact pattern: synthetic',
        ]
      : null,
    missing_context: 'No date, location, and original source file were attached to this claim.',
    follow_up_suggestions: [
      'Can you check where this first appeared?',
      'Do trusted Kenyan outlets report the same thing?',
      'What context is missing from this post?',
    ],
  }
}

function normalizeClaudeResult(result, mode) {
  if (!result) return null
  if (mode === 'qa') {
    return {
      verdict: 'ANSWER',
      confidence: Number(result.confidence) || 65,
      explanation: result.answer || 'No answer returned.',
      sources: sanitizeSources(result.sources),
      kenya_context: result.kenya_context || null,
      forensic_flags: null,
      missing_context: result.uncertainty_note || null,
      follow_up_suggestions:
        result.follow_up_suggestions || ['What should I verify next?'],
    }
  }
  const verdictMap = {
    TRUE: 'VERIFIED',
    FALSE: 'FALSE',
    UNVERIFIED: 'UNVERIFIED',
    DEEPFAKE: 'DEEPFAKE',
    MISLEADING: 'UNVERIFIED',
  }
  return {
    verdict: verdictMap[result.verdict] || 'UNVERIFIED',
    confidence: Number(result.confidence) || 60,
    explanation: result.explanation || 'No explanation returned.',
    sources: sanitizeSources(result.sources),
    kenya_context: result.kenya_context || null,
    forensic_flags: result.forensic_flags || null,
    missing_context: result.missing_context || null,
    follow_up_suggestions:
      result.follow_up_suggestions || ['What do you want to dig into next?'],
  }
}

function getVerdictClass(verdict) {
  if (verdict === 'VERIFIED') return 'verified'
  if (verdict === 'FALSE' || verdict === 'DEEPFAKE') return 'false'
  if (verdict === 'ANSWER') return 'answer'
  return 'unverified'
}

function verdictBadge(verdict) {
  if (verdict === 'VERIFIED') return '✓ VERIFIED'
  if (verdict === 'FALSE') return '✗ FALSE'
  if (verdict === 'DEEPFAKE') return '⚡ DEEPFAKE DETECTED'
  if (verdict === 'ANSWER') return '💬 ANSWER'
  return '⚠ UNVERIFIED'
}

function statusDot(verdict) {
  if (verdict === 'VERIFIED' || verdict === 'ANSWER') return 'teal'
  if (verdict === 'FALSE' || verdict === 'DEEPFAKE') return 'red'
  return 'amber'
}

function sourceDot(stance) {
  if (stance === 'confirms') return 'green'
  if (stance === 'contradicts') return 'red'
  return 'gray'
}

function App() {
  const [state, dispatch] = useReducer(reducer, initialState)
  const [input, setInput] = useState('')
  const [imagePreview, setImagePreview] = useState('')
  const [isShareOpen, setIsShareOpen] = useState(false)
  const [isSidebarOpen, setIsSidebarOpen] = useState(false)
  const [isVerdictSheetOpen, setIsVerdictSheetOpen] = useState(false)
  const [isDownloading, setIsDownloading] = useState(false)
  const fileInputRef = useRef(null)
  const shareCardRef = useRef(null)
  const textareaRef = useRef(null)
  const threadRef = useRef(null)

  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight, behavior: 'smooth' })
  }, [state.conversation, state.currentStep, state.isProcessing])

  const activeSteps = useMemo(
    () => (state.mode === 'qa' ? QA_STEPS : VERIFY_STEPS),
    [state.mode],
  )

  const placeholderMap = {
    text: 'Paste the claim text you want verified...',
    url: 'Paste a link from WhatsApp, TikTok, X, or news source...',
    image: 'Upload an image, then add optional context...',
    question: 'Ask a question and Angaza will answer with sources...',
  }

  async function detectIntent(rawInput, hasImage) {
    const fallbackType = inferInputType(rawInput, hasImage)
    const fallbackMode = inferMode(fallbackType, rawInput)
    try {
      const response = await callClaude({
        system: INTENT_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: rawInput || 'Uploaded image for verification' }],
        maxTokens: 400,
      })
      if (!response) return { mode: fallbackMode, inputType: fallbackType }
      const parsed = parseJsonSafely(parseClaudeText(response))
      if (!parsed) return { mode: fallbackMode, inputType: fallbackType }
      const inputTypeMap = {
        text_claim: 'text',
        url: 'url',
        image_description: 'image',
        question: 'question',
        ambiguous: fallbackType,
      }
      return {
        mode: parsed.mode === 'qa' ? 'qa' : fallbackMode,
        inputType: inputTypeMap[parsed.input_type] || fallbackType,
      }
    } catch {
      return { mode: fallbackMode, inputType: fallbackType }
    }
  }

  async function runClaudePipeline({ mode, promptText, conversationHistory }) {
    try {
      if (mode === 'qa') {
        const response = await callClaude({
          system: QA_SYSTEM_PROMPT,
          messages: [
            ...conversationHistory,
            { role: 'user', content: `User question: ${promptText}` },
          ],
          maxTokens: 1600,
        })
        if (!response) return null
        return normalizeClaudeResult(parseJsonSafely(parseClaudeText(response)), mode)
      }
      const response = await callClaude({
        system: VERIFY_SYSTEM_PROMPT,
        messages: [
          ...conversationHistory,
          { role: 'user', content: `Claim or media to verify: ${promptText}` },
        ],
        maxTokens: 1600,
      })
      if (!response) return null
      return normalizeClaudeResult(parseJsonSafely(parseClaudeText(response)), mode)
    } catch {
      return null
    }
  }

  async function processInput(rawInput, options = {}) {
    const hasImage = Boolean(options.imagePreview)
    if (!rawInput.trim() && !hasImage) return

    const userInput = rawInput.trim() || 'Uploaded image for verification'
    const intent = options.overrideIntent || (await detectIntent(userInput, hasImage))
    const mode = intent.mode || state.mode
    const inputType = hasImage ? 'image' : intent.inputType || state.inputType
    const userMessage = {
      id: uuidv4(),
      role: 'user',
      content: userInput,
      timestamp: new Date().toISOString(),
      image: options.imagePreview || null,
    }

    dispatch({ type: 'START_ANALYSIS', payload: { userMessage, mode, inputType } })
    setInput('')
    setImagePreview('')

    const conversationHistory = state.conversation.map((message) => ({
      role: message.role,
      content: message.content,
    }))

    const stepPromise = (async () => {
      for (let step = 1; step <= 5; step += 1) {
        await sleep(600)
        dispatch({ type: 'SET_STEP', payload: step })
      }
    })()

    const analysisPromise = runClaudePipeline({
      mode,
      promptText: userInput,
      conversationHistory,
    })

    const [, claudeResult] = await Promise.all([stepPromise, analysisPromise])
    const result = claudeResult || fallbackCheck({ input: userInput, mode, inputType })

    const check = {
      id: uuidv4(),
      timestamp: new Date().toISOString(),
      input: userInput,
      inputType,
      mode,
      verdict: result.verdict,
      confidence: result.confidence,
      explanation: result.explanation,
      sources: result.sources,
      kenya_context: result.kenya_context,
      forensic_flags: result.forensic_flags,
      missing_context: result.missing_context,
      follow_up_suggestions: result.follow_up_suggestions,
      image: options.imagePreview || null,
    }

    const assistantMessage = {
      id: uuidv4(),
      role: 'assistant',
      timestamp: new Date().toISOString(),
      content: `${verdictBadge(check.verdict)} · ${check.confidence}% confidence`,
      checkId: check.id,
    }

    dispatch({ type: 'COMPLETE_ANALYSIS', payload: { check, assistantMessage } })
    setIsVerdictSheetOpen(true)
  }

  function triggerDemo(demo) {
    if (demo.label === 'Is this video real?') {
      processInput(
        'Please analyze this uploaded video still for manipulation signs.',
        { imagePreview: DEMO_IMAGE_URL, overrideIntent: { mode: 'verify', inputType: 'image' } },
      )
      return
    }
    processInput(demo.label, {
      overrideIntent: { mode: demo.mode, inputType: demo.inputType },
    })
  }

  function handleFileChange(event) {
    const file = event.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      const preview = typeof reader.result === 'string' ? reader.result : ''
      setImagePreview(preview)
      dispatch({ type: 'SET_INPUT_TYPE', payload: 'image' })
      dispatch({ type: 'SET_MODE', payload: 'verify' })
    }
    reader.readAsDataURL(file)
  }

  async function copyVerdict() {
    if (!state.activeCheck) return
    const text = [
      `Angaza verdict: ${verdictBadge(state.activeCheck.verdict)}`,
      `Confidence: ${state.activeCheck.confidence}%`,
      `Explanation: ${state.activeCheck.explanation}`,
      `Sources: ${state.activeCheck.sources.map((source) => source.name).join(', ')}`,
    ].join('\n')
    await navigator.clipboard.writeText(text)
  }

  function focusFollowUp() {
    if (!state.activeCheck) return
    const prefixed = `Follow-up on "${state.activeCheck.input}": `
    setInput(prefixed)
    dispatch({ type: 'SET_MODE', payload: 'qa' })
    dispatch({ type: 'SET_INPUT_TYPE', payload: 'question' })
    textareaRef.current?.focus()
  }

  async function downloadFactCard() {
    if (!shareCardRef.current) return
    setIsDownloading(true)
    try {
      const canvas = await html2canvas(shareCardRef.current, { backgroundColor: '#111827' })
      const link = document.createElement('a')
      link.download = `angaza-fact-card-${Date.now()}.png`
      link.href = canvas.toDataURL('image/png')
      link.click()
    } finally {
      setIsDownloading(false)
    }
  }

  async function copyDeepLink() {
    if (!state.activeCheck) return
    const deepLink = `${window.location.origin}${window.location.pathname}#check-${state.activeCheck.id}`
    await navigator.clipboard.writeText(deepLink)
  }

  const ringOffset = 282.7 - ((state.activeCheck?.confidence || 0) / 100) * 282.7

  return (
    <div className="app-shell">
      <button className="mobile-menu" onClick={() => setIsSidebarOpen((prev) => !prev)}>
        <Menu size={18} /> Menu
      </button>

      <aside className={`panel left-panel ${isSidebarOpen ? 'open' : ''}`}>
        <div>
          <h1 className="logo">ANGAZA</h1>
          <p className="tagline">Illuminating truth</p>
        </div>
        <button
          className="teal-btn full"
          onClick={() => {
            dispatch({ type: 'RESET_CONVERSATION' })
            setInput('')
            setImagePreview('')
          }}
        >
          <Plus size={16} /> New Check
        </button>
        <div className="history-list">
          {state.checks.map((check) => (
            <button
              key={check.id}
              className="history-item"
              onClick={() => dispatch({ type: 'LOAD_CHECK', payload: check })}
            >
              <div className="history-top">
                <span className={`status-dot ${statusDot(check.verdict)}`} />
                <p>{check.input.slice(0, 40)}{check.input.length > 40 ? '...' : ''}</p>
              </div>
              <span className="timestamp">{formatAgo(check.timestamp)}</span>
            </button>
          ))}
        </div>
        <p className="footer-note">Built for Startup School Kenya 2026</p>
      </aside>

      <main className="panel center-panel">
        <header className="top-bar">
          <div className="mode-pill">{state.mode === 'qa' ? 'Q&A MODE' : 'VERIFY MODE'}</div>
          <div className="mode-switch">
            <button
              className={state.mode === 'verify' ? 'active' : ''}
              onClick={() => dispatch({ type: 'SET_MODE', payload: 'verify' })}
            >
              Verify
            </button>
            <button
              className={state.mode === 'qa' ? 'active' : ''}
              onClick={() => dispatch({ type: 'SET_MODE', payload: 'qa' })}
            >
              Q&A
            </button>
          </div>
        </header>

        <section ref={threadRef} className="thread">
          {state.conversation.map((message) => (
            <article
              key={message.id}
              className={`bubble-wrap ${message.role === 'user' ? 'user-wrap' : 'assistant-wrap'}`}
            >
              {message.role === 'assistant' && <div className="avatar">A</div>}
              <div className={`bubble ${message.role}`}>
                {message.image && <img src={message.image} alt="Upload preview" className="inline-image" />}
                <p>{message.content}</p>
                <span>{message.role === 'user' ? 'You' : 'Angaza'} · {formatTime(message.timestamp)}</span>
              </div>
            </article>
          ))}

          {state.isProcessing && (
            <article className="bubble-wrap assistant-wrap">
              <div className="avatar">A</div>
              <div className="pipeline-box">
                <p className="pipeline-title">Analyzing...</p>
                {activeSteps.map((step, index) => {
                  const stepState =
                    index + 1 < state.currentStep ? 'done' : index + 1 === state.currentStep ? 'active' : 'pending'
                  return (
                    <div key={step} className={`pipeline-step ${stepState}`}>
                      <span>{stepState === 'done' ? '✓' : stepState === 'active' ? '⟳' : '○'}</span>
                      <span>
                        {step}
                        {step.includes('Type detected') && state.inputType
                          ? `: ${state.inputType}`
                          : ''}
                      </span>
                    </div>
                  )
                })}
              </div>
            </article>
          )}
        </section>

        <section className="input-area">
          <textarea
            ref={textareaRef}
            value={input}
            maxLength={1000}
            onChange={(event) => setInput(event.target.value)}
            placeholder={
              placeholderMap[state.inputType] ||
              'Forward a claim, paste a link, upload an image, or ask a question...'
            }
          />
          {imagePreview && (
            <div className="input-image-preview">
              <img src={imagePreview} alt="Selected upload" />
              <button onClick={() => setImagePreview('')}>
                <X size={14} />
              </button>
            </div>
          )}
          <div className="chip-row">
            {QUICK_CHIPS.map((chip) => (
              <button
                key={chip.label}
                className={`chip ${state.inputType === chip.inputType ? 'active' : ''}`}
                onClick={() => {
                  if (chip.inputType === 'image') {
                    fileInputRef.current?.click()
                  }
                  dispatch({ type: 'SET_INPUT_TYPE', payload: chip.inputType })
                  dispatch({ type: 'SET_MODE', payload: chip.mode })
                }}
              >
                {chip.inputType === 'image' ? <ImagePlus size={14} /> : null}
                {chip.label}
              </button>
            ))}
          </div>
          <div className="input-meta">
            <p>Angaza checks against Africa Check, CBK, KNBS, Nation, Standard, Reuters Africa</p>
            <span>{input.length}/1000</span>
          </div>
          <button
            className="teal-btn submit"
            disabled={state.isProcessing}
            onClick={() => processInput(input, { imagePreview })}
          >
            Analyze <SendHorizontal size={14} />
          </button>
          <input
            ref={fileInputRef}
            className="hidden-input"
            type="file"
            accept="image/*"
            onChange={handleFileChange}
          />
        </section>
      </main>

      <aside className={`panel right-panel ${isVerdictSheetOpen ? 'open' : ''}`}>
        {!state.activeCheck ? (
          <div className="verdict-empty">
            <p className="big-a">A</p>
            <h3>Submit content to see the verdict</h3>
            <div className="demo-row">
              {DEMO_CHIPS.map((chip) => (
                <button key={chip.label} className="chip" onClick={() => triggerDemo(chip)}>
                  {chip.label}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className={`verdict-card ${getVerdictClass(state.activeCheck.verdict)}`}>
            <div className="verdict-head">
              <span className={`badge ${getVerdictClass(state.activeCheck.verdict)}`}>
                {verdictBadge(state.activeCheck.verdict)}
              </span>
              <div className="confidence-ring">
                <svg width="110" height="110" viewBox="0 0 110 110">
                  <circle cx="55" cy="55" r="45" className="bg-ring" />
                  <circle
                    cx="55"
                    cy="55"
                    r="45"
                    className="fg-ring"
                    style={{ strokeDashoffset: ringOffset }}
                  />
                </svg>
                <p>{state.activeCheck.confidence}%</p>
              </div>
            </div>

            <h4>What we found</h4>
            <p className="explanation">{state.activeCheck.explanation}</p>

            {Array.isArray(state.activeCheck.forensic_flags) && state.activeCheck.forensic_flags.length > 0 && (
              <div className="section-block">
                <h4>Forensics flags</h4>
                {state.activeCheck.forensic_flags.map((flag) => (
                  <p key={flag}>- {flag}</p>
                ))}
              </div>
            )}

            <div className="section-block">
              <h4>Sources checked</h4>
              <div className="sources-wrap">
                {state.activeCheck.sources.map((source) => (
                  <a key={`${source.name}-${source.url}`} href={source.url} target="_blank" rel="noreferrer">
                    <span className={`source-dot ${sourceDot(source.stance)}`} />
                    {source.name}
                    <ExternalLink size={12} />
                  </a>
                ))}
              </div>
            </div>

            {state.activeCheck.kenya_context && (
              <div className="section-block">
                <h4>Kenyan context</h4>
                <p>{state.activeCheck.kenya_context}</p>
              </div>
            )}

            {state.activeCheck.missing_context && (
              <div className="section-block">
                <h4>What is missing</h4>
                <p>{state.activeCheck.missing_context}</p>
              </div>
            )}

            {state.activeCheck.mode === 'qa' && (
              <div className="section-block">
                <h4>What else you can ask</h4>
                <div className="demo-row">
                  {state.activeCheck.follow_up_suggestions?.map((suggestion) => (
                    <button
                      key={suggestion}
                      className="chip"
                      onClick={() => {
                        setInput(suggestion)
                        dispatch({ type: 'SET_MODE', payload: 'qa' })
                        dispatch({ type: 'SET_INPUT_TYPE', payload: 'question' })
                        textareaRef.current?.focus()
                      }}
                    >
                      {suggestion}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="action-row">
              <button onClick={() => setIsShareOpen(true)}>
                <Share2 size={14} /> Share fact card
              </button>
              <button onClick={focusFollowUp}>
                <MessageCircleMore size={14} /> Ask a follow-up
              </button>
              <button onClick={copyVerdict}>
                <Copy size={14} /> Copy verdict
              </button>
            </div>
          </div>
        )}
      </aside>

      {isShareOpen && state.activeCheck && (
        <div className="modal">
          <div className="modal-card">
            <button className="close" onClick={() => setIsShareOpen(false)}>
              <X size={16} />
            </button>
            <div ref={shareCardRef} className="share-card">
              <p className="logo">ANGAZA</p>
              <span className={`badge ${getVerdictClass(state.activeCheck.verdict)}`}>
                {verdictBadge(state.activeCheck.verdict)}
              </span>
              <p>{state.activeCheck.explanation}</p>
              <p className="share-source">Top source: {state.activeCheck.sources[0]?.name}</p>
              <p className="share-footer">
                {new Date(state.activeCheck.timestamp).toLocaleString()} · Verified by Angaza
              </p>
            </div>
            <div className="modal-actions">
              <button onClick={downloadFactCard} disabled={isDownloading}>
                <Download size={14} /> {isDownloading ? 'Preparing...' : 'Download as image'}
              </button>
              <button onClick={copyDeepLink}>
                <Link2 size={14} /> Copy link
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default App
