/** Four small rounded corner brackets that sit just outside the parent box (parent must be position: relative). */
export function Brackets({ className = '' }: { className?: string }) {
  return (
    <span className={`brk ${className}`} aria-hidden="true">
      <i className="tl" />
      <i className="tr" />
      <i className="bl" />
      <i className="br" />
    </span>
  )
}
