# Backstop

Check every AI-agent purchase against what the user actually asked for, before money moves.

Agents buy the wrong thing often: the wrong week, the wrong size, a fare over budget, a booking nobody requested. Backstop sits around the one call that spends money and makes three comparisons:

| Step | Compares | Catches |
| --- | --- | --- |
| `intent()` | the user's words ↔ the structured request | "next Friday" resolved a week late, a budget the agent forgot, a question treated as an order |
| `check()` | the request ↔ the cart | wrong date, price, size, seller, name, quantity; actions the user never authorized; duplicate orders |
| `commit()` | the cart ↔ the merchant's confirmation | fares that changed at payment, substitutions, anything that drifted |

Every step is sealed into a signed, hash-linked record that a merchant, auditor or insurer can verify offline, and that decides a later claim by replay.

- **Local and fast.** The check is pure code: no model call, no network, about a millisecond including hashing and signing. Nothing about your users leaves your process.
- **Zero dependencies.** TypeScript, ESM, Node 20+. Runs anywhere Web Crypto does.
- **TypeScript and Python.** The [Python SDK](python/README.md) gives the same verdicts word for word and writes the same signed record, so either one can verify the other's.
- **Fails closed.** A field the cart doesn't show can't be verified, so it doesn't pass.
- **One question, not a confirmation screen.** Hard requirements block. Soft preferences ask the user a single specific question.

> **Status: 0.1 preview.** Everything in this README runs today, locally. The guarantee (someone paying when a passed order still goes wrong) is a `sandbox` simulation in this release; it is not backed by funds. Not yet on npm: install from GitHub.

## Install

```sh
npm install github:germainhirwa/backstop-sdk
npx backstop demo     # three publicly reported agent mistakes, replayed through the check
```

Python:

```sh
pip install "backstop-sdk[sign] @ git+https://github.com/germainhirwa/backstop-sdk#subdirectory=python"
backstop demo
```

The rest of this page uses TypeScript. The same walkthrough in Python is in [python/README.md](python/README.md).

## Quickstart

```ts
import { Backstop, flight, prefer, usd } from "backstop-sdk";

const backstop = new Backstop();

// 1. When the user asks: capture it, in their words and as fields.
const intent = await backstop.intent({
  user: "user_123",
  request: "Book me JFK to Austin on Nov 20, morning, under $400, refundable. Aisle if you can.",
  timeZone: "America/New_York",
  wants: flight.wants({
    from: "JFK", to: "AUS", date: "2026-11-20",
    departs: ["06:00", "12:00"], maxPrice: usd(400), refundable: true,
    passenger: "Maya Okafor", seat: prefer("aisle"),
  }),
});

// 2. Right before paying: check the cart the agent built.
const verdict = await backstop.check(intent, flight.cart(offer));

if (verdict.status === "pass")  await pay(offer);
if (verdict.status === "block") return verdict.forAgent;   // give this to the model; it says what to fix
if (verdict.status === "ask")   return verdict.question;   // one question for the user

// 3. Right after the merchant confirms: catch drift while it's still free to undo.
const order = await backstop.commit(verdict, { id: confirmation, amount: charged });
if (order.status === "drift") await cancelAndTellUser(order.forAgent);
```

What a block looks like to the model:

```
Backstop blocked this purchase. Do not check out.
- Date is Fri, Nov 27; the user asked for Fri, Nov 20 (+7 days). That is exactly 1 week off,
  which usually means a relative date was resolved in the wrong time zone or week. Use 2026-11-20 (Fri, Nov 20).
Fix the cart and check it again.
```

## Or wrap the tool: one change, nothing else to remember

```ts
const safeBookFlight = backstop.protect(bookFlight, {
  intent: () => currentIntent,
  cart:   (offer) => flight.cart(offer),
  order:  (result) => ({ id: result.confirmation, amount: result.charged }),
  onAsk:  (verdict) => askUser(verdict.question),        // resolve true to proceed
  onDrift: (commit) => cancelAndTellUser(commit.forAgent),
});
```

`safeBookFlight` cannot run on a mismatched cart. It throws `BackstopBlocked`, whose `message` is written for the model, so most agent frameworks pass it straight back as the tool result. It also runs `commit()` for you and refuses a second order for the same request.

## Test your agent in five minutes

The Agent Mistake Test is 50 offline purchase tasks (flights, retail, restaurants, and questions that should lead to no purchase). Each has one trap: a cheaper flight in the wrong week, a size that's on sale, a reseller, a fee that pushes the total over budget.

```sh
npx backstop eval ./my-agent.mjs
```

```js
// my-agent.mjs
export default async function agent(task) {
  // task = { request, now, timeZone, user, offers }
  const cart = await yourAgent.choose(task);
  return { cart };          // or { ask: "…" } or { decline: "…" }
}
```

```
Agent Mistake Test: reference agent (always buys the cheapest offer)
50 purchase tasks, one trap each

  Wrong purchases      43   86% of tasks, $5,450.06 at risk
  Should have asked     2   bought when one question was needed
  Missed                0   held off when a matching offer existed
  Correct               5

  Wrong purchases by trap
    relative_date          3/3  ██████████
    question_not_order     10/10  ██████████
    refundable             2/2  ██████████
    …
```

Return `{ cart, intent }` (the intent your agent captured) and the report adds how many of those wrong purchases Backstop would have stopped before payment. Tasks are scored against hand-written ground truth. The suite is small and synthetic: use it to find failure patterns, not as a production error rate.

## Concepts

### Requirements and preferences

```ts
flight.wants({ refundable: true, seat: prefer("aisle") })
```

`refundable: true` is a requirement: a non-refundable fare is blocked. `prefer("aisle")` is a preference: if only a window seat is left, the verdict is `ask` with one question ("Seat: this option has window, and you asked for aisle. Go ahead anyway?"). Record the answer with `backstop.resolve(verdict, { approved })`.

### A question is not an order

```ts
import { nothing } from "backstop-sdk";
await backstop.intent({ user, request: "What are the cancellation terms on my flight?", wants: nothing() });
```

An intent built with `nothing()` authorizes no action. If the agent then tries to cancel, book or reserve, the check blocks it. Every intent carries an `allow` list; an action outside it is blocked before any rule runs.

### Lint: did you capture what they said?

Once carts are checked against the structured request, the remaining risk is the request itself. `intent()` re-reads the user's words and warns when the fields disagree with them:

```ts
const intent = await backstop.intent({
  request: "Book JFK to Austin next Friday, under $400, refundable",
  timeZone: "America/New_York",
  wants: flight.wants({ date: "2026-11-27", maxPrice: usd(450), /* … */ }),
});
intent.warnings.map((w) => w.code);
// ["date_differs_from_request", "budget_differs_from_request", "refundable_not_captured"]
intent.questions;
// ['You said "next Friday". Should this be Fri, Nov 20 or Fri, Nov 27?', …]
```

By default `check()` returns `ask` while such a question is open, so a wrong capture can't silently pass. Show the user `intent.summary` and call `backstop.acknowledge(intent)` once they confirm; that clears the questions and makes the record much stronger.

### Dates in the user's time zone

```ts
import { resolveDate } from "backstop-sdk";
resolveDate("next Friday", { timeZone: "America/New_York" });
// { date: "2026-11-20", ambiguous: true, alternatives: ["2026-11-13"], note: '"next Friday" could mean …' }
```

It never guesses: text it can't read returns `null`, and phrases with two honest readings come back `ambiguous`.

### The record

```ts
const backstop = new Backstop({ keys: await generateKeys() });   // or: npx backstop keys
const check = await backstop.verify(order.chain);                // { ok: true, signed: true, problems: [] }
```

`intent → ack → verdict → resolution → order → claim`, each an envelope holding the hash of the one before it and an Ed25519 signature. Rules are stored as data, not code, so the same record can be re-run later, by anyone, in any language. Store `chain` with the order. Publish `backstop.publicKey` to whoever needs to verify.

### Claims by replay

```ts
const decision = await backstop.claim({ chain, reason: "not_what_i_asked", delivered: { item: { date: "2026-11-27" } } });
// { status: "approved", basis: "delivered_differs_from_request", payableUpTo: { currency: "USD", minor: 65000 } }
```

| The user says | The record shows | Decision |
| --- | --- | --- |
| Not what I asked for | Delivered order breaks a requirement | `approved` |
| Not what I asked for | Order matches a request the user acknowledged | `denied` |
| Not what I asked for | Order matches, but the user never confirmed the summary | `review` (a person compares it with their words) |
| I changed my mind | Order matches | `denied` |
| The airline cancelled | anything | `denied` (merchant's responsibility) |
| anything | No passing check, or the record was altered | `denied` / `review` |

## Packs

| Pack | `wants()` fields | Actions |
| --- | --- | --- |
| `flight` | `from`, `to`, `date`, `departs`, `maxPrice`, `refundable`, `passenger`, `seat`, `cabin`, `nonstop`, `airline` | `flight.book`, `flight.cancel`, `flight.change` |
| `retail` | `product` or `sku`, `variant`, `quantity` (default 1), `maxTotal`, `merchant`, `deliverBy` | `retail.purchase`, `retail.cancel`, `retail.return` |
| `restaurant` | `venue`, `date`, `time`, `partySize`, `maxDeposit` (default $0) | `restaurant.reserve`, `restaurant.cancel` |

Anything a pack doesn't cover, add as a rule, or skip packs entirely:

```ts
import { must, prefers } from "backstop-sdk";

await backstop.intent({
  user, request,
  wants: { allow: ["hotel.book"], rules: [
    must.on("item.checkIn", "2026-11-20", "Check-in"),
    must.costsAtMost(usd(600)),
    must.is("item.freeCancellation", true, "Free cancellation"),
    prefers.atLeast("item.rating", 4.5, "Rating"),
  ] },
});
await backstop.check(intent, { action: "hotel.book", amount: usd(540), item: { checkIn: "2026-11-20", freeCancellation: true, rating: 4.2 } });
```

## MCP server

For agents that take tools over MCP, with no code changes:

```json
{ "mcpServers": { "backstop": { "command": "npx", "args": ["backstop", "mcp"] } } }
```

Tools: `backstop_capture_intent`, `backstop_check_cart`, `backstop_confirm_order`, `backstop_resolve_date`. Set `BACKSTOP_SANDBOX=1` to attach sandbox guarantees.

## API

| Call | Returns |
| --- | --- |
| `new Backstop({ keys?, guarantee?, policy?, store?, now? })` | |
| `backstop.intent(input)` | `Intent`: `id`, `summary`, `warnings`, `questions`, `chain` |
| `backstop.acknowledge(intent)` | `Intent` with the user's confirmation sealed in |
| `backstop.check(intent, cart)` | `Verdict`: `status`, `findings`, `reasons`, `question`, `forAgent`, `guarantee`, `chain` |
| `backstop.resolve(verdict, { approved })` | `Verdict` after the user's answer |
| `backstop.commit(verdict, order?)` | `Commit`: `status` (`confirmed` \| `drift`), `violations`, `changed`, `chain` |
| `backstop.claim({ chain, reason, delivered? })` | `ClaimDecision`: `status`, `basis`, `explanation`, `payableUpTo` |
| `backstop.protect(fn, opts)` | the same function, guarded |
| `backstop.verify(chain)` / `backstop.restore(chain)` | chain check / `Intent` rebuilt from storage |

**Policy.** `askAbove: usd(500)` asks before any purchase over an amount. `requireAmountLimit: true` asks when the user set no budget. `askOnWarnings: false` turns off asking on lint questions.

**Store.** Attempt and order counters live in memory by default. With more than one process, pass a `store` with `get`/`set` backed by Redis or your database.

**Guarantee.** `guarantee: "sandbox"` simulates issuance and pricing. To attach a real one, pass any object with `issue(request)`; it is called once per passed check.

## What it doesn't do

- It doesn't read web pages or receipts. You describe the cart; a cart described wrongly is checked wrongly. Build carts from the same data you send to checkout, and use `commit()` with the merchant's confirmation.
- It doesn't extract intent from text. Your agent (or model) fills in `wants`; `lint` then cross-checks dates, budgets, refundability, quantity and question-versus-order against the words. Lint is English-only today.
- Product names match exactly (case-insensitive). Prefer `sku` where you have one.
- It isn't insurance. See Status.

See [DESIGN.md](./DESIGN.md) for the reasoning behind these choices.

## License

MIT
