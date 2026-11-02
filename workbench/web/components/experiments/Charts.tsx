"use client";

import type { Evaluation } from "@/lib/types";

const W = 320;
const H = 240;
const PAD = { l: 56, r: 12, t: 12, b: 40 };
const iw = W - PAD.l - PAD.r;
const ih = H - PAD.t - PAD.b;
const sx = (v: number) => PAD.l + v * iw;
const sy = (v: number, max = 1) => PAD.t + ih - (v / max) * ih;

function Axes({ xLabel, yLabel, yMax = 1, yTicks = [0, 0.5, 1] }: { xLabel: string; yLabel: string; yMax?: number; yTicks?: number[] }) {
  return (
    <g fontSize={11} fill="#545b61">
      <line x1={PAD.l} y1={PAD.t + ih} x2={PAD.l + iw} y2={PAD.t + ih} stroke="#bab5aa" />
      <line x1={PAD.l} y1={PAD.t} x2={PAD.l} y2={PAD.t + ih} stroke="#bab5aa" />
      {[0, 0.5, 1].map((t) => (
        <g key={`x${t}`}>
          <line x1={sx(t)} y1={PAD.t + ih} x2={sx(t)} y2={PAD.t + ih + 4} stroke="#bab5aa" />
          <text x={sx(t)} y={PAD.t + ih + 16} textAnchor="middle">
            {t}
          </text>
        </g>
      ))}
      {yTicks.map((t) => (
        <g key={`y${t}`}>
          <line x1={PAD.l - 4} y1={sy(t, yMax)} x2={PAD.l} y2={sy(t, yMax)} stroke="#bab5aa" />
          <line x1={PAD.l} y1={sy(t, yMax)} x2={PAD.l + iw} y2={sy(t, yMax)} stroke="#e4e2dd" />
          <text x={PAD.l - 7} y={sy(t, yMax) + 4} textAnchor="end">
            {Number(t.toFixed(3))}
          </text>
        </g>
      ))}
      <text x={PAD.l + iw / 2} y={H - 6} textAnchor="middle" fill="#1e2327" fontWeight={600}>
        {xLabel}
      </text>
      <text x={11} y={PAD.t + ih / 2} textAnchor="middle" transform={`rotate(-90 11 ${PAD.t + ih / 2})`} fill="#1e2327" fontWeight={600}>
        {yLabel}
      </text>
    </g>
  );
}

export function CalibrationChart({ cal }: { cal: Evaluation["calibration"] }) {
  const pts = cal.bins.filter((b) => b.n > 0 && b.mean_score !== null && b.fraction_positive !== null);
  const maxN = Math.max(1, ...pts.map((p) => p.n));
  return (
    <figure>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full max-w-[420px]" role="img" aria-label={`Reliability diagram: ${pts.length} non-empty score bins. Brier ${cal.brier?.toFixed(3) ?? "n/a"}, ECE ${cal.ece?.toFixed(3) ?? "n/a"}.`} data-testid="calibration-chart">
        <Axes xLabel="Mean score in bin" yLabel="Fraction positive" />
        <line x1={sx(0)} y1={sy(0)} x2={sx(1)} y2={sy(1)} stroke="#8f989b" strokeDasharray="4 4" />
        <polyline points={pts.map((p) => `${sx(p.mean_score!)},${sy(p.fraction_positive!)}`).join(" ")} fill="none" stroke="#0b6766" strokeWidth={2} />
        {pts.map((p) => (
          <circle key={p.lo} cx={sx(p.mean_score!)} cy={sy(p.fraction_positive!)} r={3 + 5 * Math.sqrt(p.n / maxN)} fill="#0b6766" fillOpacity={0.75} stroke="#fff" strokeWidth={1}>
            <title>
              Scores {p.lo.toFixed(1)}–{p.hi.toFixed(1)}: n={p.n}, mean score {p.mean_score!.toFixed(2)}, fraction positive {p.fraction_positive!.toFixed(2)}
            </title>
          </circle>
        ))}
      </svg>
      <figcaption className="text-micro text-graphite">Dashed line: perfect calibration. Dot area grows with the number of items in the bin.</figcaption>
    </figure>
  );
}

export function CoverageChart({ curve }: { curve: Evaluation["coverage_curve"] }) {
  const pts = curve.filter((c) => c.error_rate !== null);
  const yMax = Math.max(0.1, ...pts.map((p) => p.error_rate ?? 0));
  const nice = yMax <= 0.25 ? 0.25 : yMax <= 0.5 ? 0.5 : 1;
  return (
    <figure>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full max-w-[420px]" role="img" aria-label={`Coverage versus error: ${pts.length} points. At full coverage the error rate is ${pts[0]?.error_rate?.toFixed(2) ?? "n/a"}.`} data-testid="coverage-chart">
        <Axes xLabel="Coverage (share of items not abstained)" yLabel="Error rate" yMax={nice} yTicks={[0, nice / 2, nice]} />
        <polyline points={pts.map((p) => `${sx(p.coverage)},${sy(p.error_rate!, nice)}`).join(" ")} fill="none" stroke="#b9770e" strokeWidth={2} />
        {pts.map((p) => (
          <circle key={p.coverage} cx={sx(p.coverage)} cy={sy(p.error_rate!, nice)} r={3.5} fill="#b9770e" stroke="#fff" strokeWidth={1}>
            <title>
              Coverage {(p.coverage * 100).toFixed(0)}% ({p.n_kept} kept): error rate {(p.error_rate! * 100).toFixed(1)}%
            </title>
          </circle>
        ))}
      </svg>
      <figcaption className="text-micro text-graphite">Abstaining on the items closest to the threshold first. Abstention means a person reviews them; nothing is dismissed.</figcaption>
    </figure>
  );
}
