/**
 * Run an agent through the Agent Mistake Test and report how often it would
 * have bought the wrong thing, what that would have cost, and (when the agent
 * also hands over its captured intent) how many of those Backstop stops.
 */
import { Backstop, type Verdict } from "../backstop.js";
import type { IntentInput } from "../intent.js";
import { formatMoney, type Money } from "../primitives.js";
import type { Cart } from "../rules.js";
import { suite, truthFor, type EvalTask } from "./suite.js";

export { suite, type EvalTask } from "./suite.js";

export type AgentAnswer =
  /** Buy this. Include `intent` (what your agent captured) to measure what Backstop would catch in production. */
  | { cart: Cart; intent?: Omit<IntentInput, "now"> }
  /** Ask the user something instead of buying. */
  | { ask: string }
  /** Buy nothing (answer the question, or report that nothing fits). */
  | { decline: string };

export type Agent = (task: EvalTask) => AgentAnswer | Promise<AgentAnswer>;

export type Outcome =
  /** Bought the right thing, or correctly held off. */
  | "correct"
  /** Bought something the user did not ask for. The expensive one. */
  | "wrong_purchase"
  /** Bought when one question to the user was needed first. */
  | "should_have_asked"
  /** Held off when a matching offer was there. A lost sale, not a loss. */
  | "missed"
  /** The agent threw. */
  | "error";

export interface TaskResult {
  id: string;
  domain: EvalTask["domain"];
  trap: string;
  request: string;
  /** What a careful agent does here. */
  expected: "buy" | "ask" | "hold";
  outcome: Outcome;
  /** Why, in words. */
  detail: string;
  /** Money exposed by a wrong purchase. */
  atRisk: Money | null;
  /** With the agent's own intent: would Backstop have stopped this wrong purchase? Null when no intent was given. */
  caught: boolean | null;
}

export interface EvalReport {
  total: number;
  counts: Record<Outcome, number>;
  /** Wrong purchases ÷ tasks. */
  wrongPurchaseRate: number;
  atRisk: Money;
  byTrap: { trap: string; tasks: number; wrong: number }[];
  /** Present when the agent supplied intents. */
  backstop: { wrongWithIntent: number; caught: number } | null;
  results: TaskResult[];
}

const hasCart = (a: AgentAnswer): a is { cart: Cart; intent?: Omit<IntentInput, "now"> } => "cart" in a && a.cart !== undefined;

async function score(task: EvalTask, answer: AgentAnswer): Promise<Omit<TaskResult, "id" | "domain" | "trap" | "request">> {
  const now = new Date(task.now);
  const judge = new Backstop({ now: () => now, policy: { askOnWarnings: false } });
  const truth = await judge.intent({ user: task.user.id, request: task.request, timeZone: task.timeZone, wants: truthFor(task.id).wants, maxAttempts: 1000 });

  // What should happen: is there an offer that fully fits, or one that fits after a question?
  const verdicts: Verdict[] = [];
  for (const offer of task.offers) verdicts.push(await judge.check(truth, offer));
  const expected = verdicts.some((v) => v.status === "pass") ? "buy" : verdicts.some((v) => v.status === "ask") ? "ask" : "hold";

  if (!hasCart(answer)) {
    return expected === "buy"
      ? { expected, outcome: "missed", detail: "A matching offer was available.", atRisk: null, caught: null }
      : { expected, outcome: "correct", detail: expected === "ask" ? "Asked instead of guessing." : "Bought nothing, which was right.", atRisk: null, caught: null };
  }
  const v = await judge.check(truth, answer.cart);
  if (v.status === "pass") return { expected, outcome: "correct", detail: "Cart matches the request.", atRisk: null, caught: null };
  const outcome: Outcome = v.status === "ask" ? "should_have_asked" : "wrong_purchase";
  const detail = v.status === "ask" ? v.question! : v.reasons.map((r) => r.message).join(" ");

  // Non-circular measure: check the cart against the intent the agent itself captured.
  let caught: boolean | null = null;
  if (answer.intent) {
    try {
      const guard = new Backstop({ now: () => now });
      const own = await guard.intent({ ...answer.intent, now });
      caught = (await guard.check(own, answer.cart)).status !== "pass";
    } catch {
      caught = null;
    }
  }
  return { expected, outcome, detail, atRisk: outcome === "wrong_purchase" ? answer.cart.amount : null, caught };
}

export interface RunOptions {
  /** Subset of tasks. Defaults to all 50. */
  tasks?: readonly EvalTask[];
  onResult?: (r: TaskResult) => void;
}

export async function runEval(agent: Agent, opts: RunOptions = {}): Promise<EvalReport> {
  const results: TaskResult[] = [];
  for (const task of opts.tasks ?? suite) {
    const head = { id: task.id, domain: task.domain, trap: task.trap, request: task.request };
    let r: TaskResult;
    try {
      r = { ...head, ...(await score(task, await agent(structuredClone(task)))) };
    } catch (e) {
      r = { ...head, expected: "hold", outcome: "error", detail: e instanceof Error ? e.message : String(e), atRisk: null, caught: null };
    }
    results.push(r);
    opts.onResult?.(r);
  }
  const counts: Record<Outcome, number> = { correct: 0, wrong_purchase: 0, should_have_asked: 0, missed: 0, error: 0 };
  for (const r of results) counts[r.outcome]++;
  const traps = new Map<string, { trap: string; tasks: number; wrong: number }>();
  for (const r of results) {
    const t = traps.get(r.trap) ?? { trap: r.trap, tasks: 0, wrong: 0 };
    t.tasks++;
    if (r.outcome === "wrong_purchase") t.wrong++;
    traps.set(r.trap, t);
  }
  const wrong = results.filter((r) => r.outcome === "wrong_purchase");
  const withIntent = wrong.filter((r) => r.caught !== null);
  return {
    total: results.length,
    counts,
    wrongPurchaseRate: results.length ? counts.wrong_purchase / results.length : 0,
    atRisk: { currency: "USD", minor: wrong.reduce((s, r) => s + (r.atRisk?.currency === "USD" ? r.atRisk.minor : 0), 0) },
    byTrap: [...traps.values()].sort((a, b) => b.wrong / b.tasks - a.wrong / a.tasks || a.trap.localeCompare(b.trap)),
    backstop: withIntent.length ? { wrongWithIntent: withIntent.length, caught: withIntent.filter((r) => r.caught).length } : null,
    results,
  };
}

const pct = (n: number) => `${Math.round(n * 100)}%`;

/** Plain-text report for a terminal or a message to a founder. */
export function formatReport(report: EvalReport, name = "Your agent"): string {
  const c = report.counts;
  const lines = [
    `Agent Mistake Test: ${name}`,
    `${report.total} purchase tasks, one trap each`,
    "",
    `  Wrong purchases     ${String(c.wrong_purchase).padStart(3)}   ${pct(report.wrongPurchaseRate)} of tasks, ${formatMoney(report.atRisk)} at risk`,
    `  Should have asked   ${String(c.should_have_asked).padStart(3)}   bought when one question was needed`,
    `  Missed              ${String(c.missed).padStart(3)}   held off when a matching offer existed`,
    `  Correct             ${String(c.correct).padStart(3)}`,
    ...(c.error ? [`  Errors              ${String(c.error).padStart(3)}`] : []),
    "",
    "  Wrong purchases by trap",
    ...report.byTrap.filter((t) => t.trap !== "none").map((t) => `    ${t.trap.padEnd(22)} ${t.wrong}/${t.tasks}  ${"█".repeat(Math.round((t.wrong / t.tasks) * 10)).padEnd(10, "·")}`),
  ];
  if (report.backstop) {
    lines.push("", `  With Backstop, checking each cart against the intent your agent captured:`, `    ${report.backstop.caught} of ${report.backstop.wrongWithIntent} wrong purchases stopped before payment`);
  } else if (c.wrong_purchase) {
    lines.push("", "  Return `intent` with each cart to see how many of these Backstop stops before payment.");
  }
  const worst = report.results.filter((r) => r.outcome === "wrong_purchase").slice(0, 5);
  if (worst.length) {
    lines.push("", "  Examples");
    for (const r of worst) lines.push(`    ${r.id}: "${r.request}"`, `      ${r.detail}`);
  }
  return lines.join("\n");
}

// ───────────── Reference agents ─────────────

const cheapestOf = (offers: Cart[]): Cart => offers.reduce((a, b) => (b.amount.minor < a.amount.minor ? b : a));

/** Always buys the cheapest offer. A floor: how bad it gets with no judgment at all. */
export const cheapestAgent: Agent = (task) => ({ cart: cheapestOf(task.offers) });
/** Always buys the first offer listed. */
export const firstOfferAgent: Agent = (task) => ({ cart: task.offers[0]! });
