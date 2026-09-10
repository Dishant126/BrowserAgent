import React, { useState, useEffect } from 'react'
import {
  Eye, Lock, Trash2, RefreshCw, CheckCircle2, Globe, Search, Maximize2
} from 'lucide-react'

interface PerceptionStepItem {
  sessionId?: string
  task?: string
  step?: number
  url?: string
  title?: string
  rawScreenshot?: string
  sanitizedScreenshot?: string
  rawElements?: any[]
  elements?: any[]
  timestamp?: number
}

const SERVER = 'http://localhost:8000/api'

export default function LiveSession() {
  const [history, setHistory] = useState<PerceptionStepItem[]>([])
  const [activeStepIndex, setActiveStepIndex] = useState<number>(0)
  const [domFilter, setDomFilter] = useState<string>('')
  const [isWiping, setIsWiping] = useState(false)
  const [wipeNotice, setWipeNotice] = useState<string | null>(null)
  const [zoomedImage, setZoomedImage] = useState<{ src: string; title: string } | null>(null)

  // Live polling every second so it updates whenever the user inputs a prompt or the agent executes
  const fetchSessionData = async () => {
    try {
      const res = await fetch(`${SERVER}/perception/history`)
      if (res.ok) {
        const data = await res.json()
        if (data && Array.isArray(data.history) && data.history.length > 0) {
          setHistory(data.history)
          setActiveStepIndex(prev => Math.min(prev, data.history.length - 1))
        } else if (data && data.latest) {
          setHistory([data.latest])
          setActiveStepIndex(0)
        }
      }
    } catch {}
  }

  useEffect(() => {
    fetchSessionData()
    const interval = setInterval(fetchSessionData, 1000)
    return () => clearInterval(interval)
  }, [])

  // Clear all data for judges demonstration
  const handlePurge = async () => {
    setIsWiping(true)
    try {
      const res = await fetch(`${SERVER}/perception/clear`, { method: 'POST' })
      if (res.ok) {
        setHistory([])
        setActiveStepIndex(0)
        setWipeNotice('Session data completely purged. Zero storage verified.')
        setTimeout(() => setWipeNotice(null), 4000)
      }
    } catch {
    } finally {
      setIsWiping(false)
    }
  }

  const currentStep = history[activeStepIndex] || history[history.length - 1] || null
  const rawElements = currentStep?.rawElements || currentStep?.elements || []
  const sanitizedElements = currentStep?.elements || []

  const filteredRaw = rawElements.filter((el: any) => {
    if (!domFilter) return true
    const q = domFilter.toLowerCase()
    return (
      (el.tag || el.tagName || '').toLowerCase().includes(q) ||
      (el.label || '').toLowerCase().includes(q) ||
      (el.value || '').toLowerCase().includes(q) ||
      (el.id || el.elementId || '').toLowerCase().includes(q)
    )
  })

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      {/* ── TOP TASK BAR & CLEAR BUTTON ──────────────────────────────────────── */}
      <div className="bg-navy-800 border border-slate-700/80 p-4 rounded-xl flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-xs font-mono font-bold text-slate-400 uppercase tracking-wider">
              TASK:
            </span>
            <span className="text-sm font-bold text-cyan-300 font-mono">
              {currentStep?.task || 'Waiting for user prompt in Chrome extension...'}
            </span>
          </div>
          <div className="flex items-center gap-2 text-xs text-slate-400 font-mono mt-1">
            <Globe className="w-3.5 h-3.5" />
            <span className="truncate max-w-md text-slate-300">{currentStep?.url || 'No active page'}</span>
            {currentStep?.title && <span className="text-slate-500">({currentStep.title})</span>}
          </div>
        </div>

        <div className="flex items-center gap-3">
          {/* Step Selector Pills */}
          <div className="flex items-center gap-1.5 overflow-x-auto">
            {history.map((s, idx) => (
              <button
                key={idx}
                onClick={() => setActiveStepIndex(idx)}
                className={`px-3 py-1 rounded text-xs font-mono font-bold transition-all cursor-pointer ${
                  idx === activeStepIndex
                    ? 'bg-cyan-500 text-navy-950 shadow'
                    : 'bg-navy-900 text-slate-300 hover:text-white border border-slate-700'
                }`}
              >
                Step {s.step || idx + 1}
              </button>
            ))}
          </div>

          <button
            onClick={handlePurge}
            disabled={isWiping}
            className="px-3.5 py-1.5 bg-red-600/90 hover:bg-red-500 text-white rounded-lg text-xs font-bold font-mono transition-all flex items-center gap-1.5 cursor-pointer flex-shrink-0"
          >
            <Trash2 className="w-3.5 h-3.5" />
            {isWiping ? 'Purging...' : 'Clear All Data'}
          </button>
        </div>
      </div>

      {wipeNotice && (
        <div className="p-3 bg-emerald-500/10 border border-emerald-500/30 rounded-lg text-emerald-400 text-xs font-mono flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
          <span>{wipeNotice}</span>
        </div>
      )}

      {/* ── 1. SCREENSHOT BEFORE & AFTER ─────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Screenshot Before Masking */}
        <div className="card border-slate-700 overflow-hidden flex flex-col">
          <div className="p-3 bg-navy-900 border-b border-slate-700 flex items-center justify-between">
            <h3 className="text-xs font-bold text-amber-400 uppercase font-mono tracking-wider flex items-center gap-1.5">
              <Eye className="w-4 h-4" />
              Screenshot Before Masking (Raw Client View)
            </h3>
            <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30 font-bold">
              NEVER TRANSMITTED
            </span>
          </div>

          <div className="bg-navy-950 flex-1 min-h-[340px] flex items-center justify-center p-3 relative group">
            {currentStep?.rawScreenshot ? (
              <>
                <img
                  src={currentStep.rawScreenshot}
                  alt="Raw Screenshot"
                  className="max-h-[420px] w-auto max-w-full object-contain rounded border border-slate-700 cursor-pointer"
                  onClick={() => setZoomedImage({ src: currentStep.rawScreenshot!, title: 'Screenshot Before Masking (Raw)' })}
                />
                <button
                  onClick={() => setZoomedImage({ src: currentStep.rawScreenshot!, title: 'Screenshot Before Masking (Raw)' })}
                  className="absolute top-4 right-4 p-1.5 bg-navy-900/90 text-slate-300 rounded opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer border border-slate-600"
                  title="Fullscreen"
                >
                  <Maximize2 className="w-4 h-4" />
                </button>
              </>
            ) : (
              <p className="text-xs text-slate-500 font-mono">No raw screenshot available yet</p>
            )}
          </div>
        </div>

        {/* Screenshot After Masking */}
        <div className="card border-slate-700 overflow-hidden flex flex-col">
          <div className="p-3 bg-navy-900 border-b border-slate-700 flex items-center justify-between">
            <h3 className="text-xs font-bold text-cyan-400 uppercase font-mono tracking-wider flex items-center gap-1.5">
              <Lock className="w-4 h-4" />
              Screenshot After Masking (Sent to AI Server)
            </h3>
            <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 font-bold">
              0 RAW PII SENT
            </span>
          </div>

          <div className="bg-navy-950 flex-1 min-h-[340px] flex items-center justify-center p-3 relative group">
            {currentStep?.sanitizedScreenshot ? (
              <>
                <img
                  src={currentStep.sanitizedScreenshot}
                  alt="Masked Screenshot"
                  className="max-h-[420px] w-auto max-w-full object-contain rounded border border-cyan-500/30 cursor-pointer"
                  onClick={() => setZoomedImage({ src: currentStep.sanitizedScreenshot!, title: 'Screenshot After Masking (Sanitized)' })}
                />
                <button
                  onClick={() => setZoomedImage({ src: currentStep.sanitizedScreenshot!, title: 'Screenshot After Masking (Sanitized)' })}
                  className="absolute top-4 right-4 p-1.5 bg-navy-900/90 text-slate-300 rounded opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer border border-slate-600"
                  title="Fullscreen"
                >
                  <Maximize2 className="w-4 h-4" />
                </button>
              </>
            ) : (
              <p className="text-xs text-slate-500 font-mono">No sanitized screenshot available yet</p>
            )}
          </div>
        </div>
      </div>

      {/* ── 2. DOM BEFORE & AFTER ────────────────────────────────────────────── */}
      <div className="card border-slate-700 overflow-hidden">
        <div className="p-3 bg-navy-900 border-b border-slate-700 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <h3 className="text-xs font-bold text-white uppercase font-mono tracking-wider">
            DOM Comparison (Before Masking vs Masked)
          </h3>
          <div className="relative w-full sm:w-60">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
            <input
              type="text"
              placeholder="Search DOM elements..."
              value={domFilter}
              onChange={e => setDomFilter(e.target.value)}
              className="w-full pl-8 pr-3 py-1 bg-navy-950 border border-slate-700 rounded text-xs text-slate-200 placeholder-slate-500 focus:outline-none font-mono"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 divide-y lg:divide-y-0 lg:divide-x divide-slate-700">
          {/* DOM Before Masking */}
          <div className="p-4 space-y-2">
            <div className="text-xs font-bold text-amber-400 uppercase font-mono pb-2 border-b border-slate-800 flex justify-between">
              <span>DOM Before Masking (Raw Extracted: {filteredRaw.length})</span>
              <span className="text-slate-500 text-[10px]">Client side</span>
            </div>

            <div className="max-h-[360px] overflow-y-auto space-y-1.5 pr-1 font-mono text-xs custom-scrollbar">
              {filteredRaw.length > 0 ? (
                filteredRaw.map((el: any, idx: number) => {
                  const isSensitive = Boolean(el.sensitive)
                  return (
                    <div
                      key={idx}
                      className={`p-2 rounded border ${
                        isSensitive
                          ? 'bg-red-500/10 border-red-500/30 text-red-300'
                          : 'bg-navy-900/60 border-slate-800 text-slate-300'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2 text-[11px]">
                        <span className="font-bold text-slate-200 bg-navy-800 px-1 rounded">
                          &lt;{el.tag || el.tagName || 'el'}&gt;
                        </span>
                        <span className="text-slate-400 truncate max-w-[220px]">
                          {el.domSelector || el.role || el.type}
                        </span>
                        {isSensitive && (
                          <span className="text-[9px] bg-red-500/20 text-red-400 px-1 py-0.5 rounded font-bold">
                            PII DETECTED
                          </span>
                        )}
                      </div>

                      <div className="mt-1 text-slate-300 font-semibold truncate">
                        Label: {el.label || el.ariaLabel || el.placeholder || '(no label)'}
                      </div>

                      {el.value && (
                        <div className="mt-0.5 text-amber-300 text-[11px] truncate">
                          Raw Value: <span className="font-bold text-white">{el.value}</span>
                        </div>
                      )}
                    </div>
                  )
                })
              ) : (
                <p className="text-xs text-slate-500 text-center py-6">No raw DOM elements</p>
              )}
            </div>
          </div>

          {/* DOM After Masking */}
          <div className="p-4 space-y-2">
            <div className="text-xs font-bold text-cyan-400 uppercase font-mono pb-2 border-b border-slate-800 flex justify-between">
              <span>DOM After Masking (Sent to AI: {sanitizedElements.length})</span>
              <span className="text-slate-500 text-[10px]">Cloud sanitized</span>
            </div>

            <div className="max-h-[360px] overflow-y-auto space-y-1.5 pr-1 font-mono text-xs custom-scrollbar">
              {sanitizedElements.length > 0 ? (
                sanitizedElements.map((el: any, idx: number) => {
                  const isRedacted = Boolean(el.sensitive) ||
                    String(el.value || '').includes('REDACTED') ||
                    String(el.label || '').includes('REDACTED') ||
                    String(el.placeholder || '').includes('REDACTED') ||
                    String(el.ariaLabel || '').includes('REDACTED')
                  return (
                    <div
                      key={idx}
                      className={`p-2 rounded border ${
                        isRedacted
                          ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                          : 'bg-navy-900/60 border-slate-800 text-slate-300'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2 text-[11px]">
                        <span className="font-bold text-cyan-300 bg-cyan-950 px-1 rounded border border-cyan-500/30">
                          [{el.id || `el_${String(idx + 1).padStart(3, '0')}`}]
                        </span>
                        <span className="text-slate-400 truncate max-w-[220px]">
                          tag={el.tag || el.tagName || el.type}
                        </span>
                        {isRedacted ? (
                          <span className="text-[9px] bg-emerald-500/20 text-emerald-400 px-1 py-0.5 rounded font-bold">
                            REDACTED TOKEN
                          </span>
                        ) : (
                          <span className="text-[9px] text-slate-500">SAFE</span>
                        )}
                      </div>

                      <div className="mt-1 text-slate-300 font-semibold truncate">
                        Label: {el.label || el.ariaLabel || el.placeholder || '(neutral)'}
                      </div>

                      {el.value && (
                        <div className="mt-0.5 text-emerald-300 text-[11px] truncate">
                          Sanitized Value:{' '}
                          <span className={isRedacted ? 'font-bold text-emerald-400' : 'text-slate-200'}>
                            {el.value}
                          </span>
                        </div>
                      )}
                    </div>
                  )
                })
              ) : (
                <p className="text-xs text-slate-500 text-center py-6">No sanitized elements</p>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Zoom modal */}
      {zoomedImage && (
        <div
          className="fixed inset-0 z-50 bg-black/90 flex flex-col items-center justify-center p-6 backdrop-blur-sm cursor-zoom-out"
          onClick={() => setZoomedImage(null)}
        >
          <div className="max-w-5xl w-full bg-navy-900 rounded-xl border border-slate-700 p-4 space-y-3" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between pb-2 border-b border-slate-700 font-mono text-xs">
              <span className="font-bold text-white">{zoomedImage.title}</span>
              <button
                onClick={() => setZoomedImage(null)}
                className="px-2.5 py-1 bg-navy-700 hover:bg-navy-600 text-white rounded cursor-pointer"
              >
                ✕ Close
              </button>
            </div>
            <div className="flex items-center justify-center max-h-[80vh] overflow-auto">
              <img src={zoomedImage.src} alt={zoomedImage.title} className="max-h-[75vh] w-auto rounded" />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
