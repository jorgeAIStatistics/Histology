import Link from "next/link";

export const metadata = { title: "Intake concepts" };

/** Index of the three Intake design concepts (lightweight previews, synthetic fixture). */
export default function ConceptsIndex() {
  const items = [
    { href: "/concepts/intake-a?item=INT-1014-032", label: "A · Precision workstation" },
    { href: "/concepts/intake-b?item=INT-1014-032", label: "B · Specimen atlas" },
    { href: "/concepts/intake-c?item=INT-1014-032", label: "C · Guided reconciliation desk" },
  ];
  return (
    <main className="mx-auto max-w-xl p-10">
      <h1 className="text-xl font-semibold">Intake design concepts (previews)</h1>
      <p className="mt-2 text-sm text-ink-secondary">Same synthetic fixture, same data, three compositions. Previews only; the working screen is /intake.</p>
      <ul className="mt-6 space-y-2">
        {items.map((i) => (
          <li key={i.href}>
            <Link className="text-brand underline" href={i.href}>
              {i.label}
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
