import { BrowserRouter, Routes, Route, NavLink, Navigate } from 'react-router-dom'
import { useState, useEffect } from 'react'
import { Shield, Eye, BarChart2 } from 'lucide-react'
import Metrics from './pages/Metrics'
import LiveSession from './pages/LiveSession'

const navItems = [
  { path: '/',        label: 'Evaluation Metrics', icon: BarChart2 },
  { path: '/session', label: 'Live Session',        icon: Eye },
]

function StatusBar() {
  const [serverOk, setServerOk] = useState<boolean | null>(null)

  useEffect(() => {
    fetch('http://localhost:8000/api/health')
      .then(r => r.ok ? setServerOk(true) : setServerOk(false))
      .catch(() => setServerOk(false))
  }, [])

  return (
    <div className="flex items-center gap-4 text-xs text-slate-400 font-mono">
      <div className="flex items-center gap-1.5">
        <span className={`w-2 h-2 rounded-full ${serverOk === true ? 'bg-emerald-400 animate-pulse' : serverOk === false ? 'bg-red-400' : 'bg-slate-500'}`} />
        <span>Server {serverOk === true ? 'Online' : serverOk === false ? 'Offline' : 'Connecting...'}</span>
      </div>
      <div className="flex items-center gap-1.5">
        <span className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse" />
        <span className="text-emerald-400 font-bold">0 Raw PII Sent</span>
      </div>
    </div>
  )
}

function Sidebar() {
  return (
    <aside className="w-60 min-h-screen bg-navy-800 border-r border-slate-700/60 flex flex-col">
      {/* Logo */}
      <div className="p-5 border-b border-slate-700/60">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-cyan-400 to-blue-600 flex items-center justify-center shadow-lg shadow-cyan-500/20">
            <Shield className="w-5 h-5 text-white" />
          </div>
          <div>
            <div className="font-bold text-sm text-white tracking-wide">PrivSight</div>
            <div className="text-[10px] text-cyan-400 font-mono">SIH 171 Judges Console</div>
          </div>
        </div>
      </div>

      {/* Navigation: Exactly the 2 requested pages */}
      <nav className="flex-1 p-3 flex flex-col gap-1.5 mt-2">
        {navItems.map(({ path, label, icon: Icon }) => (
          <NavLink
            key={path}
            to={path}
            end={path === '/'}
            className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
          >
            <Icon className="w-4 h-4" />
            <span className="font-semibold text-xs">{label}</span>
          </NavLink>
        ))}
      </nav>

      {/* Bottom badge */}
      <div className="p-4 border-t border-slate-700/60">
        <div className="text-[10px] text-slate-500 text-center leading-relaxed font-mono">
          SIH Problem Statement 171<br />
          <span className="text-cyan-400 font-bold">Privacy-Preserving Agent</span>
        </div>
      </div>
    </aside>
  )
}

function App() {
  return (
    <BrowserRouter>
      <div className="flex min-h-screen bg-navy-900">
        <Sidebar />
        <div className="flex-1 flex flex-col">
          {/* Clean Top Bar */}
          <header className="h-14 border-b border-slate-700/60 bg-navy-800/80 backdrop-blur flex items-center justify-between px-6">
            <h1 className="text-xs font-bold text-slate-300 font-mono tracking-wider uppercase">
              Privacy-Preserving On-Device Visual Perception & AI Reasoning
            </h1>
            <StatusBar />
          </header>

          {/* Page Content: Exactly 2 pages */}
          <main className="flex-1 overflow-auto p-6">
            <Routes>
              <Route path="/"        element={<Metrics />} />
              <Route path="/metrics" element={<Metrics />} />
              <Route path="/session" element={<LiveSession />} />
              {/* Fallback redirect */}
              <Route path="*"        element={<Navigate to="/" replace />} />
            </Routes>
          </main>
        </div>
      </div>
    </BrowserRouter>
  )
}

export default App
