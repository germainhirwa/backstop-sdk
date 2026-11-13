# Backstop for Python

Check every AI-agent purchase against what the user actually asked for, before money moves.

This is the Python SDK. It makes the same three comparisons as the [TypeScript SDK](../README.md), gives the same verdicts word for word, and writes the same signed record, so a purchase checked in one language can be verified or claimed against in the other.

| Step | Compares | Catches |
| --- | --- | --- |
| `intent()` | the user's words ↔ the structured request | "next Friday" resolved a week late, a budget the agent forgot, a question treated as an order |
| `check()` | the request ↔ the cart | wrong date, price, size, seller, name, quantity; actions the user never authorized; duplicate orders |
| `commit()` | the cart ↔ the merchant's confirmation | fares that changed at payment, substitutions, anything that drifted |

- **Local and fast.** Pure code: no model call, no network, well under a millisecond per check. Nothing about your users leaves your process.
- **No required dependencies.** Python 3.10+. Signing records needs `cryptography`, as an optional extra.
- **Fails closed.** A field the cart doesn't show can't be verified, so it doesn't pass.
- **Typed.** Ships `py.typed`.

> **Status: 0.1 preview.** The guarantee (someone paying when a passed order still goes wrong) is a `sandbox` simulation in this release; it is not backed by funds. Not yet on PyPI: install from GitHub.

## Install

```sh
pip install "backstop-sdk[sign] @ git+https://github.com/germainhirwa/backstop-sdk#subdirectory=python"
backstop demo     # three publicly reported agent mistakes, replayed through the check
```

Drop `[sign]` if you don't need signed records; they are still hash-linked.

## Quickstart

```python
from backstop_sdk import Backstop, flight, prefer, usd

backstop = Backstop()

# 1. When the user asks: capture it, in their words and as fields.
intent = backstop.intent(
    user="user_123",
    request="Book me JFK to Austin on Nov 20, morning, under $400, refundable. Aisle if you can.",
    time_zone="America/New_York",
    wants=flight.wants(
        from_="JFK", to="AUS", date="2026-11-20", departs=("06:00", "12:00"),
        max_price=usd(400), refundable=True, passenger="Maya Okafor",
        seat=prefer("aisle"),          # a preference: asks instead of blocking
    ),
)
intent.summary     # "I'll book a flight: origin JFK, destination AUS, date Fri, Nov 20, …"
intent.questions   # anything the user's words and the fields disagree on

# 2. Right before paying: check the cart.
verdict = backstop.check(intent, flight.cart(
    from_="JFK", to="AUS", date="2026-11-27", departs="07:05",
    price=usd(362), refundable=True, passenger="Maya Okafor", seat="aisle",
))

if verdict.status == "block":
    return verdict.for_agent
    # "Backstop blocked this purchase. Do not check out.
    #  - Date is Fri, Nov 27; the user asked for Fri, Nov 20 (+7 days). That is exactly 1 week off, …
    #  Fix the cart and check it again."
if verdict.status == "ask":
    verdict = backstop.resolve(verdict, approved=ask_user(verdict.question))

# 3. Right after the merchant confirms: compare the confirmation.
if verdict.status == "pass":
    confirmation = airline.book(...)
    commit = backstop.commit(verdict, id=confirmation.id, amount=usd(confirmation.total))
    if commit.status == "drift":
        ...  # the merchant confirmed something else: cancel now, while it's free
```

## Or wrap the tool

```python
@backstop.protect(
    intent=lambda offer: current_intent(),
    cart=lambda offer: flight.cart(offer),
    order=lambda result, offer: {"id": result.confirmation, "amount": usd(result.total)},
    on_ask=lambda verdict: ask_user(verdict.question),      # optional
)
def book_flight(offer):          # works on async functions too
    return airline.book(offer)
```

`book_flight` now can't run on a cart that doesn't match. A mismatch raises `BackstopBlocked`, whose message is written for the model: return it as the tool result and the agent corrects itself.

## Test your agent in five minutes

Fifty offline purchase tasks, each with one trap (relative dates, time zones, budgets, sizes, sellers, names, questions that aren't orders).

```python
# my_agent.py
def agent(task):     # {"request", "now", "timeZone", "user", "offers"}
    cart = my_real_agent(task["request"], task["offers"])
    return {"cart": cart}        # or {"ask": "..."} or {"decline": "..."}
```

```sh
backstop eval my_agent.py
backstop eval cheapest           # a reference agent: 43 of 50 wrong, $5,450.06 at risk
```

Return `{"cart": cart, "intent": {...}}` with what your agent captured to see how many of its wrong purchases Backstop stops before payment. From code: `run_eval(agent)` and `format_report(report)` in `backstop_sdk.eval`.

## Your own rules

Packs cover flights, retail and restaurants. Anything else is plain rules:

```python
from backstop_sdk import must, prefers

wants = {"allow": ["hotel.book"], "rules": [
    must.on("item.checkIn", "2026-11-20", "Check-in"),
    must.costs_at_most(usd(900), "Total"),
    must.is_("item.freeCancellation", True, "Free cancellation"),
    prefers.at_least("item.rating", 4.5, "Rating"),
]}
cart = {"action": "hotel.book", "amount": usd(840), "item": {"checkIn": "2026-11-20", "freeCancellation": True, "rating": 4.3}}
```

Use `nothing()` when the user only asked a question: it authorizes no purchase at all, so any booking or cancellation is blocked.

## The record and claims

```python
from backstop_sdk import generate_keys

backstop = Backstop(keys=generate_keys(), guarantee="sandbox")
...
backstop.verify(commit.chain)                        # ChainCheck(ok=True, signed=True, problems=[])
backstop.claim(commit.chain, "not_what_i_asked")     # decided by replaying the record
```

Every step is an envelope in a hash-linked chain (`intent → ack → verdict → resolution → order`). Envelopes, carts, rules and money are plain dicts with the same JSON as the TypeScript SDK; store the chain as JSON.

## What live testing changed

Blind tests with real agents on real sites (Google Flights, Amazon, OpenTable, Foot Locker) shaped three behaviors:

- **Text as sites write it.** "Men's 10 (D - Medium)" and "Black/Medium Ash/Pure Platinum" are matched by words. Extra words ask the user one question; wrong words block.
- **No editing past a block.** Pass the offer's page as `url` (or `ref`) in the cart. If the agent sends the same offer again with a flagged field changed, the user is asked, with both values shown. Block messages never tell the agent what to type.
- **Questions asked once.** If your agent asked the user something and they answered in your chat, record it: `backstop.acknowledge(intent, method="chat", answers=[{"question": q, "answer": "Nov 20"}])`. Over MCP, pass `userReply`.

## Also here

- `backstop mcp` (or `python -m backstop_sdk mcp`): an MCP server with four tools, for agents that should call the check themselves.
- `resolve_date("next Friday", "America/New_York")`: relative dates in the user's time zone, flagging ambiguous ones.
- `Policy(ask_above=usd(1000), require_amount_limit=True)`, a pluggable `store` for attempt and order counters, and `now=` to control the clock in tests.

## Differences from TypeScript

Names are snake_case (`time_zone`, `max_price`, `for_agent`, `from_` because `from` is reserved), calls are synchronous, and `protect` is a decorator. Data crossing the wire keeps the TypeScript camelCase keys. `tests/test_conformance.py` holds this SDK to the reference: 720 date phrases, 106 rule evaluations, 102 verdicts, a signed record and 7 claim decisions must match exactly.

## License

MIT
