/** Skip links (spec §9 2.4.3): first in tab order, visible on focus. */
export function SkipLinks() {
  const cls =
    "sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-[80] focus:rounded-md focus:bg-surface focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-brand focus:shadow-3";
  return (
    <div data-shell-chrome>
      <a href="#scan-field" className={cls}>
        Skip to scan field
      </a>
      <a href="#main" className={cls}>
        Skip to main content
      </a>
    </div>
  );
}
