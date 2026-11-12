/**
 * Backstop: three comparisons around every agent purchase.
 *
 *   words  ↔ intent   intent()   Did we capture what the person said?
 *   intent ↔ cart     check()    Is the agent about to buy what was asked?
 *   cart   ↔ order    commit()   Did the merchant charge what was checked?
 *
 * Each step is sealed into a signed record. claim() replays that record later.
 */
import { buildIntentBody, summarize, actionWords, type IntentBody, type IntentInput, type Warning } from "./intent.js";
import { canonical, formatDate, formatMoney, isMoney, sha256, type Money } from "./primitives.js";
import { seal, signerFrom, verifyChain, type ChainCheck, type Envelope, type KeyPair, type Signer } from "./record.js";
import { evaluate, type Cart, type Finding, type FindingCode } from "./rules.js";

// ───────────────────────────── Types ─────────────────────────────

export interface Intent {
  id: string;
  body: IntentBody;
  /** The record so far. Store it; you need it for commit() and claim(). */
  chain: Envelope[];
  /** Mismatches between the user's words and the structured fields. */
  warnings: Warning[];
  /** Questions worth asking the user before acting (from warnings). */
  questions: string[];
  /** One line to show the user: "I'll book a flight: origin JFK, …". */
  summary: string;
  /** True once the user has confirmed the summary. */
  acknowledged: boolean;
}

export interface Guarantee {
  id: string;
  /** "sandbox" guarantees are simulations for development. They are not backed by money. */
  status: "sandbox" | "active";
  fee: Money;
  /** Most that will be paid to put a covered mistake right. */
  coverage: Money;
  terms: string;
}

export interface GuaranteeRequest {
  intentId: string;
  intentHash: string;
  cartHash: string;
  cart: Cart;
  pack: string;
}

/** Plug in whoever stands behind passed checks. Return null to issue nothing. */
export interface GuaranteeProvider {
  issue(req: GuaranteeRequest): Promise<Guarantee | null>;
}

export interface AskItem {
  /** Stable key: a rule field, "warning:<code>", "policy:<name>" or "intent_expired". */
  key: string;
  question: string;
}

export type VerdictStatus = "pass" | "block" | "ask";

export interface Verdict {
  id: string;
  status: VerdictStatus;
  intent: Intent;
  cart: Cart;
  /** Every rule, passed or failed, in order. */
  findings: Finding[];
  /** Why it was blocked. Empty unless status is "block". */
  reasons: Finding[];
  /** What to ask the user. Empty unless status is "ask". */
  asks: AskItem[];
  /** All questions as one message for the user, or null. */
  question: string | null;
  /** Feed this back to the model as the tool result. */
  forAgent: string;
  guarantee: Guarantee | null;
  /** Intent chain plus this verdict. */
  chain: Envelope[];
}

export interface VerdictBody {
  intentId: string;
  cart: Cart;
  status: VerdictStatus;
  findings: Pick<Finding, "field" | "code" | "ok" | "strength" | "expected" | "actual">[];
  waived: string[];
  guarantee: Guarantee | null;
}

export interface OrderInput {
  /** The merchant's confirmation or order number. */
  id?: string;
  /** What was actually charged. */
  amount?: Money;
  merchant?: string;
  /** Any item fields the confirmation shows (date, seat, size…). Unlisted fields are assumed unchanged. */
  item?: Record<string, unknown>;
}

export interface Commit {
  /** "drift" means the merchant confirmed something the user did not ask for. Act now, while it's cheap to undo. */
  status: "confirmed" | "drift";
  violations: Finding[];
  /** Fields that differ from the checked cart, whether or not they break a rule. */
  changed: string[];
  forAgent: string;
  chain: Envelope[];
}

export type ClaimReason = "not_what_i_asked" | "changed_mind" | "merchant_fault";

export interface ClaimInput {
  chain: Envelope[];
  reason: ClaimReason;
  /** What actually arrived or was ticketed, if it differs from the recorded order. */
  delivered?: OrderInput;
  /** Defaults to this instance's public key. */
  publicKey?: string;
}

export type ClaimBasis =
  | "record_invalid"
  | "never_cleared"
  | "merchant_responsibility"
  | "delivered_differs_from_request"
  | "matches_request"
  | "matches_acknowledged_request"
  | "intent_capture_unconfirmed"
  | "summary_not_acknowledged";

export interface ClaimDecision {
  status: "approved" | "denied" | "review";
  basis: ClaimBasis;
  explanation: string;
  violations: Finding[];
  payableUpTo: Money | null;
  record: ChainCheck;
}

export interface Policy {
  /** Ask the user before any purchase above this amount, even if it matches. */
  askAbove?: Money;
  /** Ask when the intent has no price limit. Default false. */
  requireAmountLimit?: boolean;
  /** Ask when lint found a mismatch between the user's words and the fields. Default true. */
  askOnWarnings?: boolean;
}

export interface IntentState { attempts: number; orders: number }
/** Counters per intent. Swap in Redis or your database when you run more than one process. */
export interface Store {
  get(key: string): Promise<IntentState | undefined>;
  set(key: string, value: IntentState): Promise<void>;
}
export class MemoryStore implements Store {
  private m = new Map<string, IntentState>();
  async get(key: string) { return this.m.get(key); }
  async set(key: string, value: IntentState) { this.m.set(key, value); }
}

export interface BackstopOptions {
  /** Ed25519 keys from generateKeys(). Without them records are hashed but unsigned. */
  keys?: KeyPair;
  /** "sandbox" simulates a guarantee on every pass. Pass your own provider for a real one. */
  guarantee?: "sandbox" | GuaranteeProvider | null;
  policy?: Policy;
  store?: Store;
  /** Override the clock (tests, replays). */
  now?: () => Date;
}

export class BackstopError extends Error { override name = "BackstopError"; }
/** Thrown by protect() when the cart doesn't match the request. `message` is written for the model. */
export class BackstopBlocked extends BackstopError {
  override name = "BackstopBlocked";
  constructor(public verdict: Verdict) { super(verdict.forAgent); }
}
/** Thrown by protect() when the user has to answer a question first. */
export class BackstopNeedsUser extends BackstopError {
  override name = "BackstopNeedsUser";
  constructor(public verdict: Verdict) { super(verdict.forAgent); }
}

export interface ProtectOptions<A extends unknown[], R> {
  /** The intent this call belongs to. */
  intent: (...args: A) => Intent | Promise<Intent>;
  /** Describe what the tool is about to buy. */
  cart: (...args: A) => Cart | Promise<Cart>;
  /** Read the merchant's confirmation out of the tool result, to catch drift. */
  order?: (result: R, ...args: A) => OrderInput;
  /** Ask the user. Resolve true to proceed. Without it, an "ask" verdict throws BackstopNeedsUser. */
  onAsk?: (verdict: Verdict) => boolean | Promise<boolean>;
  /** Called when the confirmed order differs from the request. */
  onDrift?: (commit: Commit, result: R) => void | Promise<void>;
  /** Called after every check, for logging. */
  onVerdict?: (verdict: Verdict) => void;
}

// ───────────────────────────── Sandbox guarantee ─────────────────────────────

/** Illustrative pricing for development. Real terms come from the guarantee provider. */
export const sandboxGuarantee: GuaranteeProvider = {
  async issue(req) {
    const { currency, minor } = req.cart.amount;
    const fee = Math.max(75, Math.round(minor * 0.003));
    const coverage = Math.ceil((minor + 25_000) / 5_000) * 5_000;
    return {
      id: `gtee_sandbox_${req.cartHash.slice(0, 12)}`,
      status: "sandbox",
      fee: { currency, minor: fee },
      coverage: { currency, minor: coverage },
      terms: "Sandbox simulation. Covers the cost to correct an order that differs from the signed request. Not backed by funds.",
    };
  },
};

// ───────────────────────────── Backstop ─────────────────────────────

const gate = (code: FindingCode, expected: string, actual: string, message: string, fix: string): Finding => ({
  field: "action", label: "Authorized action", strength: "must", ok: false, code, expected, actual, message, fix,
});

export class Backstop {
  private signer: Promise<Signer | null>;
  private provider: GuaranteeProvider | null;
  private store: Store;
  private policy: Required<Pick<Policy, "requireAmountLimit" | "askOnWarnings">> & Pick<Policy, "askAbove">;
  private clock: () => Date;
  /** Share this with merchants or auditors so they can verify your records. */
  readonly publicKey: string | null;

  constructor(opts: BackstopOptions = {}) {
    this.signer = opts.keys ? signerFrom(opts.keys) : Promise.resolve(null);
    this.publicKey = opts.keys?.publicKey ?? null;
    this.provider = opts.guarantee === "sandbox" ? sandboxGuarantee : opts.guarantee ?? null;
    this.store = opts.store ?? new MemoryStore();
    this.policy = { requireAmountLimit: false, askOnWarnings: true, ...opts.policy };
    this.clock = opts.now ?? (() => new Date());
  }

  /** Step 1. Capture what the user asked for, and lint it against their own words. */
  async intent(input: IntentInput): Promise<Intent> {
    const now = input.now ?? this.clock();
    const body = buildIntentBody({ ...input, now });
    const env = await seal("intent", body, { signer: await this.signer, at: now });
    return this.toIntent([env]);
  }

  /** Record that the user saw and confirmed the summary. Clears lint questions and strengthens the record. */
  async acknowledge(intent: Intent, how: { method?: string } = {}): Promise<Intent> {
    const env = await seal("ack", { intentId: intent.id, summary: intent.summary, method: how.method ?? "confirmed" }, { prev: intent.chain.at(-1), signer: await this.signer, at: this.clock() });
    return this.toIntent([...intent.chain, env]);
  }

  /** Rebuild an Intent from a stored chain. */
  restore(chain: Envelope[]): Intent {
    if (chain[0]?.type !== "intent") throw new BackstopError("restore(): chain must start with an intent");
    return this.toIntent(chain.filter((e) => e.type === "intent" || e.type === "ack"));
  }

  private toIntent(chain: Envelope[]): Intent {
    const env = chain[0] as Envelope<IntentBody>;
    const acknowledged = chain.some((e) => e.type === "ack");
    return {
      id: env.id,
      body: env.body,
      chain,
      warnings: env.body.warnings,
      questions: acknowledged ? [] : env.body.warnings.flatMap((w) => (w.question ? [w.question] : [])),
      summary: summarize(env.body),
      acknowledged,
    };
  }

  /** Step 2. Compare the cart with the intent. Call this right before you pay. */
  async check(intent: Intent, cart: Cart, opts: { waive?: string[] } = {}): Promise<Verdict> {
    return this.runCheck(intent, cart, opts.waive ?? [], true);
  }

  private async runCheck(intent: Intent, cart: Cart, waive: string[], countAttempt: boolean): Promise<Verdict> {
    if (!cart || typeof cart.action !== "string" || !isMoney(cart.amount) || typeof cart.item !== "object" || cart.item === null) {
      throw new BackstopError("check(): cart must have { action, amount: { currency, minor }, item }");
    }
    const { body } = intent;
    const now = this.clock();
    const state = (await this.store.get(intent.id)) ?? { attempts: 0, orders: 0 };
    if (countAttempt) { state.attempts++; await this.store.set(intent.id, state); }

    const findings: Finding[] = [];
    const asks: AskItem[] = [];
    const doing = actionWords(cart.action);

    if (!body.allow.includes(cart.action)) {
      findings.push(body.allow.length === 0
        ? gate("action_not_authorized", "no purchase", doing, `The user asked a question only. The agent is about to ${doing}.`, `Do not ${doing}. Answer the user's question instead.`)
        : gate("action_not_authorized", body.allow.map(actionWords).join(" or "), doing, `The user asked to ${body.allow.map(actionWords).join(" or ")}. The agent is about to ${doing}.`, `Do not ${doing}. The user only asked to ${body.allow.map(actionWords).join(" or ")}.`));
    } else if (state.orders >= body.maxOrders) {
      findings.push(gate("duplicate_order", `${body.maxOrders} order`, `${state.orders} already placed`, "This request already produced an order. A second purchase would be a duplicate.", "Stop. This request is already fulfilled. Do not place another order."));
    } else if (state.attempts > body.maxAttempts) {
      findings.push(gate("too_many_attempts", `${body.maxAttempts} attempts`, `${state.attempts}`, `The agent has tried ${state.attempts} carts for this request.`, "Stop retrying and ask the user how to proceed."));
    } else {
      for (const rule of body.rules) {
        const f = evaluate(rule, cart);
        findings.push(f);
        if (!f.ok && f.strength === "prefer") asks.push({ key: f.field, question: `${f.label}: this option has ${f.actual}, and you asked for ${f.expected}. Go ahead anyway?` });
      }
      if (now.toISOString() > body.expiresAt) asks.push({ key: "intent_expired", question: `You asked for this on ${formatDate(body.createdAt.slice(0, 10))}. Do you still want it?` });
      if (this.policy.askOnWarnings && !intent.acknowledged) {
        for (const w of body.warnings) if (w.question) asks.push({ key: `warning:${w.code}`, question: w.question });
      }
      const capped = body.rules.some((r) => r.test.op === "money_lte" && r.field === "amount");
      if (this.policy.requireAmountLimit && !capped) asks.push({ key: "policy:requireAmountLimit", question: `You didn't set a budget. Is ${formatMoney(cart.amount)} okay?` });
      const above = this.policy.askAbove;
      if (above && above.currency === cart.amount.currency && cart.amount.minor > above.minor) asks.push({ key: "policy:askAbove", question: `This costs ${formatMoney(cart.amount)}. Go ahead?` });
    }

    const reasons = findings.filter((f) => !f.ok && f.strength === "must");
    const open = asks.filter((a) => !waive.includes(a.key));
    const status: VerdictStatus = reasons.length ? "block" : open.length ? "ask" : "pass";

    const intentHash = intent.chain[0]!.hash;
    const cartHash = await sha256(canonical(cart));
    const guarantee = status === "pass" && this.provider ? await this.provider.issue({ intentId: intent.id, intentHash, cartHash, cart, pack: body.pack }) : null;

    const sealed: VerdictBody = {
      intentId: intent.id, cart, status, waived: waive, guarantee,
      findings: findings.map(({ field, code, ok, strength, expected, actual }) => ({ field, code, ok, strength, expected, actual })),
    };
    const env = await seal("verdict", sealed, { prev: intent.chain.at(-1), signer: await this.signer, at: now });
    const question = status === "ask" ? open.map((a) => a.question).join(" ") : null;
    const forAgent =
      status === "pass" ? "Backstop: cleared. Proceed to checkout with exactly this cart."
      : status === "block" ? `Backstop blocked this purchase. Do not check out.\n${reasons.map((r) => `- ${r.message} ${r.fix ?? ""}`.trim()).join("\n")}\nFix the cart and check it again.`
      : `Backstop: do not pay yet. Ask the user: "${question}"`;

    return { id: env.id, status, intent, cart, findings, reasons: status === "block" ? reasons : [], asks: status === "ask" ? open : [], question, forAgent, guarantee, chain: [...intent.chain, env] };
  }

  /** After an "ask" verdict: record the user's answer. Yes re-checks and passes; no blocks. */
  async resolve(verdict: Verdict, answer: { approved: boolean; by?: string }): Promise<Verdict> {
    if (verdict.status !== "ask") throw new BackstopError("resolve(): only an \"ask\" verdict needs resolving");
    const res = await seal("resolution", { verdictId: verdict.id, question: verdict.question, approved: answer.approved, by: answer.by ?? "user" }, { prev: verdict.chain.at(-1), signer: await this.signer, at: this.clock() });
    const intent: Intent = { ...verdict.intent, chain: [...verdict.chain, res] };
    if (answer.approved) return this.runCheck(intent, verdict.cart, verdict.asks.map((a) => a.key), false);
    return {
      ...verdict, status: "block", asks: [], question: null, guarantee: null, chain: intent.chain,
      reasons: [gate("mismatch", "user approval", "declined", "The user declined this option.", "Offer the user a different option.")],
      forAgent: "Backstop: the user declined this option. Do not check out. Offer a different option.",
    };
  }

  /** Step 3. Compare the merchant's confirmation with what was checked. Call it as soon as you have the confirmation. */
  async commit(verdict: Verdict, order: OrderInput = {}): Promise<Commit> {
    if (verdict.status !== "pass") throw new BackstopError(`commit(): the verdict is "${verdict.status}". Only a passed check can be committed.`);
    const delivered = mergeOrder(verdict.cart, order);
    const violations = verdict.intent.body.rules.map((r) => evaluate(r, delivered)).filter((f) => !f.ok && f.strength === "must");
    const changed = diffCart(verdict.cart, delivered);
    if (delivered.amount.minor > verdict.cart.amount.minor && !violations.some((v) => v.field === "amount")) {
      // Charged more than was checked, though still inside the user's limit. Worth knowing, not a violation.
      if (!changed.includes("amount")) changed.push("amount");
    }
    const status = violations.length ? "drift" : "confirmed";
    const state = (await this.store.get(verdict.intent.id)) ?? { attempts: 0, orders: 0 };
    state.orders++;
    await this.store.set(verdict.intent.id, state);
    const env = await seal("order", { verdictId: verdict.id, orderId: order.id ?? null, delivered, status, changed, violations: violations.map(({ field, code, expected, actual }) => ({ field, code, expected, actual })) }, { prev: verdict.chain.at(-1), signer: await this.signer, at: this.clock() });
    const forAgent = status === "confirmed"
      ? "Backstop: order confirmed and matches the request."
      : `Backstop: the confirmed order differs from the request.\n${violations.map((v) => `- ${v.message}`).join("\n")}\nCancel or correct it now, while changes are free, and tell the user.`;
    return { status, violations, changed, forAgent, chain: [...verdict.chain, env] };
  }

  /** Decide a claim by replaying the record. Deterministic: the same chain always gives the same answer. */
  async claim(input: ClaimInput): Promise<ClaimDecision> {
    const record = await verifyChain(input.chain, input.publicKey ?? this.publicKey ?? undefined);
    const decide = (status: ClaimDecision["status"], basis: ClaimBasis, explanation: string, violations: Finding[] = [], payableUpTo: Money | null = null): ClaimDecision => ({ status, basis, explanation, violations, payableUpTo, record });
    const intentEnv = input.chain.find((e) => e.type === "intent") as Envelope<IntentBody> | undefined;
    if (!record.ok || !intentEnv) return decide("review", "record_invalid", `The record could not be verified: ${record.problems.join("; ") || "no intent found"}.`);
    const verdictEnv = input.chain.filter((e) => e.type === "verdict").map((e) => e as Envelope<VerdictBody>).filter((e) => e.body.status === "pass").at(-1);
    if (!verdictEnv) return decide("denied", "never_cleared", "No check ever passed for this request, so the purchase was made outside the guarantee.");
    if (input.reason === "merchant_fault") return decide("denied", "merchant_responsibility", "A cancellation, delay or defect is the merchant's or carrier's responsibility. This guarantee covers agent mistakes.");

    const orderEnv = input.chain.filter((e) => e.type === "order").at(-1) as Envelope<{ delivered: Cart }> | undefined;
    const subject = mergeOrder(orderEnv?.body.delivered ?? verdictEnv.body.cart, input.delivered ?? {});
    const violations = intentEnv.body.rules.map((r) => evaluate(r, subject)).filter((f) => !f.ok && f.strength === "must");
    const cover = verdictEnv.body.guarantee?.coverage ?? null;
    if (violations.length) return decide("approved", "delivered_differs_from_request", "What was delivered differs from the signed request.", violations, cover);
    if (input.reason === "changed_mind") return decide("denied", "matches_request", "The order matches every requirement in the signed request. A change of plans is not an agent mistake.");

    const acked = input.chain.some((e) => e.type === "ack");
    const resolved = input.chain.some((e) => e.type === "resolution" && (e.body as { approved: boolean }).approved);
    if (intentEnv.body.warnings.some((w) => w.question) && !acked && !resolved) {
      return decide("review", "intent_capture_unconfirmed", "The order matches the structured request, but that request disagreed with the user's own words and was never confirmed with them. A person should compare the two.", [], cover);
    }
    if (!acked) return decide("review", "summary_not_acknowledged", "The order matches the structured request, but the user never confirmed that summary. A person should compare it with the original words.", [], cover);
    return decide("denied", "matches_acknowledged_request", "The order matches the request the user confirmed.");
  }

  /** Verify a record's hashes, links and signatures. */
  verify(chain: Envelope[], publicKey?: string): Promise<ChainCheck> {
    return verifyChain(chain, publicKey ?? this.publicKey ?? undefined);
  }

  /**
   * Wrap a purchase function so it can't run on a mismatched cart.
   * The check happens before your function; commit() happens after, if you map `order`.
   */
  protect<A extends unknown[], R>(fn: (...args: A) => Promise<R> | R, opts: ProtectOptions<A, R>): (...args: A) => Promise<R> {
    return async (...args: A): Promise<R> => {
      const intent = await opts.intent(...args);
      let verdict = await this.check(intent, await opts.cart(...args));
      opts.onVerdict?.(verdict);
      if (verdict.status === "ask") {
        if (!opts.onAsk) throw new BackstopNeedsUser(verdict);
        verdict = await this.resolve(verdict, { approved: await opts.onAsk(verdict) });
        opts.onVerdict?.(verdict);
      }
      if (verdict.status !== "pass") throw new BackstopBlocked(verdict);
      const result = await fn(...args);
      const commit = await this.commit(verdict, opts.order ? opts.order(result, ...args) : {});
      if (commit.status === "drift") await opts.onDrift?.(commit, result);
      return result;
    };
  }
}

function mergeOrder(cart: Cart, order: OrderInput): Cart {
  return { ...cart, amount: order.amount ?? cart.amount, merchant: order.merchant ?? cart.merchant, item: { ...cart.item, ...(order.item ?? {}) } };
}

function diffCart(a: Cart, b: Cart): string[] {
  const out: string[] = [];
  if (canonical(a.amount) !== canonical(b.amount)) out.push("amount");
  if ((a.merchant ?? null) !== (b.merchant ?? null)) out.push("merchant");
  for (const k of new Set([...Object.keys(a.item), ...Object.keys(b.item)])) {
    if (canonical(a.item[k] ?? null) !== canonical(b.item[k] ?? null)) out.push(`item.${k}`);
  }
  return out;
}
