/**
 * MCP server (stdio, JSON-RPC 2.0, no dependencies).
 *
 * Gives any MCP-capable agent four tools, so the model itself can capture the
 * request, check a cart before paying, record the confirmation, and resolve
 * relative dates in the user's time zone.
 */
import { createInterface } from "node:readline";
import { Backstop, type Intent, type Verdict } from "./backstop.js";
import { flight, nothing, restaurant, retail, type PackIntent } from "./packs/index.js";
import { isMoney, money, resolveDate, type Money } from "./primitives.js";
import { prefer, type Cart } from "./rules.js";

type Json = Record<string, unknown>;
const MONEY_KEYS = new Set(["maxPrice", "price", "maxTotal", "total", "maxDeposit", "deposit", "forfeits", "amount"]);

/** Models send prices as numbers; accept 362, "362", {amount, currency} or Money. */
function toMoney(v: unknown): Money {
  if (isMoney(v)) return v;
  if (typeof v === "number") return money(v);
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v.replace(/[$,]/g, "")))) return money(Number(v.replace(/[$,]/g, "")));
  if (typeof v === "object" && v !== null && typeof (v as Json).amount === "number") return money((v as Json).amount as number, ((v as Json).currency as string) ?? "USD");
  throw new Error(`Expected a money amount, got ${JSON.stringify(v)}`);
}

/** Convert money fields, and `{ prefer: x }` into a preference. */
function normalize(obj: Json): Json {
  const out: Json = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) continue;
    if (MONEY_KEYS.has(k)) out[k] = toMoney(v);
    else if (k === "url") out.ref = v;
    else if (typeof v === "object" && !Array.isArray(v) && "prefer" in (v as Json)) out[k] = prefer((v as Json).prefer);
    else if (k === "variant" && typeof v === "object") out[k] = normalize(v as Json);
    else out[k] = v;
  }
  return out;
}

function wantsFor(pack: string, fields: Json): PackIntent {
  const f = normalize(fields) as never;
  if (pack === "flight") return flight.wants(f);
  if (pack === "retail") return retail.wants(f);
  if (pack === "restaurant") return restaurant.wants(f);
  if (pack === "none") return nothing();
  throw new Error(`Unknown pack "${pack}". Use flight, retail, restaurant or none.`);
}

function cartFor(pack: string, fields: Json): Cart {
  const f = normalize(fields) as never;
  if (pack === "flight") return flight.cart(f);
  if (pack === "retail") return retail.cart(f);
  if (pack === "restaurant") return restaurant.cart(f);
  if (pack === "custom") {
    const c = f as Json;
    return { action: String(c.action), amount: toMoney(c.amount), merchant: c.merchant as string | undefined, summary: c.summary as string | undefined, item: (c.item as Json) ?? {}, ...(c.ref ? { ref: String(c.ref) } : {}) };
  }
  throw new Error(`Unknown pack "${pack}". Use flight, retail, restaurant or custom.`);
}

const obj = (properties: Json, required: string[]) => ({ type: "object", properties, required });
const TOOLS = [
  {
    name: "backstop_capture_intent",
    description: "Call FIRST, as soon as the user asks you to buy, book, reserve or cancel something, and also when they only ask a question (use pack \"none\"). Records what the user asked for, in their words and as structured fields. Returns an intentId, a one-line summary to show the user, and any questions to ask them before acting.",
    inputSchema: obj({
      user: { type: "string", description: "Your id for the user." },
      request: { type: "string", description: "The user's request, verbatim." },
      timeZone: { type: "string", description: "The user's IANA time zone, e.g. America/New_York." },
      pack: { type: "string", enum: ["flight", "retail", "restaurant", "none"], description: "\"none\" when the user is only asking a question: it authorizes no purchase." },
      wants: {
        type: "object",
        description: "What the user asked for. flight: {from,to,date(YYYY-MM-DD),departs:[\"06:00\",\"12:00\"],maxPrice,refundable,passenger,seat,cabin,nonstop,airline}. retail: {product|sku,variant:{size,color},quantity,maxTotal,merchant,deliverBy}. restaurant: {venue,date,time:[from,to],partySize,maxDeposit}. Only include what the user actually said. Wrap a soft preference as {\"prefer\": value}. Prices are numbers in USD.",
      },
    }, ["user", "request", "timeZone", "pack"]),
  },
  {
    name: "backstop_check_cart",
    description: "Call IMMEDIATELY BEFORE paying, booking or cancelling. Compares what you are about to do with what the user asked for. status \"pass\": proceed with exactly this cart. \"block\": do not pay; follow the fixes and check again. \"ask\": put the question to the user, then call again with approved set to their answer.",
    inputSchema: obj({
      intentId: { type: "string" },
      pack: { type: "string", enum: ["flight", "retail", "restaurant", "custom"] },
      cart: {
        type: "object",
        description: "What you are about to buy, exactly as the merchant shows it. flight: {from,to,date,departs(HH:MM),price,refundable,passenger,seat,cabin,stops,airline,flight,url}. retail: {product,sku,merchant,variant,quantity,total(incl. shipping and tax),arrives,url}. restaurant: {venue,date,time,partySize,deposit,url}. custom: {action,amount,merchant,summary,item,url}. url is the offer's page.",
      },
      approved: { type: "boolean", description: "Only after an \"ask\" verdict: the user's answer to the question." },
      userReply: { type: "string", description: "If you already asked the user one of the questionsForUser from backstop_capture_intent, their reply, verbatim." },
    }, ["intentId", "pack", "cart"]),
  },
  {
    name: "backstop_confirm_order",
    description: "Call RIGHT AFTER the merchant confirms. Compares the confirmation with the checked cart. status \"drift\" means the merchant confirmed something the user did not ask for: cancel or correct it now and tell the user.",
    inputSchema: obj({
      intentId: { type: "string" },
      orderId: { type: "string", description: "The merchant's confirmation number." },
      amount: { type: "number", description: "What was actually charged, in USD." },
      item: { type: "object", description: "Any fields the confirmation shows that could differ (date, seat, size…)." },
    }, ["intentId"]),
  },
  {
    name: "backstop_resolve_date",
    description: "Turn a date phrase (\"next Friday\", \"tomorrow\", \"Nov 20\") into a calendar date in the user's time zone. Use it instead of computing dates yourself. If ambiguous is true, ask the user which date they mean.",
    inputSchema: obj({ phrase: { type: "string" }, timeZone: { type: "string" } }, ["phrase", "timeZone"]),
  },
];

export interface McpState { backstop: Backstop; intents: Map<string, Intent>; verdicts: Map<string, Verdict> }

/** Handle one tool call. Exported so it can be tested without a transport. */
export async function callTool(state: McpState, name: string, args: Json): Promise<Json> {
  const { backstop: b, intents, verdicts } = state;
  const intentOf = (id: unknown): Intent => {
    const i = intents.get(String(id));
    if (!i) throw new Error(`No intent ${String(id)}. Call backstop_capture_intent first.`);
    return i;
  };
  if (name === "backstop_capture_intent") {
    const intent = await b.intent({ user: String(args.user), request: String(args.request), timeZone: String(args.timeZone ?? "UTC"), wants: wantsFor(String(args.pack), (args.wants as Json) ?? {}) });
    intents.set(intent.id, intent);
    return { intentId: intent.id, summary: intent.summary, questionsForUser: intent.questions, warnings: intent.warnings.map((w) => w.message), authorizes: intent.body.allow };
  }
  if (name === "backstop_check_cart") {
    let intent = intentOf(args.intentId);
    if (typeof args.userReply === "string" && args.userReply.trim() && !intent.acknowledged) {
      intent = await b.acknowledge(intent, { method: "user reply relayed by agent", answers: [{ question: intent.questions.join(" "), answer: args.userReply }] });
      intents.set(intent.id, intent);
    }
    const pending = verdicts.get(intent.id);
    let v: Verdict;
    if (typeof args.approved === "boolean" && pending?.status === "ask") v = await b.resolve(pending, { approved: args.approved });
    else v = await b.check(intent, cartFor(String(args.pack), (args.cart as Json) ?? {}));
    verdicts.set(intent.id, v);
    return {
      status: v.status,
      instruction: v.forAgent,
      questionForUser: v.question,
      fixes: v.reasons.map((r) => r.fix),
      checks: v.findings.map((f) => ({ field: f.label, ok: f.ok, expected: f.expected, actual: f.actual })),
      guarantee: v.guarantee,
      verdictId: v.id,
    };
  }
  if (name === "backstop_confirm_order") {
    const intent = intentOf(args.intentId);
    const v = verdicts.get(intent.id);
    if (!v || v.status !== "pass") throw new Error("No passed check for this intent. Call backstop_check_cart and get status \"pass\" before ordering.");
    const c = await b.commit(v, { id: args.orderId as string | undefined, amount: args.amount === undefined ? undefined : toMoney(args.amount), item: args.item as Json | undefined });
    return { status: c.status, instruction: c.forAgent, changed: c.changed, violations: c.violations.map((x) => x.message) };
  }
  if (name === "backstop_resolve_date") {
    const r = resolveDate(String(args.phrase), { timeZone: String(args.timeZone ?? "UTC") });
    return r ? { ...r } : { date: null, note: "No date found in that phrase. Ask the user for the date." };
  }
  throw new Error(`Unknown tool ${name}`);
}

/** Start the server on stdin/stdout. */
export function serve(backstop: Backstop = new Backstop({ guarantee: process.env.BACKSTOP_SANDBOX === "1" ? "sandbox" : null })): void {
  const state: McpState = { backstop, intents: new Map(), verdicts: new Map() };
  const send = (msg: Json) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
  const rl = createInterface({ input: process.stdin });
  rl.on("line", async (line) => {
    if (!line.trim()) return;
    let req: { id?: string | number; method?: string; params?: Json };
    try { req = JSON.parse(line); } catch { return send({ id: null, error: { code: -32700, message: "Parse error" } }); }
    const { id, method, params = {} } = req;
    if (id === undefined) return; // notifications need no reply
    try {
      if (method === "initialize") {
        send({ id, result: { protocolVersion: (params.protocolVersion as string) ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "backstop", version: "0.1.0" }, instructions: "Capture the user's intent before acting, check every cart right before paying, and confirm every order right after." } });
      } else if (method === "ping") send({ id, result: {} });
      else if (method === "tools/list") send({ id, result: { tools: TOOLS } });
      else if (method === "tools/call") {
        try {
          const out = await callTool(state, String(params.name), (params.arguments as Json) ?? {});
          send({ id, result: { content: [{ type: "text", text: JSON.stringify(out, null, 2) }], structuredContent: out, isError: false } });
        } catch (e) {
          send({ id, result: { content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true } });
        }
      } else send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
    } catch (e) {
      send({ id, error: { code: -32603, message: e instanceof Error ? e.message : String(e) } });
    }
  });
}
