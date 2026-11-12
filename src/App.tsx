import { BrowserRouter, Link, Route, Routes } from 'react-router-dom'
import { AppLayout, Guides } from './components/Layouts'
import { Landing } from './landing/Landing'
import { Chat } from './pages/Chat'
import { Dashboard } from './pages/Dashboard'
import { Funding } from './pages/Funding'
import { Receipts } from './pages/Receipts'
import { Settings } from './pages/Settings'
import { ClientProvider } from './client/ClientProvider'
import { ToastProvider } from './components/toast'
import { NearProvider } from './wallet/NearProvider'

function NotFound() {
  return (
    <main className="app-main">
      <div className="card empty">
        <span className="label">404</span>
        <h3 style={{ marginTop: 10 }}>This page does not exist</h3>
        <p className="muted">Check the address, or head back to the start.</p>
        <Link className="btn" to="/">
          Home
        </Link>
      </div>
    </main>
  )
}

export default function App() {
  return (
    <NearProvider>
      <ClientProvider>
        <ToastProvider>
      <BrowserRouter>
        <Guides />
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/app" element={<AppLayout />}>
            <Route index element={<Dashboard />} />
            <Route path="chat" element={<Chat />} />
            <Route path="funding" element={<Funding />} />
            <Route path="receipts" element={<Receipts />} />
            <Route path="settings" element={<Settings />} />
          </Route>
          <Route path="*" element={<NotFound />} />
        </Routes>
      </BrowserRouter>
        </ToastProvider>
      </ClientProvider>
    </NearProvider>
  )
}
