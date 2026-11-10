import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Brackets } from '../components/Brackets'
import { Navbar } from '../components/Navbar'
import { WalletModal } from '../components/WalletModal'
import { FEATURES, HERO, PRODUCT, PRODUCT_TABS, PROMISES, PROMPTS, TOP_BAR } from './content'
import { createRobotScene } from './robotScene'
import './landing.css'

const SECTIONS = ['INTRO', 'PRODUCT', 'PRIVACY'] as const

/** Auto-typing prompt: 38ms/char, hold 2.6s, delete 2 chars / 14ms, wait 250ms, next. */
function useTypingPrompt(prompts: string[]) {
  const [idx, setIdx] = useState(0)
  const [text, setText] = useState('')
  useEffect(() => {
    let cancelled = false
    let timer = 0
    let i = idx
    let n = 0
    const type = () => {
      if (cancelled) return
      const full = prompts[i]
      if (n < full.length) {
        n++
        setText(full.slice(0, n))
        timer = window.setTimeout(type, 38)
      } else timer = window.setTimeout(del, 2600)
    }
    const del = () => {
      if (cancelled) return
      n = Math.max(0, n - 2)
      setText(prompts[i].slice(0, n))
      if (n > 0) timer = window.setTimeout(del, 14)
      else
        timer = window.setTimeout(() => {
          i = (i + 1) % prompts.length
          setIdx(i)
          type()
        }, 250)
    }
    type()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [prompts])
  return { text, next: prompts[(idx + 1) % prompts.length] }
}

function TopBar({ hidden, onClose }: { hidden: boolean; onClose: () => void }) {
  return (
    <div className={`topbar ${hidden ? 'hidden' : ''}`}>
      <Link to="/app" className="topbar-text">
        <b>{TOP_BAR.strong}</b> {TOP_BAR.text} ↗
      </Link>
      <button className="topbar-x" onClick={onClose} aria-label="Dismiss announcement">
        ×
      </button>
    </div>
  )
}

function Rail({ active }: { active: number }) {
  return (
    <aside className="rail" aria-hidden="true">
      <div className="rail-dots">
        {Array.from({ length: 14 }, (_, i) => (
          <i key={i} />
        ))}
      </div>
      <div className="rail-label" style={{ top: `${[0, 31, 62][active]}%` }}>
        <svg width="11" height="11" viewBox="0 0 12 12">
          <circle cx="6" cy="6" r="4.6" fill="none" stroke="currentColor" />
          <path d="M6 6 L6 2.4" stroke="currentColor" />
        </svg>
        {SECTIONS[active]}
      </div>
      <div className="rail-menu">≡ MENU</div>
    </aside>
  )
}

function Avatar() {
  return (
    <svg className="avatar" viewBox="0 0 56 56" aria-hidden="true">
      <rect width="56" height="56" fill="#b5523b" />
      {Array.from({ length: 7 }, (_, r) =>
        Array.from({ length: 4 }, (_, c) => (
          <rect key={`${r}-${c}`} x={c * 16 - (r % 2) * 8 + 1} y={r * 8 + 1} width="14" height="6" fill="#c8664c" />
        )),
      )}
      <circle cx="28" cy="22" r="9" fill="#2b2420" />
      <path d="M10 56c2-12 9-18 18-18s16 6 18 18z" fill="#1d1d22" />
    </svg>
  )
}

export function Landing() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [scrolled, setScrolled] = useState(false)
  const [barClosed, setBarClosed] = useState(false)
  const [activeSection, setActiveSection] = useState(0)
  const [tab, setTab] = useState(0)
  const [tabAnimate, setTabAnimate] = useState(true)
  const [review, setReview] = useState(0)
  const [reviewFading, setReviewFading] = useState(false)
  const sectionRefs = useRef<(HTMLElement | null)[]>([])
  const typing = useTypingPrompt(PROMPTS)

  // three.js robot
  useEffect(() => {
    if (!canvasRef.current) return
    return createRobotScene(canvasRef.current)
  }, [])

  // top bar hides after 40px of scroll
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 40)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  // reveal-on-enter (.15) and rail section tracking (> half visible)
  useEffect(() => {
    const els = sectionRefs.current.filter(Boolean) as HTMLElement[]
    const reveal = new IntersectionObserver(
      (entries) =>
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add('in')
            reveal.unobserve(e.target)
          }
        }),
      { threshold: 0.15 },
    )
    const rail = new IntersectionObserver(
      (entries) =>
        entries.forEach((e) => {
          if (e.isIntersecting) setActiveSection(Number((e.target as HTMLElement).dataset.idx))
        }),
      { threshold: 0.5 },
    )
    els.forEach((el) => {
      reveal.observe(el)
      rail.observe(el)
    })
    return () => {
      reveal.disconnect()
      rail.disconnect()
    }
  }, [])

  // product tab carousel: one step every 2.4s, seamless wrap on the duplicate last tab
  useEffect(() => {
    const id = window.setInterval(() => {
      setTabAnimate(true)
      setTab((t) => t + 1)
    }, 2400)
    return () => clearInterval(id)
  }, [])
  useEffect(() => {
    if (tab < PRODUCT_TABS.length - 1) return
    const id = window.setTimeout(() => {
      setTabAnimate(false)
      setTab(0)
    }, 950)
    return () => clearTimeout(id)
  }, [tab])

  function stepReview(dir: 1 | -1) {
    if (reviewFading) return
    setReviewFading(true)
    window.setTimeout(() => {
      setReview((r) => (r + dir + PROMISES.length) % PROMISES.length)
      setReviewFading(false)
    }, 450)
  }

  const cur = PROMISES[review]
  const ghost = PROMISES[(review + 1) % PROMISES.length]
  const setSection = (i: number) => (el: HTMLElement | null) => {
    sectionRefs.current[i] = el
  }

  return (
    <div className="landing">
      <canvas ref={canvasRef} className="robot-canvas" aria-hidden="true" />
      <TopBar hidden={scrolled || barClosed} onClose={() => setBarClosed(true)} />
      <Navbar lifted={scrolled || barClosed} />
      <Rail active={activeSection} />

      {/* ---------- Section 1: Intro ---------- */}
      <section className="sec intro" ref={setSection(0)} data-idx={0}>
        <div className="prompt rv d1">
          <div className="prompt-tab">“</div>
          <div className="prompt-box">
            <Brackets />
            <span>{typing.text}</span>
            <span className="caret" />
          </div>
          <div className="prompt-next">{typing.next}</div>
        </div>
        <div className="intro-rule rv d1" />
        <ul className="features rv d2">
          {FEATURES.map((f) => (
            <li key={f}>
              <i />
              {f}
            </li>
          ))}
          <li className="dim">
            <i />
            And much more
          </li>
        </ul>
        <div className="hero-head">
          <p className="kicker rv d2">{HERO.kicker}</p>
          <h1 className="headline">
            <span className="hl hl-1 rv d3">{HERO.line1}</span>
            <br />
            <span className="hl hl-2 rv d4">{HERO.line2}</span>
          </h1>
        </div>
        <p className="sub rv d4">{HERO.sub}</p>
        <a
          className="scroll-link rv d4"
          href="#product"
          onClick={(e) => {
            e.preventDefault()
            sectionRefs.current[1]?.scrollIntoView({ behavior: 'smooth' })
          }}
        >
          <Brackets />
          SCROLL <span className="arrow">↓</span>
        </a>
        <div className="bottom-rule" />
      </section>

      {/* ---------- Section 2: Product ---------- */}
      <section className="sec product" id="product" ref={setSection(1)} data-idx={1}>
        <div className="tabs-viewport rv d1">
          <div
            className="tabs-strip"
            style={{
              transform: `translateX(calc(${-tab} * 33vw))`,
              transition: tabAnimate ? 'transform .9s cubic-bezier(.65,0,.2,1)' : 'none',
            }}
          >
            {PRODUCT_TABS.map((label, i) => (
              <div key={i} className={`ptab ${i === tab ? 'active' : i < tab ? 'past' : 'later'}`}>
                {i === tab && <Brackets />}
                <span className="ptab-num">{String((i % (PRODUCT_TABS.length - 1)) + 1).padStart(2, '0')}</span>
                <span className="ptab-label">{label}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="product-head">
          <p className="kicker rv d2">··</p>
          <h2 className="gateway">
            <span className="gw-box rv d3">{PRODUCT.line1}</span>
            <br />
            <span className="gw-line rv d4">{PRODUCT.line2}</span>
          </h2>
        </div>
      </section>

      {/* ---------- Section 3: Privacy promises ---------- */}
      <section className="sec reviews" ref={setSection(2)} data-idx={2}>
        <div className="rv-head rv d1">
          <span className="tst">
            PRVCY <span className="tst-num">01</span>
          </span>
          <Avatar />
          <span className="rv-name-wrap">
            <i className="rv-dot" />
            <span className={`rv-fade ${reviewFading ? 'out' : ''}`}>{cur.name}</span>
          </span>
          <span className={`rv-role rv-fade ${reviewFading ? 'out' : ''}`}>{cur.role}</span>
        </div>
        <div className="quote-wrap rv d2">
          <blockquote className={`quote rv-fade ${reviewFading ? 'out' : ''}`}>{cur.quote}</blockquote>
          <Link to="/app/chat" className="try">
            Try for yourself (Click Here)
          </Link>
        </div>
        <blockquote className="ghost">{ghost.quote}</blockquote>
        <div className="arrows rv d3">
          <button onClick={() => stepReview(-1)} aria-label="Previous">
            ←
          </button>
          <button onClick={() => stepReview(1)} aria-label="Next">
            →
          </button>
        </div>
      </section>

      <footer className="landing-footer">NEXORA · 2026</footer>
      <WalletModal />
    </div>
  )
}
