/**
 * Original mark: a glass slide with its frosted label end and a stained
 * section (hematoxylin with an eosin counterstain). Abstract on purpose: it
 * must never resemble a real specimen finding.
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden focusable="false">
      <rect x="1.5" y="6" width="21" height="12" rx="2" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <rect x="2.25" y="6.75" width="5.5" height="10.5" rx="1.2" fill="currentColor" opacity="0.28" />
      <ellipse cx="15" cy="12" rx="4.6" ry="3.4" fill="currentColor" opacity="0.9" />
      <circle cx="16.6" cy="11.1" r="1.6" fill="var(--hlo-eosin-light)" />
    </svg>
  );
}
