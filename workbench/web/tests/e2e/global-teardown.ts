import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

// Removes the temporary data directories created by start-backend.mjs (database, private object store, uploads).
export default function globalTeardown() {
  const ledger = path.resolve(__dirname, "../../test-results/.e2e-var-dirs");
  if (!existsSync(ledger)) return;
  for (const dir of readFileSync(ledger, "utf8").split("\n").map((l) => l.trim()).filter(Boolean)) {
    if (path.basename(dir).startsWith("wb-e2e-")) rmSync(dir, { recursive: true, force: true });
  }
  rmSync(ledger, { force: true });
}
