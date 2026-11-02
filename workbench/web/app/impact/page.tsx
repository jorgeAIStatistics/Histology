import type { Metadata } from "next";
import { ImpactView } from "@/components/impact/ImpactView";

export const metadata: Metadata = { title: "Impact" };

// The calculator is client-side and needs no session: the director can open it directly.
export default function ImpactPage() {
  return <ImpactView />;
}
