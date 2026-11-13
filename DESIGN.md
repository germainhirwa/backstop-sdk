# Design notes

Why Backstop is shaped the way it is. Read this before changing the public API.

## The problem, stated precisely

An agent purchase can go wrong in three places, and each needs a different guard:

1. **Capture.** The user says "next Friday, under $400". The agent turns that into fields. If the fields are wrong, everything downstream is confidently wrong.
2. **Selection.** The agent builds a cart. It may pick the wrong date, size, seller or fare, or act when it was only asked a question.
3. **Execution.** The merchant confirms something other than what was in the cart: the fare refreshed, an item was substituted, a fee appeared.

Most guardrails cover only step 2. Backstop makes one comparison per step (`intent`, `check`, `commit`) and records all three.

A consequence worth being honest about: a deterministic check moves the residual risk to capture. If the structured request is wrong and the cart matches it, the check passes. That is why `lint` exists, why open lint questions hold a check at `ask`, and why an unacknowledged request sends a "not what I asked" claim to a person instead of denying it.

## Principles

**The check is code, not a model.** A model checking a model inherits the same failure modes and adds latency, cost and nondeterminism. A full check, including hashing and signing the record, takes about a millisecond locally. The same cart and request always give the same verdict, which is what makes a verdict something you can sign, dispute and insure.

**Rules are data.** A rule is `{ field, label, strength, test }`, plain JSON. No closures. This is the decision everything else rests on: rules can be hashed and signed, replayed against the delivered order at claim time, shown to a user, and evaluated by an SDK in another language without drift.

**Fail closed.** A required field missing from the cart is a block (`missing_field`), not a pass. An action outside the intent's `allow` list is blocked before any rule runs. Money in a different currency from the limit is a block, not a conversion.

**Two strengths, two outcomes.** `must` failures block and tell the agent how to fix the cart. `prefer` failures produce one specific question for the user. This replaces the blanket "confirm everything looks right" screen with a question only when there is something to decide.

**Write for two readers.** Every finding has a `message` for a person and a `fix` for the model. `verdict.forAgent` is meant to be returned verbatim as a tool result; it names the field and the correct value so the agent can repair the cart in one step.

**Nothing leaves the process.** No telemetry, no network calls in the core. Adoption shouldn't require a privacy review.

## Decisions and trade-offs

| Decision | Why | Cost |
| --- | --- | --- |
| Developer supplies structured `wants`; SDK doesn't extract it | Extraction needs a model; every agent already has one and its own schema | Capture quality depends on the agent. Mitigated by `lint`, `summary` + `acknowledge` |
| `lint` uses regex and a date resolver, not a model | Deterministic, free, replayable | English only; covers dates, budget, refundability, quantity, question-vs-order. It under-warns rather than over-warns |
| "next Friday" resolves to the Friday of next week and is flagged ambiguous when the upcoming Friday differs | People split on this phrase; the safe move is to ask | An extra question in a common case |
| Money is integer minor units | No float comparison errors at limits | `usd(362.5)` helper needed |
| Names match after normalizing case, accents, punctuation and `LAST/FIRST`; middle names may be omitted; edit distance ≤ 2 is called a typo and blocked | Mirrors what airlines accept and reject | Could block a legitimate short-name near-match; the message says exactly why |
| `maxOrders` defaults to 1, `maxAttempts` to 8 | Retries and loops are a real failure mode (duplicate bookings, flooding a reservation system) | Multi-order requests must opt in |
| Counters live in a pluggable `Store` | Works in one process with no setup | Multi-process deployments must supply a shared store |
| Ed25519 signatures via Web Crypto | Third parties verify with a public key; no shared secret; no dependency | Needs Node 20+ or a modern runtime |
| `commit()` re-runs the request's rules on the confirmation, and separately lists `changed` fields | Distinguishes "different but still what the user asked" from "now violates the request" | Caller must map confirmation fields |
| Claims are a pure function of the chain | Same record, same decision; cheap to audit | Real claims will need evidence the chain can't hold (photos, merchant statements): hence `review` |
| ESM only | One build, no dual-package hazards | CommonJS callers need Node 22+ `require(esm)` or dynamic import |

## The record

```
intent ──▶ ack? ──▶ verdict ──▶ resolution? ──▶ verdict? ──▶ order ──▶ claim?
```

Each envelope: `{ v, type, id, at, prev, body, hash, sig, keyId }`. `hash` is SHA-256 over canonical JSON (sorted keys) of everything before it; `prev` is the previous envelope's hash; `sig` is Ed25519 over `hash`. Blocked attempts are not chained (they are counted in the store), so a chain reads as the path that led to the order.

What the record proves: this request text and these rules existed before this cart was checked; this cart passed (or the user approved a named exception); this is what the merchant confirmed. What it does not prove: that the user really typed the request (the agent company signs it, not the user). `acknowledge` narrows that gap; user-held keys or network-level intent mandates would close it, and the envelope format leaves room for an additional signature.

## The guarantee seam

`GuaranteeProvider.issue({ intentHash, cartHash, cart, pack })` is called once per passed check. The core has no opinion about who stands behind it. `sandbox` returns an illustrative fee and coverage so integrations can be built and demoed end to end. Pricing a real guarantee needs loss data by agent, category and amount, which is exactly what `backstop eval` and production verdict logs produce.

## The test suite as a product surface

`backstop eval` exists because the first question any agent team asks is "how often does ours get it wrong?" and almost none can answer. Design choices:

- **Offline and deterministic.** Offers are provided, like a results page; there is no browsing. It measures judgment (which offer, or none), not navigation.
- **One trap per task**, so a failure names its cause.
- **Scored by the same rule engine against hand-written ground truth.** An oracle test in this repo proves every task is solvable.
- **A non-circular catch rate.** When the agent returns its own captured intent, the report shows how many wrong purchases a check against *that* intent stops. This is the number that matters in production.

It is a 50-task synthetic suite. It is a diagnostic, not a benchmark to quote as a field error rate.

## Two languages, one behavior

The TypeScript SDK is the reference. `scripts/fixtures.ts` writes `conformance/fixtures.json` from it: 720 date phrases across time zones, name comparisons, formatting, lint warnings, 106 rule evaluations, 102 verdicts, a signed record and 7 claim decisions. The Python SDK must reproduce every one exactly, including the sentences shown to users and agents, and its test suite also seals a record in Python and verifies it with the TypeScript code. This works because rules, carts and envelopes are data, and hashes are taken over canonical JSON (sorted keys, JavaScript number formatting). The 50 eval tasks live in one file both SDKs read. Building the Python port this way found a bug in the reference (`2026-02-30` was accepted as a date), which is the point of having it.

## Not built yet

- Hotel, rideshare, subscription and B2B procurement packs.
- Adapters that read intent mandates from payment-network and agent-payment protocols into `wants`.
- Lint beyond English; lint for passenger counts and party sizes.
- A hosted verification endpoint and a live guarantee provider.
