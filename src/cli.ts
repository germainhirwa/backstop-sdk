#!/usr/bin/env node
/**
 * backstop demo            Replay three publicly reported agent mistakes through the check.
 * backstop eval [file]     Run an agent through the 50-task Agent Mistake Test.
 * backstop keys            Generate an Ed25519 signing key pair.
 * backstop mcp             Start the MCP server on stdio.
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Backstop, type Verdict } from "./backstop.js";
import { cheapestAgent, firstOfferAgent, formatReport, runEval, type Agent } from "./eval/index.js";
import type { IntentInput } from "./intent.js";
import { flight, nothing, restaurant } from "./packs/index.js";
import { formatMoney, usd } from "./primitives.js";
import { generateKeys } from "./record.js";
import type { Cart } from "./rules.js";

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: number, s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = (s: string) => paint(1, s), dim = (s: string) => paint(2, s), red = (s: string) => paint(31, s), green = (s: string) => paint(32, s), yellow = (s: string) => paint(33, s);

function printVerdict(v: Verdict): void {
  for (const f of v.findings) {
    const mark = f.ok ? green("✓") : f.strength === "must" ? red("✕") : yellow("?");
    console.log(`    ${mark} ${f.label.padEnd(18)} ${f.ok ? dim(f.message) : f.message}`);
  }
  const stamp = v.status === "pass" ? green("PASS") : v.status === "block" ? red("BLOCKED") : yellow("ASK USER");
  console.log(`    ${bold(stamp)}${v.status === "block" ? `  ${formatMoney(v.cart.amount)} stays with the user` : ""}`);
  if (v.question) console.log(`    ${yellow("→")} ${v.question}`);
  for (const r of v.reasons) if (r.fix) console.log(`    ${dim("→ to agent:")} ${r.fix}`);
  if (v.guarantee) console.log(`    ${dim(`guarantee ${v.guarantee.id} (${v.guarantee.status})`)}`);
}

async function demo(): Promise<void> {
  const now = new Date("2026-11-11T15:00:00Z"); // Wed 11 Nov 2026, 10:00 in New York
  const b = new Backstop({ now: () => now, guarantee: "sandbox", keys: await generateKeys() });
  const tz = "America/New_York";
  const maya = "Maya Okafor";
  const cases: { title: string; note: string; intent: IntentInput; cart: Cart }[] = [
    {
      title: "Booked the wrong week",
      note: "From a travel agent's public postmortem: a relative date resolved in server time.",
      intent: { user: "u_1", request: "Book me JFK to Austin on Nov 20, morning, under $400, refundable.", timeZone: tz, wants: flight.wants({ from: "JFK", to: "AUS", date: "2026-11-20", departs: ["06:00", "12:00"], maxPrice: usd(400), refundable: true, passenger: maya }) },
      cart: flight.cart({ from: "JFK", to: "AUS", date: "2026-11-27", departs: "07:05", price: usd(362), refundable: true, passenger: maya, airline: "Delta", flight: "DL 1102" }),
    },
    {
      title: "Cancelled a flight when asked about its terms",
      note: "Reported for a consumer agent: the user asked a question; the agent cancelled.",
      intent: { user: "u_1", request: "What are the cancellation terms on my Delta flight to Austin?", timeZone: tz, wants: nothing() },
      cart: flight.cancel({ flight: "DL 1102", forfeits: usd(412) }),
    },
    {
      title: "Reserved a table nobody asked for",
      note: "Reported for a consumer agent: a $200 no-show fee on an unrequested booking.",
      intent: { user: "u_1", request: "Any good dinner spots near Union Square on Friday?", timeZone: tz, wants: nothing() },
      cart: restaurant.cart({ venue: "Gramercy Tavern", date: "2026-11-13", time: "20:00", partySize: 2, deposit: usd(200) }),
    },
    {
      title: "A clean booking",
      note: "Everything matches, so it clears with no question to the user.",
      intent: { user: "u_1", request: "Book me JFK to Austin on Nov 20, morning, under $400, refundable.", timeZone: tz, wants: flight.wants({ from: "JFK", to: "AUS", date: "2026-11-20", departs: ["06:00", "12:00"], maxPrice: usd(400), refundable: true, passenger: maya }) },
      cart: flight.cart({ from: "JFK", to: "AUS", date: "2026-11-20", departs: "07:05", price: usd(362), refundable: true, passenger: maya, airline: "Delta", flight: "DL 1102" }),
    },
  ];
  console.log(bold("\nBackstop demo: four carts through the pre-checkout check\n"));
  for (const c of cases) {
    console.log(`  ${bold(c.title)}  ${dim(c.note)}`);
    console.log(`    ${dim("user:")}  "${c.intent.request}"`);
    console.log(`    ${dim("agent:")} ${c.cart.summary}`);
    const v = await b.check(await b.intent(c.intent), c.cart);
    printVerdict(v);
    console.log();
  }
  console.log(dim("  Names and fares are sample data. Run `backstop eval` to test an agent on 50 tasks.\n"));
}

async function evalCmd(args: string[]): Promise<void> {
  const json = args.includes("--json");
  const file = args.find((a) => !a.startsWith("--"));
  let agent: Agent, name: string;
  if (!file || file === "cheapest") { agent = cheapestAgent; name = "reference agent (always buys the cheapest offer)"; }
  else if (file === "first") { agent = firstOfferAgent; name = "reference agent (always buys the first offer)"; }
  else {
    const mod = (await import(pathToFileURL(resolve(file)).href)) as { default?: Agent; agent?: Agent };
    const found = mod.default ?? mod.agent;
    if (typeof found !== "function") throw new Error(`${file} must export an agent function as default or as \`agent\`.`);
    agent = found; name = file;
  }
  const report = await runEval(agent, { onResult: json ? undefined : (r) => process.stdout.write(r.outcome === "correct" ? green("·") : r.outcome === "wrong_purchase" ? red("✕") : yellow("?")) });
  if (json) console.log(JSON.stringify(report, null, 2));
  else console.log(`\n\n${formatReport(report, name)}\n`);
}

const HELP = `backstop <command>

  demo            Replay three publicly reported agent mistakes through the check
  eval [file]     Run an agent through the 50-task Agent Mistake Test
                  file: a module exporting (task) => { cart } | { ask } | { decline }
                  or "cheapest" / "first" for a reference agent. Add --json for raw output.
  keys            Generate an Ed25519 signing key pair
  mcp             Start the MCP server on stdio
`;

const [cmd, ...rest] = process.argv.slice(2);
try {
  if (cmd === "demo") await demo();
  else if (cmd === "eval") await evalCmd(rest);
  else if (cmd === "keys") console.log(JSON.stringify(await generateKeys(), null, 2));
  else if (cmd === "mcp") (await import("./mcp.js")).serve();
  else console.log(HELP);
} catch (e) {
  console.error(red(e instanceof Error ? e.message : String(e)));
  process.exitCode = 1;
}
