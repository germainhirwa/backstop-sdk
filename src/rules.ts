/**
 * Rules: what the user asked for, as data.
 *
 * A rule is plain JSON, never a function. That is what lets the same rule be
 * signed into a record, re-run against the delivered order when a claim comes
 * in, and evaluated by an SDK in any language.
 */
import { compareNames, daysBetween, formatDate, formatMoney, formatTime, getPath, isISODate, isMoney, type ISODate, type Money } from "./primitives.js";

export type Scalar = string | number | boolean;

/** "must" failures block the purchase. "prefer" failures turn into one question for the user. */
export type Strength = "must" | "prefer";

export type Test =
  | { op: "eq"; value: Scalar }
  | { op: "in"; values: Scalar[] }
  | { op: "lte"; value: number }
  | { op: "gte"; value: number }
  | { op: "between"; min: number | string; max: number | string }
  | { op: "money_lte"; value: Money }
  | { op: "date"; value: ISODate }
  | { op: "date_lte"; value: ISODate }
  | { op: "name"; value: string }
  | { op: "is"; value: boolean };

export interface Rule {
  /** Dotted path into the cart: "amount", "item.date", "item.variant.size". */
  field: string;
  /** What a person calls this field: "Date", "Seat", "Price". */
  label: string;
  strength: Strength;
  test: Test;
}

/** What the agent is about to do. */
export interface Cart {
  /** Namespaced action: "flight.book", "retail.purchase", "flight.cancel". */
  action: string;
  /** Total the user is exposed to, including fees and deposits. */
  amount: Money;
  /** Seller, when it matters. */
  merchant?: string;
  /** Domain fields the rules read. */
  item: Record<string, unknown>;
  /** One line a person would recognise: "Delta DL 1102, Main Cabin". */
  summary?: string;
}

export type FindingCode =
  | "ok"
  | "mismatch"
  | "not_allowed"
  | "over_limit"
  | "under_limit"
  | "out_of_range"
  | "currency_mismatch"
  | "date_mismatch"
  | "too_late"
  | "name_mismatch"
  | "name_typo"
  | "missing_field"
  | "action_not_authorized"
  | "duplicate_order"
  | "too_many_attempts"
  | "intent_expired"
  | "no_amount_limit"
  | "above_ask_threshold"
  | "order_drift";

export interface Finding {
  field: string;
  label: string;
  strength: Strength;
  ok: boolean;
  code: FindingCode;
  /** What the user asked for, in words. */
  expected: string;
  /** What the cart has, in words. */
  actual: string;
  /** Sentence for a human reviewer. */
  message: string;
  /** Instruction for the agent. Present only when the rule failed. */
  fix?: string;
}

const show = (v: unknown): string => {
  if (v === undefined || v === null || v === "") return "nothing";
  if (isMoney(v)) return formatMoney(v);
  if (isISODate(v)) return formatDate(v);
  if (typeof v === "string" && /^\d{2}:\d{2}$/.test(v)) return formatTime(v);
  if (typeof v === "boolean") return v ? "yes" : "no";
  return String(v);
};

const fold = (v: unknown): unknown => (typeof v === "string" ? v.trim().toLowerCase() : v);

/** Describe what a rule requires, for summaries shown to the user. */
export function describe(rule: Rule): string {
  const t = rule.test;
  switch (t.op) {
    case "eq": return show(t.value);
    case "in": return t.values.map(show).join(" or ");
    case "lte": return `at most ${t.value}`;
    case "gte": return `at least ${t.value}`;
    case "between": return `${show(t.min)}–${show(t.max)}`;
    case "money_lte": return `up to ${formatMoney(t.value)}`;
    case "date": return formatDate(t.value);
    case "date_lte": return `by ${formatDate(t.value)}`;
    case "name": return t.value;
    case "is": return t.value ? "yes" : "no";
  }
}

/** Run one rule against a cart. Missing data fails closed: what can't be verified isn't cleared. */
export function evaluate(rule: Rule, cart: Cart): Finding {
  const actual = getPath(cart, rule.field);
  const expected = describe(rule);
  const base = { field: rule.field, label: rule.label, strength: rule.strength, expected, actual: show(actual) };
  const pass = (message: string): Finding => ({ ...base, ok: true, code: "ok", message });
  const fail = (code: FindingCode, message: string, fix: string): Finding => ({ ...base, ok: false, code, message, fix });
  const L = rule.label;

  if (actual === undefined || actual === null || actual === "") {
    return fail("missing_field", `${L} is missing from the cart, so it can't be verified.`, `Include ${rule.field} in the cart. The user asked for ${L.toLowerCase()}: ${expected}.`);
  }
  const t = rule.test;
  switch (t.op) {
    case "eq":
      return fold(actual) === fold(t.value)
        ? pass(`${L} is ${show(actual)}, as asked.`)
        : fail("mismatch", `${L} is ${show(actual)}; the user asked for ${expected}.`, `Change ${L.toLowerCase()} to ${expected}.`);
    case "in":
      return t.values.map(fold).includes(fold(actual) as Scalar)
        ? pass(`${L} is ${show(actual)}, which is allowed.`)
        : fail("not_allowed", `${L} is ${show(actual)}; the user allowed only ${expected}.`, `Use ${expected} for ${L.toLowerCase()}.`);
    case "lte":
      return typeof actual === "number" && actual <= t.value
        ? pass(`${L} is ${actual}, within the limit of ${t.value}.`)
        : fail("over_limit", `${L} is ${show(actual)}; the limit is ${t.value}.`, `Keep ${L.toLowerCase()} at or below ${t.value}.`);
    case "gte":
      return typeof actual === "number" && actual >= t.value
        ? pass(`${L} is ${actual}, at least ${t.value}.`)
        : fail("under_limit", `${L} is ${show(actual)}; the minimum is ${t.value}.`, `Keep ${L.toLowerCase()} at or above ${t.value}.`);
    case "between": {
      const inRange = typeof actual === typeof t.min && (actual as number | string) >= t.min && (actual as number | string) <= t.max;
      return inRange
        ? pass(`${L} is ${show(actual)}, inside ${expected}.`)
        : fail("out_of_range", `${L} is ${show(actual)}, outside ${expected}.`, `Pick an option with ${L.toLowerCase()} inside ${expected}.`);
    }
    case "money_lte": {
      if (!isMoney(actual)) return fail("mismatch", `${L} isn't a money amount.`, `Send ${rule.field} as { currency, minor }.`);
      if (actual.currency !== t.value.currency) {
        return fail("currency_mismatch", `${L} is in ${actual.currency}; the user's limit is in ${t.value.currency}.`, `Quote the total in ${t.value.currency}.`);
      }
      if (actual.minor <= t.value.minor) return pass(`${formatMoney(actual)} is within the ${formatMoney(t.value)} limit.`);
      const over = formatMoney({ currency: actual.currency, minor: actual.minor - t.value.minor });
      return fail("over_limit", `${formatMoney(actual)} is ${over} over the ${formatMoney(t.value)} limit the user set.`, `Find an option at or under ${formatMoney(t.value)}, or ask the user to raise the limit.`);
    }
    case "date": {
      if (actual === t.value) return pass(`${L} is ${formatDate(t.value)}, as asked.`);
      if (!isISODate(actual)) return fail("date_mismatch", `${L} isn't a valid date.`, `Send ${rule.field} as YYYY-MM-DD.`);
      const diff = daysBetween(t.value, actual);
      const hint = Math.abs(diff) % 7 === 0 ? ` That is exactly ${Math.abs(diff) / 7} week${Math.abs(diff) === 7 ? "" : "s"} off, which usually means a relative date was resolved in the wrong time zone or week.` : "";
      return fail("date_mismatch", `${L} is ${formatDate(actual)}; the user asked for ${formatDate(t.value)} (${diff > 0 ? "+" : ""}${diff} days).${hint}`, `Use ${t.value} (${formatDate(t.value)}).`);
    }
    case "date_lte":
      return isISODate(actual) && actual <= t.value
        ? pass(`${L} is ${formatDate(actual)}, in time for ${formatDate(t.value)}.`)
        : fail("too_late", `${L} is ${show(actual)}; the user needs it by ${formatDate(t.value)}.`, `Pick an option that arrives by ${t.value}.`);
    case "name": {
      const match = compareNames(t.value, String(actual));
      if (match === "exact") return pass(`${L} is ${t.value}.`);
      if (match === "middle_omitted") return pass(`${L} matches ${t.value} on first and last name.`);
      if (match === "typo") return fail("name_typo", `${L} reads "${String(actual)}", which looks like a misspelling of "${t.value}".`, `Spell the name exactly: ${t.value}.`);
      return fail("name_mismatch", `${L} is "${String(actual)}"; the user asked for "${t.value}".`, `Use the name ${t.value}.`);
    }
    case "is":
      return actual === t.value
        ? pass(`${L}: ${show(actual)}, as asked.`)
        : fail("mismatch", `${L} is ${show(actual)}; the user asked for ${show(t.value)}.`, `Choose an option where ${L.toLowerCase()} is ${show(t.value)}.`);
  }
}

// ───────────────────────────── Rule builders ─────────────────────────────

const make = (strength: Strength) => ({
  eq: (field: string, value: Scalar, label = field): Rule => ({ field, label, strength, test: { op: "eq", value } }),
  oneOf: (field: string, values: Scalar[], label = field): Rule => ({ field, label, strength, test: { op: "in", values } }),
  atMost: (field: string, value: number, label = field): Rule => ({ field, label, strength, test: { op: "lte", value } }),
  atLeast: (field: string, value: number, label = field): Rule => ({ field, label, strength, test: { op: "gte", value } }),
  between: (field: string, min: number | string, max: number | string, label = field): Rule => ({ field, label, strength, test: { op: "between", min, max } }),
  /** Cap on the cart total. Field defaults to "amount". */
  costsAtMost: (value: Money, label = "Price", field = "amount"): Rule => ({ field, label, strength, test: { op: "money_lte", value } }),
  on: (field: string, value: ISODate, label = "Date"): Rule => ({ field, label, strength, test: { op: "date", value } }),
  by: (field: string, value: ISODate, label = "Arrives"): Rule => ({ field, label, strength, test: { op: "date_lte", value } }),
  named: (field: string, value: string, label = "Name"): Rule => ({ field, label, strength, test: { op: "name", value } }),
  is: (field: string, value: boolean, label = field): Rule => ({ field, label, strength, test: { op: "is", value } }),
});

/** Hard requirements. A failed `must` rule blocks the purchase. */
export const must = make("must");
/** Soft preferences. A failed `prefer` rule asks the user one question. */
export const prefers = make("prefer");

/** Mark a value in a pack as a preference rather than a requirement: `seat: prefer("aisle")`. */
export interface Preferred<T> { readonly __prefer: true; readonly value: T }
export const prefer = <T>(value: T): Preferred<T> => ({ __prefer: true, value });
export const isPreferred = (v: unknown): v is Preferred<unknown> => typeof v === "object" && v !== null && (v as Preferred<unknown>).__prefer === true;
export const unwrap = <T>(v: T | Preferred<T>): { value: T; strength: Strength } =>
  isPreferred(v) ? { value: v.value as T, strength: "prefer" } : { value: v as T, strength: "must" };
