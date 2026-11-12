/**
 * Intent capture.
 *
 * Once a cart is checked against a structured intent, the remaining risk moves
 * upstream: did the structured intent capture what the person actually said?
 * `lint()` is the cheap guard for that. It re-reads the user's own words and
 * compares them with the fields, in the user's time zone, with no model call.
 */
import { formatDate, formatMoney, resolveDate, type ISODate } from "./primitives.js";
import type { PackIntent } from "./packs/index.js";
import { describe, type Rule } from "./rules.js";

export interface IntentInput {
  /** Your id for the end user. */
  user: string;
  /** The user's words, verbatim. They are signed into the record and re-read by lint(). */
  request: string;
  /** IANA zone the user is in. Relative dates are resolved here, not on your server. */
  timeZone?: string;
  /** What the user wants: a pack (`flight.wants({...})`), `nothing()`, or `{ allow, rules }` by hand. */
  wants: PackIntent | { allow: string[]; rules: Rule[]; pack?: string };
  /** Extra rules on top of the pack. */
  also?: Rule[];
  /** How many orders this request may produce. Default 1: retries can't double-buy. */
  maxOrders?: number;
  /** How many carts may be checked before the intent locks. Default 8. */
  maxAttempts?: number;
  /** Seconds until the request goes stale and needs re-confirming. Default 24 hours. */
  expiresIn?: number;
  /** Questions the agent already asked, with the user's answers. */
  clarifications?: { question: string; answer: string }[];
  /** Override the clock (tests, replays). */
  now?: Date;
}

export type WarningCode =
  | "ambiguous_date"
  | "date_differs_from_request"
  | "budget_differs_from_request"
  | "budget_not_captured"
  | "no_amount_limit"
  | "refundable_not_captured"
  | "quantity_differs_from_request"
  | "request_reads_as_question";

export interface Warning {
  code: WarningCode;
  /** For the developer. */
  message: string;
  /** Ready to show the user. Present when asking would settle it. */
  question?: string;
}

export interface IntentBody {
  user: string;
  request: string;
  timeZone: string;
  createdAt: string;
  expiresAt: string;
  pack: string;
  allow: string[];
  rules: Rule[];
  maxOrders: number;
  maxAttempts: number;
  clarifications: { question: string; answer: string }[];
  /** Lint findings at capture time. Kept in the record: they decide how a later claim is read. */
  warnings: Warning[];
}

export function buildIntentBody(input: IntentInput): IntentBody {
  if (!input.user) throw new TypeError("intent(): `user` is required");
  if (typeof input.request !== "string" || !input.request.trim()) throw new TypeError("intent(): `request` must be the user's words");
  const now = input.now ?? new Date();
  const body: IntentBody = {
    user: input.user,
    request: input.request.trim(),
    timeZone: input.timeZone ?? "UTC",
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + (input.expiresIn ?? 86_400) * 1000).toISOString(),
    pack: input.wants.pack ?? "custom",
    allow: [...input.wants.allow],
    rules: [...input.wants.rules, ...(input.also ?? [])],
    maxOrders: input.maxOrders ?? 1,
    maxAttempts: input.maxAttempts ?? 8,
    clarifications: input.clarifications ?? [],
    warnings: [],
  };
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: body.timeZone });
  } catch {
    throw new TypeError(`intent(): unknown time zone "${body.timeZone}"`);
  }
  body.warnings = lint(body);
  return body;
}

const BUDGET = /(?:under|below|less than|max(?:imum)?(?: of)?|up to|no more than|at most|budget(?: is| of)?|cap(?:ped)? at|within)\s*\$?\s*([\d,]+(?:\.\d{1,2})?)\s*(k\b)?/i;
const DOLLARS = /\$\s*([\d,]+(?:\.\d{1,2})?)/g;
const REFUNDABLE = /\b(refundable|free cancell?ation|cancel(?:lable)? for free|flexible (?:fare|ticket|rate))\b/i;
const NON_REFUNDABLE = /\bnon[- ]?refundable\b/i;
const BUY_VERB = /\b(book|buy|order|purchase|reserve|get me|grab|sign me up|go ahead|rebook|pay for|cancel (?:it|my|the|that)|renew|subscribe)\b/i;
const QUESTION = /\?|^\s*(what|when|where|which|who|how|is|are|do|does|can you tell|could you tell|any)\b/i;
const QTY = /\b(\d{1,3}|one|two|three|four|five|six|a pair of|a couple of)\s+(?:x\s+)?(?:packs?|boxes|pairs?|bottles|units|sets|copies|of them|of these)\b/i;
const QTY_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, "a pair of": 1, "a couple of": 2 };

function budgetIn(text: string): number | null {
  const m = BUDGET.exec(text);
  if (m) return Number(m[1]!.replace(/,/g, "")) * (m[2] ? 1000 : 1);
  const all = [...text.matchAll(DOLLARS)];
  return all.length === 1 ? Number(all[0]![1]!.replace(/,/g, "")) : null;
}

/** Compare the user's words with the structured fields. Pure and deterministic. */
export function lint(body: Pick<IntentBody, "request" | "timeZone" | "createdAt" | "allow" | "rules" | "clarifications">): Warning[] {
  const out: Warning[] = [];
  const text = body.request;
  const buying = body.allow.length > 0;
  const settled = body.clarifications.map((c) => `${c.question} ${c.answer}`).join(" ").toLowerCase();

  // 1. Dates: resolve the phrase the way the user meant it, in their zone.
  const dateRule = body.rules.find((r) => r.test.op === "date");
  const said = resolveDate(text, { timeZone: body.timeZone, now: new Date(body.createdAt) });
  if (said && dateRule && dateRule.test.op === "date") {
    const want: ISODate = dateRule.test.value;
    const dateSettled = /\b(date|day|week|friday|monday|tuesday|wednesday|thursday|saturday|sunday)\b/.test(settled);
    if (want === said.date || said.alternatives.includes(want)) {
      if (said.ambiguous && !dateSettled) {
        const other = want === said.date ? said.alternatives[0]! : said.date;
        out.push({ code: "ambiguous_date", message: `"${said.phrase}" has two readings: ${formatDate(want)} (captured) and ${formatDate(other)}.`, question: `By "${said.phrase}", do you mean ${formatDate(want)} or ${formatDate(other)}?` });
      }
    } else if (!dateSettled) {
      out.push({
        code: "date_differs_from_request",
        message: `The request says "${said.phrase}", which is ${formatDate(said.date)} in ${body.timeZone}. The intent says ${formatDate(want)}.`,
        question: `You said "${said.phrase}". Should this be ${formatDate(said.date)} or ${formatDate(want)}?`,
      });
    }
  }

  // 2. Budget.
  const cap = body.rules.find((r) => r.test.op === "money_lte" && r.field === "amount");
  const budget = budgetIn(text);
  if (budget !== null && cap && cap.test.op === "money_lte" && cap.test.value.minor > Math.round(budget * 100)) {
    out.push({ code: "budget_differs_from_request", message: `The request mentions ${budget}; the intent allows ${formatMoney(cap.test.value)}.`, question: `Is ${formatMoney(cap.test.value)} okay, or should I stay under ${budget}?` });
  } else if (budget !== null && !cap && buying) {
    out.push({ code: "budget_not_captured", message: `The request mentions a budget of ${budget}, but the intent has no price limit.` });
  } else if (!cap && buying) {
    out.push({ code: "no_amount_limit", message: "The intent has no price limit. Any amount would pass the check." });
  }

  // 3. Refundability.
  if (buying && REFUNDABLE.test(text) && !NON_REFUNDABLE.test(text) && !body.rules.some((r) => /refund|cancel/i.test(r.field))) {
    out.push({ code: "refundable_not_captured", message: "The request asks for something refundable, but no rule checks it." });
  }

  // 4. Quantity.
  const qty = body.rules.find((r) => /quantity$/.test(r.field) && r.test.op === "eq");
  const qm = QTY.exec(text);
  if (qty && qty.test.op === "eq" && qm) {
    const n = QTY_WORDS[qm[1]!.toLowerCase()] ?? Number(qm[1]);
    if (Number.isFinite(n) && n !== qty.test.value) out.push({ code: "quantity_differs_from_request", message: `The request says "${qm[0]}"; the intent says quantity ${qty.test.value}.`, question: `How many do you want: ${n} or ${qty.test.value}?` });
  }

  // 5. A question is not an order.
  if (buying && QUESTION.test(text) && !BUY_VERB.test(text)) {
    out.push({ code: "request_reads_as_question", message: `The request reads like a question, but the intent authorizes ${body.allow.join(", ")}.`, question: "Do you want me to go ahead, or just tell you what I find?" });
  }
  return out;
}

const ACTION_WORDS: Record<string, string> = {
  "flight.book": "book a flight",
  "flight.cancel": "cancel a flight",
  "flight.change": "change a flight",
  "retail.purchase": "buy",
  "retail.return": "return an item",
  "restaurant.reserve": "reserve a table",
};
export const actionWords = (action: string): string => ACTION_WORDS[action] ?? action.replace(/[._]/g, " ");

/** One line to show the user before the agent acts. Acknowledging it makes the record much stronger. */
export function summarize(body: Pick<IntentBody, "allow" | "rules">): string {
  if (body.allow.length === 0) return "You asked a question. I won't buy, book or cancel anything.";
  const parts = body.rules.map((r) => `${r.label.toLowerCase()} ${describe(r)}${r.strength === "prefer" ? " (preferred)" : ""}`);
  return `I'll ${body.allow.map(actionWords).join(" or ")}: ${parts.join(", ")}.`;
}
