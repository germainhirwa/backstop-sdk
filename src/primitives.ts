/**
 * Primitives: money, dates, names, canonical JSON, hashing.
 * Everything here is deterministic and dependency-free so a check gives the
 * same answer in Node, at the edge, in a browser, and when a claim is replayed
 * months later.
 */

// ───────────────────────────── Money ─────────────────────────────

/** Money in integer minor units (cents), so comparisons never hit float error. */
export interface Money {
  currency: string;
  minor: number;
}

const ZERO_DECIMAL = new Set(["JPY", "KRW", "VND", "CLP", "ISK", "UGX", "RWF", "XAF", "XOF"]);

export function money(amount: number, currency = "USD"): Money {
  const c = currency.toUpperCase();
  if (!Number.isFinite(amount)) throw new TypeError(`money(): amount must be a finite number, got ${amount}`);
  return { currency: c, minor: Math.round(amount * (ZERO_DECIMAL.has(c) ? 1 : 100)) };
}
export const usd = (amount: number): Money => money(amount, "USD");

export function isMoney(v: unknown): v is Money {
  return typeof v === "object" && v !== null && typeof (v as Money).currency === "string" && Number.isInteger((v as Money).minor);
}

export function formatMoney(m: Money): string {
  const zero = ZERO_DECIMAL.has(m.currency);
  const n = zero ? m.minor : m.minor / 100;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: m.currency,
      minimumFractionDigits: zero || m.minor % 100 === 0 ? 0 : 2,
      maximumFractionDigits: zero ? 0 : 2,
    }).format(n);
  } catch {
    return `${n} ${m.currency}`;
  }
}

// ───────────────────────────── Dates ─────────────────────────────

/** A calendar date with no time or zone: "2026-11-20". */
export type ISODate = string;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
export const isISODate = (v: unknown): v is ISODate => typeof v === "string" && ISO_DATE.test(v) && !Number.isNaN(Date.parse(v + "T00:00:00Z"));

/** Today's calendar date as the user sees it. This is the line the "wrong week" bugs cross. */
export function todayIn(timeZone: string, now: Date = new Date()): ISODate {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export function addDays(date: ISODate, days: number): ISODate {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** 0 = Sunday … 6 = Saturday. */
export const weekdayOf = (date: ISODate): number => new Date(date + "T00:00:00Z").getUTCDay();

export const daysBetween = (a: ISODate, b: ISODate): number =>
  Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86_400_000);

export function formatDate(date: ISODate): string {
  return new Date(date + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

export function formatTime(t: string): string {
  const [h = 0, m = 0] = t.split(":").map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`;
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const WEEKDAY_RE = "(sun|mon|tue(?:s)?|wed(?:nes)?|thu(?:r|rs)?|fri|sat(?:ur)?)(?:day)?";
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTH_RE = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";

export interface ResolvedDate {
  /** The best reading. */
  date: ISODate;
  /** The words that were resolved, as found in the text. */
  phrase: string;
  /** True when a careful human would ask which day was meant. */
  ambiguous: boolean;
  /** The other plausible readings. */
  alternatives: ISODate[];
  /** Why it is ambiguous, written for the end user. */
  note?: string;
}

export interface ResolveOptions {
  timeZone?: string;
  now?: Date;
}

const DATE_PATTERNS: RegExp[] = [
  /\b\d{4}-\d{2}-\d{2}\b/i,
  /\b(?:day after tomorrow|tomorrow|today|tonight)\b/i,
  /\bin (\d{1,2}|a|one|two|three|four|five|six|seven) (day|week)s?\b/i,
  new RegExp(`\\b${MONTH_RE}\\.? (\\d{1,2})(?:st|nd|rd|th)?(?:,? (\\d{4}))?\\b`, "i"),
  new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)? (?:of )?${MONTH_RE}\\.?(?:,? (\\d{4}))?\\b`, "i"),
  /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/,
  new RegExp(`\\b(?:(this|next|on|coming|this coming) )?${WEEKDAY_RE}\\b`, "i"),
];

/** Find the first date-like phrase in free text. */
export function findDatePhrase(text: string): string | null {
  let best: { index: number; phrase: string } | null = null;
  for (const re of DATE_PATTERNS) {
    const m = re.exec(text);
    if (m && (best === null || m.index < best.index)) best = { index: m.index, phrase: m[0] };
  }
  return best?.phrase ?? null;
}

const WORD_NUM: Record<string, number> = { a: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7 };

/**
 * Resolve a date phrase ("next Friday", "tomorrow", "Nov 20", "11/20") to a
 * calendar date in the user's time zone. Returns null when the text holds no
 * date this function understands; never guesses.
 */
export function resolveDate(text: string, opts: ResolveOptions = {}): ResolvedDate | null {
  const timeZone = opts.timeZone ?? "UTC";
  const today = todayIn(timeZone, opts.now ?? new Date());
  const phrase = findDatePhrase(text);
  if (!phrase) return null;
  const p = phrase.toLowerCase();
  const plain = (date: ISODate): ResolvedDate => ({ date, phrase, ambiguous: false, alternatives: [] });

  if (ISO_DATE.test(p)) return isISODate(p) ? plain(p) : null;
  if (p === "today" || p === "tonight") return plain(today);
  if (p === "tomorrow") return plain(addDays(today, 1));
  if (p === "day after tomorrow") return plain(addDays(today, 2));

  let m = /^in (\S+) (day|week)s?$/.exec(p);
  if (m) {
    const n = WORD_NUM[m[1]!] ?? Number(m[1]);
    return Number.isFinite(n) ? plain(addDays(today, n * (m[2] === "week" ? 7 : 1))) : null;
  }

  const monthIndex = (s: string) => MONTHS.findIndex((mm) => mm.startsWith(s.slice(0, 3)));
  const fromMonthDay = (month: number, day: number, year?: number): ResolvedDate | null => {
    const y0 = year ?? Number(today.slice(0, 4));
    const mk = (y: number) => `${y}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    let d = mk(y0);
    if (!isISODate(d) || new Date(d + "T00:00:00Z").getUTCDate() !== day) return null;
    if (year === undefined && d < today) d = mk(y0 + 1); // "Jan 5" said in November means next January
    return plain(d);
  };
  m = new RegExp(`^${MONTH_RE}\\.? (\\d{1,2})(?:st|nd|rd|th)?(?:,? (\\d{4}))?$`, "i").exec(p);
  if (m) return fromMonthDay(monthIndex(m[1]!), Number(m[2]), m[3] ? Number(m[3]) : undefined);
  m = new RegExp(`^(\\d{1,2})(?:st|nd|rd|th)? (?:of )?${MONTH_RE}\\.?(?:,? (\\d{4}))?$`, "i").exec(p);
  if (m) return fromMonthDay(monthIndex(m[2]!), Number(m[1]), m[3] ? Number(m[3]) : undefined);

  m = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/.exec(p);
  if (m) {
    const a = Number(m[1]), b = Number(m[2]);
    const year = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : undefined;
    const us = fromMonthDay(a - 1, b, year); // month/day, the US reading
    const intl = a !== b && a <= 12 && b <= 12 ? fromMonthDay(b - 1, a, year) : null;
    if (us && intl) return { ...us, ambiguous: true, alternatives: [intl.date], note: `"${phrase}" could be ${formatDate(us.date)} or ${formatDate(intl.date)}.` };
    return us ?? (a > 12 ? fromMonthDay(b - 1, a, year) : null);
  }

  m = new RegExp(`^(?:(this|next|on|coming|this coming) )?${WEEKDAY_RE}$`, "i").exec(p);
  if (m) {
    const qualifier = m[1] ?? "";
    const target = WEEKDAYS.findIndex((w) => w.startsWith(m![2]!.slice(0, 3)));
    const ahead = (target - weekdayOf(today) + 7) % 7; // 0..6
    const upcoming = addDays(today, ahead === 0 ? 7 : ahead);
    if (qualifier === "next") {
      // "next Friday" = the Friday of next calendar week (weeks start Monday).
      const daysToNextMonday = ((8 - weekdayOf(today)) % 7) || 7;
      const nextWeek = addDays(today, daysToNextMonday + ((target + 6) % 7));
      if (nextWeek !== upcoming) {
        return { date: nextWeek, phrase, ambiguous: true, alternatives: [upcoming], note: `"${phrase}" could mean ${formatDate(upcoming)} or ${formatDate(nextWeek)}.` };
      }
      return plain(nextWeek);
    }
    if (ahead === 0) {
      return { date: upcoming, phrase, ambiguous: true, alternatives: [today], note: `"${phrase}" could mean today or ${formatDate(upcoming)}.` };
    }
    return plain(upcoming);
  }
  return null;
}

// ───────────────────────────── Names ─────────────────────────────

export function normalizeName(name: string): string {
  let n = name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
  // Airline formats: "OKAFOR/MAYA" and "Okafor, Maya" mean "Maya Okafor".
  const swap = /^([^/,]+)[/,]\s*(.+)$/.exec(n);
  if (swap) n = `${swap[2]} ${swap[1]}`;
  return n.replace(/\b(mr|mrs|ms|miss|dr|mx)\.?\s/g, " ").replace(/[^a-z\s-]/g, "").replace(/[\s-]+/g, " ").trim();
}

function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let last = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, last + (a[i - 1] === b[j - 1] ? 0 : 1));
      last = tmp;
    }
  }
  return prev[b.length]!;
}

export type NameMatch = "exact" | "middle_omitted" | "typo" | "different";

/** Compare a traveler or recipient name the way a gate agent would. */
export function compareNames(expected: string, actual: string): NameMatch {
  const e = normalizeName(expected), a = normalizeName(actual);
  if (e === a) return "exact";
  const et = e.split(" "), at = a.split(" ");
  if (et.length >= 2 && at.length >= 2 && et[0] === at[0] && et.at(-1) === at.at(-1)) return "middle_omitted";
  if (editDistance(e, a) <= 2) return "typo";
  return "different";
}

// ─────────────────────── Canonical JSON and hashing ───────────────────────

/** Deterministic JSON: sorted keys, no undefined. The same record always hashes the same. */
export function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonical(): non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((v) => canonical(v === undefined ? null : v)).join(",")}]`;
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  throw new TypeError(`canonical(): cannot serialize ${typeof value}`);
}

const hex = (buf: ArrayBuffer): string => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

export async function sha256(text: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

export function randomId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  return `${prefix}_${[...bytes].map((b) => b.toString(36).padStart(2, "0")).join("").slice(0, 14)}`;
}

/** Read a dotted path ("item.variant.size") out of an object. */
export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}
