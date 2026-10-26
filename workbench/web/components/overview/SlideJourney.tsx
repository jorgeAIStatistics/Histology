"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { LazyMotion, domAnimation, m, useReducedMotion, useScroll, useTransform, type MotionValue } from "motion/react";
import data from "@/lib/overview-data.json";
import { cn } from "@/components/ui/cn";

/*
  One slide, five steps. Everything drawn over the tissue was computed by this prototype's own code on the public CC0
  slide (scripts/build_overview_assets.py): the background mask by the QC screen, the 41 squares by feature extraction.
  The outline in step 3 is the one illustrative element, and says so. The slide carries no diagnosis.
*/

const W = data.width;
const H = data.height;
const fmt = new Intl.NumberFormat("en-US");
const tissuePct = `${(data.tissue.fraction * 100).toFixed(1)}%`;
const nPatches = data.patches.coords.length;
const [EW, EH] = data.patches.extent;
const patchMicrons = Math.round(data.patches.patch_size * data.patches.target_mpp);
const hashShort = `${data.sha256.slice(0, 8)}…${data.sha256.slice(-4)}`;

// Level-0 pixel coordinates, the same space the viewer stores outlines in.
const OUTLINE = "1110,1912 1388,1850 1465,2128 1357,2297 1141,2266 1064,2097";

type Step = { title: string; body: ReactNode; href: string; screen: string; who: string };

const STEPS: Step[] = [
  {
    title: "The slide arrives with its place in the case",
    who: "Histology assistant",
    body: (
      <>
        The file is checked against its SHA-256, read with OpenSlide and linked to a coded patient, case, part, block and level. Patients appear only as
        codes. Label and macro images, which can carry names, are never shown.
      </>
    ),
    href: "/worklist",
    screen: "Worklist",
  },
  {
    title: "The screen finds tissue; people record the problems",
    who: "Assistant, then pathologist",
    body: (
      <>
        An automated screen counts {tissuePct} of this image as tissue and gives a rough focus measure; both are experimental. Folds, chatter and stain
        problems are recorded by hand, each linked to an action and an outcome. A flag never orders a recut.
      </>
    ),
    href: "/review",
    screen: "Slide Review",
  },
  {
    title: "A pathologist outlines and labels, looking first",
    who: "Pathologist",
    body: (
      <>
        Outlines are stored in full-resolution pixel coordinates and versioned with author, time and reason. Any suggestion can be accepted, corrected,
        rejected or hidden. In independent review it stays hidden until the reader has recorded a view.
      </>
    ),
    href: "/review",
    screen: "Slide Review",
  },
  {
    title: "Patches at a known scale",
    who: "Research lead",
    body: (
      <>
        Feature extraction keeps {nPatches} squares of {data.patches.patch_size} pixels at {data.patches.target_mpp} µm per pixel, about {patchMicrons} µm
        across, wherever at least half the square is tissue, and skips any region a person excluded.
      </>
    ),
    href: "/experiments",
    screen: "Experiments",
  },
  {
    title: "Frozen into a dataset, or left out with the reason",
    who: "Research lead",
    body: (
      <>
        A dataset version keeps every slide of a patient in one split, records image hashes and label versions, and locks the test split away from
        training. This public slide has no expert label, so a dataset leaves it out and records why.
      </>
    ),
    href: "/dataset",
    screen: "Dataset",
  },
];

/** Index of the step whose block crosses the middle of the viewport (0 = the introduction). */
function useActiveStep(refs: React.RefObject<(HTMLElement | null)[]>) {
  const [active, setActive] = useState(0);
  useEffect(() => {
    const els = (refs.current ?? []).filter(Boolean) as HTMLElement[];
    if (!els.length) return;
    // Wide screens read beside the slide (a band at mid-height); narrow screens read below it (a band lower down).
    const wide = window.matchMedia("(min-width: 1024px)").matches;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) setActive(Number((e.target as HTMLElement).dataset.step));
      },
      { rootMargin: wide ? "-48% 0px -48% 0px" : "-76% 0px -20% 0px" },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [refs]);
  return [active, setActive] as const;
}

type Fact = { value: string; label: string };

const READOUT: Fact[][] = [
  [],
  [
    { value: data.format, label: "format" },
    { value: `${fmt.format(W)} × ${fmt.format(H)}`, label: "pixels" },
    { value: `${data.mpp[0]} µm`, label: "per pixel" },
    { value: hashShort, label: "SHA-256" },
  ],
  [
    { value: tissuePct, label: "of the image counted as tissue" },
    { value: "Experimental", label: "uncalibrated screen; people confirm" },
  ],
  [
    { value: "Version 2", label: "region of interest, with reason" },
    { value: "Illustrative", label: "this public slide has no diagnosis" },
  ],
  [
    { value: `${nPatches} of ${data.patches.grid_cells}`, label: "grid cells kept as patches" },
    { value: `${data.patches.patch_size} px`, label: `at ${data.patches.target_mpp} µm per pixel` },
    { value: `≥ ${Math.round(data.patches.min_tissue_fraction * 100)}%`, label: "tissue in each patch" },
  ],
  [
    { value: "Left out", label: "of any dataset version" },
    { value: "No expert label", label: "the reason recorded" },
    { value: hashShort, label: "image hash" },
  ],
];

/** Facts for the current step, under the slide so nothing covers the tissue. */
function Readout({ active }: { active: number }) {
  return (
    <div aria-hidden className="relative hidden h-[58px] border-t border-white/10 sm:block">
      {READOUT.map((facts, i) => (
        <dl
          key={i}
          className={cn(
            "absolute inset-0 flex items-center gap-x-5 overflow-hidden px-4 transition-[opacity,transform] duration-500 ease-out sm:gap-x-7",
            active === i ? "translate-y-0 opacity-100" : "translate-y-1 opacity-0",
          )}
        >
          {facts.map((f) => (
            <div key={f.label} className="flex min-w-0 flex-col-reverse">
              <dt className="truncate text-micro text-stage-ink/75">{f.label}</dt>
              <dd className="tabular truncate text-body font-bold leading-tight text-white">{f.value}</dd>
            </div>
          ))}
        </dl>
      ))}
    </div>
  );
}

function Stage({ active, scale }: { active: number; scale: MotionValue<number> | number }) {
  const dim = active === 2 || active === 4 || active === 5;
  return (
    <figure className="flex h-full flex-col overflow-hidden rounded-[var(--radius-panel)] bg-stage" aria-labelledby="journey-caption">
      <div className="relative min-h-0 flex-1 p-4 sm:p-6">
        {/* Size container: the slide box is the largest W:H rectangle that fits, so every overlay stays registered. */}
        <div className="flex h-full w-full items-center justify-center [container-type:size]">
        <m.div style={{ scale, width: `min(100cqw, calc(100cqh * ${W} / ${H}))` }} className="relative" data-testid="journey-stage">
          <div className="relative w-full overflow-hidden rounded-[3px]" style={{ aspectRatio: `${W} / ${H}` }}>
            <img
              src="/overview/cmu-720.webp"
              srcSet="/overview/cmu-720.webp 720w, /overview/cmu-1200.webp 1200w"
              sizes="(min-width: 1024px) 34vw, 70vw"
              width={W}
              height={H}
              alt="Skin tissue stained with haematoxylin and eosin, from a public CC0 test slide"
              className="block h-full w-full object-contain"
              fetchPriority="high"
            />
            {/* Background (not tissue, according to the QC screen) fades into the stage. */}
            <div
              aria-hidden
              className={cn("absolute inset-0 bg-stage transition-opacity duration-700 ease-out", dim ? "opacity-[0.88]" : "opacity-0")}
              style={{
                maskImage: "url(/overview/background-mask.png)",
                WebkitMaskImage: "url(/overview/background-mask.png)",
                maskSize: "100% 100%",
                WebkitMaskSize: "100% 100%",
              }}
            />
            <svg aria-hidden viewBox={`0 0 ${W} ${H}`} className="absolute inset-0 h-full w-full" preserveAspectRatio="none">
              <g className={cn("transition-opacity duration-500", active === 3 ? "opacity-100" : "opacity-0")}>
                <polygon points={OUTLINE} fill="rgba(127,211,207,0.14)" stroke="#1e2327" strokeWidth={16} strokeLinejoin="round" />
                <polygon points={OUTLINE} fill="none" stroke="#7fd3cf" strokeWidth={7} strokeLinejoin="round" />
              </g>
              <g>
                {data.patches.coords.map(([x, y], i) => (
                  <rect
                    key={`${x}-${y}`}
                    x={x + 6}
                    y={y + 6}
                    width={EW - 12}
                    height={EH - 12}
                    fill="rgba(240,180,76,0.10)"
                    stroke="#f0b44c"
                    strokeWidth={5}
                    className="transition-opacity duration-300"
                    style={{
                      opacity: active === 4 ? 1 : active === 5 ? 0.3 : 0,
                      transitionDelay: active === 4 ? `${i * 14}ms` : "0ms",
                    }}
                  />
                ))}
              </g>
            </svg>
            {/* Page-load sweep, top to bottom, the way a scanner reads a slide in strips (CSS; off with reduced motion). */}
            <div aria-hidden className="wb-scan-cover absolute inset-0 bg-stage">
              <span className="absolute inset-x-0 top-0 h-[2px] bg-[#7fd3cf] shadow-[0_0_14px_3px_rgba(127,211,207,0.55)]" />
            </div>

          </div>
        </m.div>
        </div>
      </div>
      <Readout active={active} />
      <figcaption id="journey-caption" className="border-t border-white/10 px-4 py-2 text-micro text-stage-ink/85">
        <span className="sm:hidden">Public CC0 test slide, not a patient; no diagnosis shown or inferred.</span>
        <span className="hidden sm:inline">
          Public CC0 test slide CMU-1-Small-Region (OpenSlide test data). Not a patient of this lab; no diagnosis is shown or inferred.
        </span>
      </figcaption>
    </figure>
  );
}

export function SlideJourney() {
  const reduced = useReducedMotion();
  const root = useRef<HTMLDivElement>(null);
  const stepRefs = useRef<(HTMLElement | null)[]>([]);
  const [active] = useActiveStep(stepRefs);
  const { scrollYProgress } = useScroll({ target: root, offset: ["start start", "end end"] });
  // A slow push-in while the steps pass: the stage gets closer to the tissue as the story gets more specific.
  const scale = useTransform(scrollYProgress, [0, 1], [1, 1.07]);
  const rail = useTransform(scrollYProgress, [0.1, 0.84], [0, 1]);

  return (
    <LazyMotion features={domAnimation} strict>
      <div ref={root} className="relative grid gap-x-10 lg:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)] xl:gap-x-16" data-testid="slide-journey">
        <section
          aria-labelledby="hero"
          ref={(el) => {
            stepRefs.current[0] = el;
          }}
          data-step={0}
          className="lg:col-start-1 lg:row-start-1 flex min-h-[56vh] flex-col justify-center py-10 lg:min-h-[calc(100dvh-var(--wb-header-h,56px)-32px)] lg:py-0"
        >
          <p className="text-small font-semibold text-teal-deep">Why this matters</p>
          <h1 id="hero" className="mt-3 max-w-[16ch] text-[clamp(2.4rem,1.15rem+2.9vw,3.7rem)] font-bold leading-[1.04] tracking-[-0.025em] text-ink">
            More time for the cases that need a pathologist&rsquo;s judgement.
          </h1>
          <p className="mt-6 max-w-[52ch] text-lead text-graphite">
            A research prototype built around how the lab already works. It links slide quality, expert review and honest evaluation, so a small pilot can
            measure whether repetitive work actually goes down. The pathologist defines what matters, reviews every suggestion and stays in control.
          </p>
          <p className="mt-4 max-w-[56ch] text-small text-graphite">
            Research use only. Fictional workflow records, procedural synthetic images and one public CC0 test slide. No patient data, no diagnostic
            capability, and no endorsement by any physician or employer is implied.
          </p>
          <p className="mt-8 text-small font-semibold text-ink">Scroll to follow one slide through the workbench.</p>
        </section>

        {/* The stage: sticky beside the text on wide screens, sticky above the steps on narrow ones. */}
        <div className="sticky top-[var(--wb-header-h,56px)] z-20 -mx-4 h-[46vh] bg-paraffin px-4 pb-2 pt-3 md:-mx-8 md:px-8 lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:mx-0 lg:h-[calc(100dvh-var(--wb-header-h,56px)-20px)] lg:max-h-[900px] lg:self-start lg:px-0 lg:pb-0">
          <Stage active={active} scale={reduced ? 1 : scale} />
        </div>

        <ol className="relative pb-[10vh] lg:col-start-1 lg:row-start-2 lg:pb-[24vh]" aria-label="One slide through the workbench">
          <span aria-hidden className="absolute bottom-[24vh] left-[15px] top-10 hidden w-[2px] bg-line lg:block" />
          {reduced ? null : (
            <m.span aria-hidden style={{ scaleY: rail }} className="absolute bottom-[24vh] left-[15px] top-10 hidden w-[2px] origin-top bg-teal lg:block" />
          )}
          {STEPS.map((s, i) => {
            const n = i + 1;
            const on = active === n;
            return (
              <li
                key={s.title}
                ref={(el) => {
                  stepRefs.current[n] = el;
                }}
                data-step={n}
                className="relative grid min-h-[46vh] grid-cols-[32px_minmax(0,1fr)] content-center gap-x-4 py-8 lg:min-h-[72vh]"
              >
                <span
                  aria-hidden
                  className={cn(
                    "relative z-[1] mt-0.5 flex h-8 w-8 items-center justify-center rounded-full border text-small font-bold transition-colors duration-300",
                    on ? "border-teal bg-teal text-white" : "border-line-strong bg-paraffin text-graphite",
                  )}
                >
                  {n}
                </span>
                <div>
                  <h2 className="text-title font-bold text-ink">{s.title}</h2>
                  <p className="mt-1 text-small text-graphite">{s.who}</p>
                  <p className="mt-3 max-w-[54ch] text-ink">{s.body}</p>
                  <Link href={s.href} className="mt-4 inline-flex text-small font-semibold text-teal-deep underline underline-offset-4 hover:text-teal">
                    Open {s.screen}
                  </Link>
                </div>
              </li>
            );
          })}
        </ol>
      </div>
    </LazyMotion>
  );
}
