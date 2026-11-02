// Integration simulator (contract "hlos.source-message" 1.0, docs/release/integration-contract.md).
//
//   npm run integration:sim -- list
//   npm run integration:sim -- <scenario|number|all> [--url http://localhost:3100]
//   npm run integration:sim -- <scenario|number|all> --in-process
//
// It plays a SIMULATED source system: deterministic synthetic envelopes built from the seed's records (a fresh
// in-memory copy of the synthetic seed, never the app's database) and new synthetic patients, signed with
// HMAC-SHA256, delivered with a per-request timeout, exponential backoff with jitter, a maximum number of
// attempts and no retry after a 4xx NAK.
//
// Over HTTP (default) it talks ONLY to a loopback URL (localhost, 127.0.0.1, ::1); anything else is refused.
// The app must run in synthetic demo mode with HLOS_INTEGRATION_SIMULATOR=1, and both sides need the same
// HLOS_INTEGRATION_SIM_SECRET (32+ characters), e.g.:
//   export HLOS_INTEGRATION_SIM_SECRET=$(openssl rand -hex 32)
//   HLOS_MODE=demo HLOS_INTEGRATION_SIMULATOR=1 npm run dev        # terminal 1
//   npm run integration:sim -- all                                  # terminal 2
//
// --in-process runs the same signature, envelope and payload checks against a fresh in-memory synthetic seed
// (no server, nothing written to disk), including the local half of scenario 9.
//
// Options:
//   --url <base or endpoint>   default http://localhost:3100 (the dev server)
//   --request AR-0001          scenario 9: the laboratory's accession request id to acknowledge
//   --accession D26-04818      scenario 9: the number the source holds for it (omit to acknowledge the request only)
//   --namespace "EMA-SIM DERM" scenario 9 (default EMA-SIM DERM)
//   --delay-ms 5000            scenario 9: how late the acknowledgment arrives
//   --max-attempts 5  --timeout-ms 5000  --base-delay-ms 500  --max-delay-ms 8000
//
// Exit code: 0 when every step got the expected answer (a "duplicate" where a first delivery was expected counts
// as a re-run, not a failure), 1 otherwise, 2 for a usage error.
import crypto from "node:crypto";

type Flags = Record<string, string | boolean>;

function parseArgs(argv: string[]): { positional: string[]; flags: Flags } {
  const positional: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2);
      if (v !== undefined) flags[k] = v;
      else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) flags[k] = argv[++i];
      else flags[k] = true;
    } else positional.push(a);
  }
  return { positional, flags };
}

function num(flags: Flags, key: string): number | undefined {
  const v = flags[key];
  if (v === undefined || v === true) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`--${key} must be a non-negative number`);
  return n;
}

async function main(): Promise<number> {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const what = positional[0] ?? "list";
  const inProcess = flags["in-process"] === true;

  if (inProcess) {
    // A fresh in-memory synthetic seed in this process: the synthetic demo mode and the simulator switch apply to it only.
    process.env.HLOS_MODE = "demo";
    process.env.HLOS_INTEGRATION_SIMULATOR = "1";
    if ((process.env.HLOS_INTEGRATION_SIM_SECRET ?? "").length < 32) process.env.HLOS_INTEGRATION_SIM_SECRET = crypto.randomBytes(32).toString("hex");
    if (!process.env.HLOS_AUDIT_KEY) process.env.HLOS_AUDIT_KEY = crypto.randomBytes(32).toString("hex");
  }

  const sim = await import("../src/server/integration/simulator");
  if (what === "list" || flags.help) {
    console.log("Scenarios (npm run integration:sim -- <name|number|all> [--url http://localhost:3100] [--in-process]):");
    for (const s of sim.SCENARIOS) console.log(`  ${String(s.n).padStart(2)}  ${s.name.padEnd(24)} ${s.title}`);
    return 0;
  }
  const chosen = what === "all" ? [...sim.SCENARIOS] : [sim.scenarioByName(what)].filter((s): s is (typeof sim.SCENARIOS)[number] => !!s);
  if (!chosen.length) {
    console.error(`Unknown scenario "${what}". Run with "list" to see them.`);
    return 2;
  }

  const rootSecret = process.env.HLOS_INTEGRATION_SIM_SECRET ?? "";
  if (rootSecret.length < 32) {
    console.error("Set HLOS_INTEGRATION_SIM_SECRET (at least 32 characters) to the same value the app was started with.");
    return 2;
  }

  const policy = {
    ...(num(flags, "max-attempts") !== undefined ? { maxAttempts: Math.max(1, Math.floor(num(flags, "max-attempts")!)) } : {}),
    ...(num(flags, "timeout-ms") !== undefined ? { timeoutMs: num(flags, "timeout-ms")! } : {}),
    ...(num(flags, "base-delay-ms") !== undefined ? { baseDelayMs: num(flags, "base-delay-ms")! } : {}),
    ...(num(flags, "max-delay-ms") !== undefined ? { maxDelayMs: num(flags, "max-delay-ms")! } : {}),
  };

  const { seededDemoDb } = await import("../src/server/integration/in-process");
  // The world always comes from a fresh in-memory synthetic seed: deterministic, and never the app's own database.
  const db = seededDemoDb();
  const world = sim.worldFromDb(db);
  const state = new sim.SimSourceState();
  const log = (line: string) => console.log(line);

  let transport: import("../src/server/integration/simulator").Transport;
  let outage: import("../src/server/integration/simulator").OutageControl;
  let delayedAck: import("../src/server/integration/simulator").DelayedAckParams | undefined;
  if (inProcess) {
    const ip = await import("../src/server/integration/in-process");
    transport = ip.inProcessTransport(db);
    outage = ip.inProcessOutage(db);
    if (chosen.some((s) => s.name === "delayed-ack")) {
      delayedAck = { ...ip.prepareDelayedAck(db), delayMs: num(flags, "delay-ms") ?? 2000 };
      console.log(`Local half of scenario 9: guided demo steps 1-4 requested ${delayedAck.requestId} and issued ${delayedAck.accessionNumber}.`);
    }
  } else {
    const url = typeof flags.url === "string" ? flags.url : "http://localhost:3100";
    try {
      sim.assertLoopbackUrl(url);
    } catch (e) {
      console.error((e as Error).message);
      return 2;
    }
    const switched = sim.outageSwitch(sim.httpTransport(url));
    transport = switched.transport;
    outage = switched.outage;
    if (typeof flags.request === "string") {
      delayedAck = {
        requestId: flags.request,
        accessionNumber: typeof flags.accession === "string" ? flags.accession : null,
        namespace: typeof flags.namespace === "string" ? flags.namespace : "EMA-SIM DERM",
        delayMs: num(flags, "delay-ms") ?? 5000,
      };
    }
  }
  console.log(`Integration simulator → ${transport.name} (contract ${sim.CONTRACT_VERSION}; synthetic data only)\n`);

  let failures = 0;
  let reruns = 0;
  let skipped = 0;
  const hints = new Set<string>();
  for (const s of chosen) {
    const report = await sim.runScenario(s.name, { transport, rootSecret, world, outage, policy, state, delayedAck, log });
    if (report.skipped) {
      skipped += 1;
      console.log("     (skipped)\n");
      continue;
    }
    for (const step of report.steps) {
      if (step.ok) continue;
      if (step.result === "duplicate" && !step.expected.includes("duplicate")) reruns += 1;
      else failures += 1;
      if (step.result === "not_found") hints.add("The endpoint answered 404: start the app in synthetic demo mode with HLOS_INTEGRATION_SIMULATOR=1 and HLOS_INTEGRATION_SIM_SECRET set.");
      if (step.result === "unauthorized" && !step.expected.includes("unauthorized")) hints.add("A signature was refused (401): give the app and the simulator the same HLOS_INTEGRATION_SIM_SECRET, and check both clocks.");
      if (step.result === "undelivered" && !step.expected.includes("undelivered")) hints.add(`Nothing answered at ${transport.name}: is the app running on that port?`);
    }
    if (report.backlog.length) console.log(`     Still in the source's outbox: ${report.backlog.join(", ")}`);
    console.log("");
  }
  for (const h of hints) console.log(h);
  console.log(
    `${failures ? `${failures} step(s) did not get the expected answer.` : "Every step got the expected answer."}${reruns ? ` ${reruns} step(s) were already delivered by an earlier run (duplicate).` : ""}${skipped ? ` ${skipped} scenario(s) skipped.` : ""}`,
  );
  return failures ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
