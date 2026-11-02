import Link from "next/link";
import type { Metadata } from "next";
import { SlideJourney } from "@/components/overview/SlideJourney";

export const metadata: Metadata = { title: "Why this matters" };

const STAGES = [
  { n: 1, title: "Intake and hierarchy", who: "Histology assistant", what: "Import a slide, keep patient code → case → part → block → slide together.", href: "/worklist", screen: "Worklist" },
  { n: 2, title: "Quality issue", who: "Assistant, then pathologist", what: "Record a fold or blur, the suggested action, the outcome and whether the slide stays usable.", href: "/review", screen: "Slide Review" },
  { n: 3, title: "Expert label", who: "Pathologist", what: "Look first, then see any suggestion. Accept, correct, reject or hide it. Approve the slide.", href: "/review", screen: "Slide Review" },
  { n: 4, title: "Frozen dataset", who: "Research lead", what: "Patients grouped into train, validation and test. Hashes recorded. The test set locked.", href: "/dataset", screen: "Dataset" },
  { n: 5, title: "Experiment and errors", who: "Research lead", what: "A reproducible run on synthetic data, with denominators, intervals and the error list.", href: "/experiments", screen: "Experiments" },
  { n: 6, title: "Economic impact", who: "Medical director", what: "Adjustable fictional assumptions, including the result when the pilot does not pay.", href: "/impact", screen: "Impact" },
];

const COMMITMENTS = [
  { title: "You decide.", body: "Accept, correct, reject or hide any suggestion. The original suggestion and your judgement are kept as separate records." },
  { title: "You look first.", body: "In independent review, suggestions stay hidden until you have recorded your own assessment." },
  { title: "Nothing happens automatically.", body: "No sign-out, no diagnosis sent anywhere, no stain or recut ordered, no slide dismissed, no case reprioritised." },
  { title: "Uncertainty stays visible.", body: "Unknown, out of scope and readers-disagree states are shown, not hidden. Overriding the software is one step." },
  { title: "Histology staff are part of the design.", body: "Extra scanning, quality recording or annotation work is measured, not shifted quietly onto technologists and assistants." },
];

function ToConfirm() {
  return <span className="ml-1 rounded-[3px] bg-amber-tint px-1 text-small font-semibold text-amber-ink">to confirm in our lab</span>;
}

const NOW_FUTURE: [string, string][] = [
  ["Imports one tested whole-slide format (Aperio SVS) and shows it with pan and zoom", "Detecting BCC on real slides: no model has been trained on real slides"],
  ["Keeps the patient → case → part → block → slide hierarchy, with coded IDs only", "Counting cells or mitoses"],
  ["Finds tissue and gives a rough blur screen, both experimental; staff record folds, chatter and staining by hand", "Automatic detection of specific artifact types"],
  ["Records expert labels and outlines, every change versioned with author, time and reason", "Precise lesion outlines, margins, biomarker scoring"],
  ["Freezes datasets, keeping each patient's slides on one side of the split", "Connection to the lab information system"],
  ["Runs a pipeline test on synthetic data, labelled PIPELINE TEST — NOT PATHOLOGY VALIDATION", "Any clinical use, which needs the appropriate regulatory pathway"],
  ["Shows results with denominators and confidence limits; an adjustable cost calculator with fictional defaults", ""],
];

export default function OverviewPage() {
  return (
    <div className="mx-auto max-w-[1280px] px-4 pb-20 pt-4 md:px-8 lg:pt-4">
      <SlideJourney />

      <section aria-labelledby="after" className="mt-6 grid gap-6 border-t border-line pt-10 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
        <div>
          <h2 id="after" className="text-title font-bold">
            After the freeze, synthetic data only
          </h2>
          <p className="mt-3 max-w-[48ch] text-graphite">
            Training and evaluation run end to end, but on synthetic embeddings. They prove the plumbing, not pathology performance, and every result says so.
          </p>
        </div>
        <ul className="grid gap-x-8 gap-y-5 sm:grid-cols-2">
          <li className="border-l-[3px] border-hema pl-3">
            <p className="font-bold text-ink">Experiments</p>
            <p className="mt-0.5 text-small text-graphite">
              A reproducible run with denominators, patient-cluster intervals and the error list, under the banner &ldquo;PIPELINE TEST — NOT PATHOLOGY
              VALIDATION&rdquo;.
            </p>
            <Link href="/experiments" className="mt-1.5 inline-flex text-small font-semibold text-teal-deep underline underline-offset-4">
              Open Experiments
            </Link>
          </li>
          <li className="border-l-[3px] border-amber pl-3">
            <p className="font-bold text-ink">Impact</p>
            <p className="mt-0.5 text-small text-graphite">Adjustable fictional assumptions, including the result when the pilot does not pay.</p>
            <Link href="/impact" className="mt-1.5 inline-flex text-small font-semibold text-teal-deep underline underline-offset-4">
              Open Impact
            </Link>
          </li>
        </ul>
      </section>

      <section aria-labelledby="commitment" className="mt-16 border-t border-line pt-10">
        <div className="grid gap-8 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
          <div>
            <h2 id="commitment" className="text-title font-bold">
              We build this to augment pathologists, not to replace them.
            </h2>
            <p className="mt-3 max-w-[48ch] text-graphite">
              That is a commitment about how the product behaves, not a forecast about jobs. The business case counts freed capacity, less repetitive
              work, consistency and service quality. It does not count reductions in pathologist headcount.
            </p>
          </div>
          <ul className="grid gap-x-8 gap-y-5 sm:grid-cols-2">
            {COMMITMENTS.map((c) => (
              <li key={c.title} className="border-l-[3px] border-teal pl-3">
                <p className="font-bold text-ink">{c.title}</p>
                <p className="mt-0.5 text-small text-graphite">{c.body}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section aria-labelledby="six" className="mt-16 border-t border-line pt-10">
        <h2 id="six" className="text-title font-bold">
          Six questions, answered plainly
        </h2>
        <ol className="mt-6 grid gap-x-12 gap-y-9 lg:grid-cols-2">
          <li>
            <h3 className="font-bold text-ink">1. What does the assistant or technologist do today?</h3>
            <p className="mt-1.5 max-w-[62ch] text-graphite">
              Receives and checks specimens and parts, supports grossing, then processes, embeds, cuts, stains and labels slides, matches each slide to its
              case and part, checks quality, and returns slides for recuts or re-stains when needed.
              <ToConfirm /> How slide-quality problems and their fixes are recorded today is also to be confirmed.
            </p>
          </li>
          <li>
            <h3 className="font-bold text-ink">2. What does the pathologist do today?</h3>
            <p className="mt-1.5 max-w-[62ch] text-graphite">
              Reviews glass slides under the microscope, by the founder&rsquo;s understanding several hundred a day
              <ToConfirm />. For each case they decide the diagnosis, order levels or stains when needed, and sign out. Many routine skin biopsies need careful
              but repetitive screening; the hardest cases need the most judgement.
            </p>
          </li>
          <li>
            <h3 className="font-bold text-ink">3. Which repetitive task does this pilot target?</h3>
            <div className="mt-1.5 max-w-[62ch] space-y-2 text-graphite">
              <p>
                <strong className="text-ink">Histology:</strong> recording slide-quality issues so that each one is linked to the action taken, its outcome, and
                whether the slide can be used for research.
              </p>
              <p>
                <strong className="text-ink">Pathology:</strong> labelling approved, de-identified H&amp;E skin biopsies as BCC present or BCC absent, with
                indeterminate and inadequate allowed, using as little pathologist time as possible. BCC absent does not mean benign: it may include other
                cancers, inflammation or look-alikes.
              </p>
              <p>Whether a suggestion could later reduce repetitive review is a separate, later question, tested in shadow mode with no effect on care.</p>
            </div>
          </li>
          <li>
            <h3 className="font-bold text-ink">4. What does the software do now, and what is future work?</h3>
            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-left text-small">
                <caption className="sr-only">What works now versus future capabilities</caption>
                <thead>
                  <tr className="border-b border-line-strong">
                    <th scope="col" className="py-1.5 pr-4 font-semibold text-ink">Works now (prototype)</th>
                    <th scope="col" className="py-1.5 font-semibold text-ink">Future (needs models, data, validation)</th>
                  </tr>
                </thead>
                <tbody>
                  {NOW_FUTURE.map(([now, future]) => (
                    <tr key={now} className="border-b border-line align-top">
                      <td className="py-1.5 pr-4 text-ink">{now}</td>
                      <td className="py-1.5 text-graphite">{future}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-small text-graphite">The prototype does not assume the lab has a scanner or that slides are digitised.</p>
          </li>
          <li>
            <h3 className="font-bold text-ink">5. What stays under physician judgement?</h3>
            <p className="mt-1.5 max-w-[62ch] text-graphite">
              Everything clinical. Every diagnosis. Every label that becomes ground truth. Whether a quality flag matters and whether to recut or re-stain.
              The definition of the research task. Settling disagreements between readers. The decision to continue or stop the pilot.
            </p>
          </li>
          <li>
            <h3 className="font-bold text-ink">6. Which measurements tell us whether the pilot is worthwhile?</h3>
            <ul className="mt-1.5 max-w-[62ch] list-disc space-y-1 pl-5 text-graphite marker:text-line-strong">
              <li>Histology minutes per slide for quality recording, plus the extra minutes for any scanning.</li>
              <li>The share of quality issues with a recorded action and outcome, and the time to resolve them.</li>
              <li>Pathologist minutes per labelled case, and agreement between readers.</li>
              <li>Later, in a reader study: errors, time per case and workload, with the tool versus without it. A model score alone cannot show that it helps physicians.</li>
            </ul>
            <p className="mt-3 max-w-[62ch] rounded-[var(--radius-control)] border border-amber/60 bg-amber-tint/60 px-3 py-2 text-small text-ink">
              The pilot is not worthwhile if added scanning and annotation outweigh the time released, if readers make more errors or work more slowly with
              the tool, or if the data cannot be handled within the agreed authorisations. Those results would be reported, not hidden.
            </p>
          </li>
        </ol>
      </section>

      <section aria-labelledby="start" className="mt-16 grid gap-8 rounded-[var(--radius-panel)] border border-line bg-surface p-5 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:p-8">
        <div>
          <h2 id="start" className="text-title font-bold text-ink">
            Start the walkthrough
          </h2>
          <p className="mt-2 max-w-[44ch] text-graphite">
            Choose the histology assistant role, open case DEMO-S26-0003 and follow the six steps. Each step names the role that does it.
          </p>
          <Link href="/worklist" className="mt-5 inline-flex h-10 items-center rounded-[var(--radius-control)] bg-teal px-4 font-semibold text-white hover:bg-teal-deep">
            Open the worklist
          </Link>
        </div>
        <figure aria-labelledby="walkthrough-caption">
          <figcaption id="walkthrough-caption">
            <span className="block font-bold text-ink">The five-minute walkthrough</span>
            <span className="block text-small text-graphite">One fictional case, end to end</span>
          </figcaption>
          <ol className="mt-4">
            {STAGES.map((s, i) => (
              <li key={s.n} className="relative grid grid-cols-[2rem_minmax(0,1fr)_auto] gap-x-3 pb-4 last:pb-0">
                {i < STAGES.length - 1 ? <span aria-hidden className="absolute bottom-0 left-[0.95rem] top-8 w-px bg-line-strong" /> : null}
                <span className="relative z-10 flex h-8 w-8 items-center justify-center rounded-full border border-teal/40 bg-teal-tint text-small font-bold text-teal-deep">{s.n}</span>
                <div className="min-w-0 pt-0.5">
                  <p className="font-semibold text-ink">{s.title}</p>
                  <p className="text-small text-graphite">
                    {s.who}. {s.what}
                  </p>
                </div>
                <Link href={s.href} className="self-start rounded px-1 pt-1 text-small font-semibold text-teal-deep underline-offset-2 hover:underline">
                  {s.screen}
                </Link>
              </li>
            ))}
          </ol>
        </figure>
      </section>
    </div>
  );
}
