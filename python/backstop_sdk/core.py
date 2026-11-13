"""Backstop: three comparisons around every agent purchase.

    words  ↔ intent   intent()   Did we capture what the person said?
    intent ↔ cart     check()    Is the agent about to buy what was asked?
    cart   ↔ order    commit()   Did the merchant charge what was checked?

Each step is sealed into a signed record. claim() replays that record later.
"""
from __future__ import annotations

import functools
import inspect
from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
from typing import Any, Callable, Optional, Protocol, Union

from .intent import action_words, build_intent_body, summarize
from .primitives import canonical, format_date, format_money, is_money, js_round, sha256, to_iso
from .record import ChainCheck, KeyPair, Signer, seal, verify_chain
from .rules import Cart, Finding, evaluate

# ───────────────────────────── Types ─────────────────────────────


@dataclass
class Intent:
    id: str
    body: dict
    chain: list  # The record so far. Store it; you need it for commit() and claim().
    warnings: list  # Mismatches between the user's words and the structured fields.
    questions: list  # Questions worth asking the user before acting (from warnings).
    summary: str  # One line to show the user: "I'll book a flight: origin JFK, …".
    acknowledged: bool  # True once the user has confirmed the summary.


@dataclass
class Verdict:
    id: str
    status: str  # "pass" | "block" | "ask"
    intent: Intent
    cart: Cart
    findings: list  # Every rule, passed or failed, in order.
    reasons: list  # Why it was blocked. Empty unless status is "block".
    asks: list  # [{"key", "question"}]. Empty unless status is "ask".
    question: Optional[str]  # All questions as one message for the user, or None.
    for_agent: str  # Feed this back to the model as the tool result.
    guarantee: Optional[dict]
    chain: list  # Intent chain plus this verdict.

    @property
    def passed(self) -> bool:
        return self.status == "pass"


@dataclass
class Commit:
    status: str  # "confirmed" | "drift". Drift: the merchant confirmed something the user did not ask for.
    violations: list
    changed: list  # Fields that differ from the checked cart, whether or not they break a rule.
    for_agent: str
    chain: list


@dataclass
class ClaimDecision:
    status: str  # "approved" | "denied" | "review"
    basis: str
    explanation: str
    violations: list
    payable_up_to: Optional[dict]
    record: ChainCheck

    def to_dict(self) -> dict:
        return {"status": self.status, "basis": self.basis, "explanation": self.explanation, "violations": [v.to_dict() for v in self.violations], "payableUpTo": self.payable_up_to, "record": self.record.to_dict()}


@dataclass
class Policy:
    ask_above: Optional[dict] = None  # Ask before any purchase above this amount, even if it matches.
    require_amount_limit: bool = False  # Ask when the intent has no price limit.
    ask_on_warnings: bool = True  # Ask when lint found a mismatch between the user's words and the fields.


class Store(Protocol):
    """State per intent: {"attempts": int, "orders": int, "seen": {offer ref: {field: first description}}}.
    Swap in Redis or your database across processes."""

    def get(self, key: str) -> Optional[dict]: ...
    def set(self, key: str, value: dict) -> None: ...


class MemoryStore:
    def __init__(self) -> None:
        self._m: dict = {}

    def get(self, key: str) -> Optional[dict]:
        return self._m.get(key)

    def set(self, key: str, value: dict) -> None:
        self._m[key] = value


class BackstopError(Exception):
    pass


class BackstopBlocked(BackstopError):
    """Raised by protect() when the cart doesn't match the request. str(e) is written for the model."""

    def __init__(self, verdict: Verdict):
        super().__init__(verdict.for_agent)
        self.verdict = verdict


class BackstopNeedsUser(BackstopError):
    """Raised by protect() when the user has to answer a question first."""

    def __init__(self, verdict: Verdict):
        super().__init__(verdict.for_agent)
        self.verdict = verdict


# ───────────────────────────── Sandbox guarantee ─────────────────────────────


def sandbox_guarantee(req: dict) -> Optional[dict]:
    """Illustrative pricing for development. Real terms come from the guarantee provider."""
    currency, minor = req["cart"]["amount"]["currency"], req["cart"]["amount"]["minor"]
    return {
        "id": f"gtee_sandbox_{req['cartHash'][:12]}",
        "status": "sandbox",
        "fee": {"currency": currency, "minor": max(75, js_round(minor * 0.003))},
        "coverage": {"currency": currency, "minor": -(-(minor + 25_000) // 5_000) * 5_000},
        "terms": "Sandbox simulation. Covers the cost to correct an order that differs from the signed request. Not backed by funds.",
    }


# ───────────────────────────── Backstop ─────────────────────────────


def _gate(code: str, expected: str, actual: str, message: str, fix: str) -> Finding:
    return Finding(field="action", label="Authorized action", strength="must", ok=False, code=code, expected=expected, actual=actual, message=message, fix=fix)


_INTENT_KEYS = {"timeZone": "time_zone", "maxOrders": "max_orders", "maxAttempts": "max_attempts", "expiresIn": "expires_in"}


class Backstop:
    """
    keys       Ed25519 keys from generate_keys(). Without them records are hashed but unsigned.
    guarantee  "sandbox" simulates a guarantee on every pass. Pass a callable(request) -> dict | None for a real one.
    policy     Policy(...) or a dict with the same fields.
    store      Per-intent counters. Defaults to memory.
    now        Override the clock (tests, replays): a callable returning an aware datetime.
    """

    def __init__(self, keys: Optional[KeyPair] = None, guarantee: Union[None, str, Callable[[dict], Optional[dict]]] = None,
                 policy: Union[None, Policy, dict] = None, store: Optional[Store] = None, now: Optional[Callable[[], datetime]] = None):
        if isinstance(keys, dict):
            keys = KeyPair.from_dict(keys)
        self._signer = Signer(keys) if keys else None
        self.public_key: Optional[str] = keys.public_key if keys else None
        self._provider = sandbox_guarantee if guarantee == "sandbox" else guarantee
        self._store: Store = store or MemoryStore()
        if isinstance(policy, dict):
            policy = Policy(ask_above=policy.get("ask_above", policy.get("askAbove")), require_amount_limit=policy.get("require_amount_limit", policy.get("requireAmountLimit", False)),
                            ask_on_warnings=policy.get("ask_on_warnings", policy.get("askOnWarnings", True)))
        self._policy = policy or Policy()
        self._clock = now or (lambda: datetime.now(timezone.utc))

    # Step 1
    def intent(self, user: str, request: str, wants: dict, time_zone: str = "UTC", also: Optional[list] = None, max_orders: int = 1, max_attempts: int = 8,
               expires_in: int = 86_400, clarifications: Optional[list] = None, now: Optional[datetime] = None, **camel: Any) -> Intent:
        """Capture what the user asked for, and lint it against their own words."""
        kw = dict(user=user, request=request, wants=wants, time_zone=time_zone, also=also, max_orders=max_orders, max_attempts=max_attempts, expires_in=expires_in, clarifications=clarifications)
        for k, v in camel.items():
            if k not in _INTENT_KEYS:
                raise TypeError(f"intent() got an unexpected keyword argument {k!r}")
            kw[_INTENT_KEYS[k]] = v
        now = now or self._clock()
        body = build_intent_body(now=now, **kw)
        return self._to_intent([seal("intent", body, signer=self._signer, at=now)])

    def acknowledge(self, intent: Intent, method: str = "confirmed", answers: Optional[list] = None) -> Intent:
        """Record that the user confirmed the summary, or answered the intent's questions in your app's chat.

        Call it whenever the user replies to a question your agent asked, so check() doesn't ask again.
        answers: [{"question": ..., "answer": ...}]. Clears lint questions and strengthens the record.
        """
        body = {"intentId": intent.id, "summary": intent.summary, "method": method}
        if answers:
            body["answers"] = list(answers)
        env = seal("ack", body, prev=intent.chain[-1], signer=self._signer, at=self._clock())
        return self._to_intent([*intent.chain, env])

    def restore(self, chain: list) -> Intent:
        """Rebuild an Intent from a stored chain."""
        if not chain or chain[0].get("type") != "intent":
            raise BackstopError("restore(): chain must start with an intent")
        return self._to_intent([e for e in chain if e["type"] in ("intent", "ack")])

    def _to_intent(self, chain: list) -> Intent:
        env = chain[0]
        acked = any(e["type"] == "ack" for e in chain)
        warnings = env["body"]["warnings"]
        return Intent(id=env["id"], body=env["body"], chain=chain, warnings=warnings, questions=[] if acked else [w["question"] for w in warnings if w.get("question")],
                      summary=summarize(env["body"]), acknowledged=acked)

    # Step 2
    def check(self, intent: Intent, cart: Cart, waive: Optional[list] = None) -> Verdict:
        """Compare the cart with the intent. Call this right before you pay."""
        return self._run_check(intent, cart, list(waive or []), True)

    def _run_check(self, intent: Intent, cart: Cart, waive: list, count_attempt: bool) -> Verdict:
        if not isinstance(cart, dict) or not isinstance(cart.get("action"), str) or not is_money(cart.get("amount")) or not isinstance(cart.get("item"), dict):
            raise BackstopError("check(): cart must have { action, amount: { currency, minor }, item }")
        body = intent.body
        now = self._clock()
        state = dict(self._store.get(intent.id) or {"attempts": 0, "orders": 0})
        if count_attempt:
            state["attempts"] += 1
            self._store.set(intent.id, state)

        findings: list = []
        asks: list = []
        doing = action_words(cart["action"])
        allowed = " or ".join(action_words(a) for a in body["allow"])

        if cart["action"] not in body["allow"]:
            if not body["allow"]:
                findings.append(_gate("action_not_authorized", "no purchase", doing, f"The user asked a question only. The agent is about to {doing}.", f"Do not {doing}. Answer the user's question instead."))
            else:
                findings.append(_gate("action_not_authorized", allowed, doing, f"The user asked to {allowed}. The agent is about to {doing}.", f"Do not {doing}. The user only asked to {allowed}."))
        elif state["orders"] >= body["maxOrders"]:
            findings.append(_gate("duplicate_order", f"{body['maxOrders']} order", f"{state['orders']} already placed", "This request already produced an order. A second purchase would be a duplicate.", "Stop. This request is already fulfilled. Do not place another order."))
        elif state["attempts"] > body["maxAttempts"]:
            findings.append(_gate("too_many_attempts", f"{body['maxAttempts']} attempts", f"{state['attempts']}", f"The agent has tried {state['attempts']} carts for this request.", "Stop retrying and ask the user how to proceed."))
        else:
            seen = None
            if cart.get("ref"):
                seen = state.setdefault("seen", {}).setdefault(cart["ref"], {})
            edited: list = []
            for rule in body["rules"]:
                f = evaluate(rule, cart)
                findings.append(f)
                if not f.ok and f.strength == "prefer":
                    asks.append({"key": f.field, "question": f"{f.label}: this option has {f.actual}, and you asked for {f.expected}. Go ahead anyway?"})
                if seen is None:
                    continue
                first = seen.get(f.field)
                if first is not None and first != f.actual:
                    low = f.label.lower()
                    edited.append(Finding(field=f.field, label=f.label, strength="prefer", ok=False, code="cart_edited", expected=first, actual=f.actual,
                                          message=f"The agent first described this option's {low} as {first}, then changed it to {f.actual} after the check flagged it.",
                                          fix="Ask the user. Do not change how the cart describes the merchant's option."))
                elif first is None and not f.ok and f.code != "missing_field" and rule["test"]["op"] != "name":
                    seen[f.field] = f.actual
            findings.extend(edited)
            if seen is not None:
                self._store.set(intent.id, state)
            partial = [f for f in findings if f.code == "partial_match"]
            if len(partial) == 1:
                p = partial[0]
                asks.append({"key": p.field, "question": f"{p.label}: this option is {p.actual}, and you asked for {p.expected}. Is that what you want?"})
            if len(partial) > 1:
                parts = "; ".join(f"{f.label.lower()} is {f.actual} (you asked for {f.expected})" for f in partial)
                asks.append({"key": "words:" + ",".join(f.field for f in partial), "question": f"This option's wording differs from what you asked: {parts}. Is that what you want?"})
            if edited:
                what = "; ".join(f"{e.label.lower()} from {e.expected} to {e.actual}" for e in edited)
                asks.append({"key": "edited:" + ",".join(e.field for e in edited), "question": f"After the check flagged this option, your agent changed how it described it: {what}. Go ahead only if the merchant's page shows the new {'values' if len(edited) > 1 else 'value'}. Is it right?"})
            if to_iso(now) > body["expiresAt"]:
                asks.append({"key": "intent_expired", "question": f"You asked for this on {format_date(body['createdAt'][:10])}. Do you still want it?"})
            if self._policy.ask_on_warnings and not intent.acknowledged:
                asks.extend({"key": f"warning:{w['code']}", "question": w["question"]} for w in body["warnings"] if w.get("question"))
            capped = any(r["test"]["op"] == "money_lte" and r["field"] == "amount" for r in body["rules"])
            if self._policy.require_amount_limit and not capped:
                asks.append({"key": "policy:requireAmountLimit", "question": f"You didn't set a budget. Is {format_money(cart['amount'])} okay?"})
            above = self._policy.ask_above
            if above and above["currency"] == cart["amount"]["currency"] and cart["amount"]["minor"] > above["minor"]:
                asks.append({"key": "policy:askAbove", "question": f"This costs {format_money(cart['amount'])}. Go ahead?"})

        cart_hash = sha256(canonical(cart))
        for key in (state.get("approved") or {}).get(cart_hash, []):
            if key not in waive:
                waive = [*waive, key]
        reasons = [f for f in findings if _is_violation(f)]
        open_ = [a for a in asks if a["key"] not in waive]
        status = "block" if reasons else "ask" if open_ else "pass"

        guarantee = None
        if status == "pass" and self._provider:
            guarantee = self._provider({"intentId": intent.id, "intentHash": intent.chain[0]["hash"], "cartHash": cart_hash, "cart": cart, "pack": body["pack"]})

        sealed = {
            "intentId": intent.id, "cart": cart, "status": status, "waived": waive, "guarantee": guarantee,
            "findings": [{"field": f.field, "code": f.code, "ok": f.ok, "strength": f.strength, "expected": f.expected, "actual": f.actual} for f in findings],
        }
        env = seal("verdict", sealed, prev=intent.chain[-1], signer=self._signer, at=now)
        question = " ".join(a["question"] for a in open_) if status == "ask" else None
        if status == "pass":
            for_agent = "Backstop: cleared. Proceed to checkout with exactly this cart."
        elif status == "block":
            for_agent = _block_message(reasons)
        else:
            for_agent = f'Backstop: do not pay yet. Ask the user: "{question}"'
        return Verdict(id=env["id"], status=status, intent=intent, cart=cart, findings=findings, reasons=reasons if status == "block" else [], asks=open_ if status == "ask" else [],
                       question=question, for_agent=for_agent, guarantee=guarantee, chain=[*intent.chain, env])

    def resolve(self, verdict: Verdict, approved: bool, by: str = "user") -> Verdict:
        """After an "ask" verdict: record the user's answer. Yes re-checks and passes; no blocks."""
        if verdict.status != "ask":
            raise BackstopError('resolve(): only an "ask" verdict needs resolving')
        res = seal("resolution", {"verdictId": verdict.id, "question": verdict.question, "approved": bool(approved), "by": by}, prev=verdict.chain[-1], signer=self._signer, at=self._clock())
        intent = replace(verdict.intent, chain=[*verdict.chain, res])
        if approved:
            # Remember the yes for this exact cart, so an agent that checks the same cart again isn't asked again.
            state = dict(self._store.get(verdict.intent.id) or {"attempts": 0, "orders": 0})
            approvals = dict(state.get("approved") or {})
            h = sha256(canonical(verdict.cart))
            approvals[h] = list(dict.fromkeys([*approvals.get(h, []), *(a["key"] for a in verdict.asks)]))
            state["approved"] = approvals
            self._store.set(verdict.intent.id, state)
            return self._run_check(intent, verdict.cart, [a["key"] for a in verdict.asks], False)
        return replace(
            verdict, status="block", asks=[], question=None, guarantee=None, chain=intent.chain,
            reasons=[_gate("mismatch", "user approval", "declined", "The user declined this option.", "Offer the user a different option.")],
            for_agent="Backstop: the user declined this option. Do not check out. Offer a different option.",
        )

    # Step 3
    def commit(self, verdict: Verdict, order: Optional[dict] = None, *, id: Optional[str] = None, amount: Optional[dict] = None, merchant: Optional[str] = None, item: Optional[dict] = None) -> Commit:
        """Compare the merchant's confirmation with what was checked. Call it as soon as you have the confirmation.

        id: the merchant's confirmation number. amount: what was actually charged.
        item: any item fields the confirmation shows; unlisted fields are assumed unchanged.
        """
        if verdict.status != "pass":
            raise BackstopError(f'commit(): the verdict is "{verdict.status}". Only a passed check can be committed.')
        order = _order(order, id=id, amount=amount, merchant=merchant, item=item)
        delivered = _merge_order(verdict.cart, order)
        violations = [f for f in (evaluate(r, delivered) for r in verdict.intent.body["rules"]) if _is_violation(f)]
        changed = _diff_cart(verdict.cart, delivered)
        if delivered["amount"]["minor"] > verdict.cart["amount"]["minor"] and not any(v.field == "amount" for v in violations) and "amount" not in changed:
            changed.append("amount")
        status = "drift" if violations else "confirmed"
        state = dict(self._store.get(verdict.intent.id) or {"attempts": 0, "orders": 0})
        state["orders"] += 1
        self._store.set(verdict.intent.id, state)
        env = seal("order", {"verdictId": verdict.id, "orderId": order.get("id"), "delivered": delivered, "status": status, "changed": changed,
                             "violations": [{"field": v.field, "code": v.code, "expected": v.expected, "actual": v.actual} for v in violations]},
                   prev=verdict.chain[-1], signer=self._signer, at=self._clock())
        if status == "confirmed":
            for_agent = "Backstop: order confirmed and matches the request."
        else:
            lines = "\n".join(f"- {v.message}" for v in violations)
            for_agent = f"Backstop: the confirmed order differs from the request.\n{lines}\nCancel or correct it now, while changes are free, and tell the user."
        return Commit(status=status, violations=violations, changed=changed, for_agent=for_agent, chain=[*verdict.chain, env])

    def claim(self, chain: list, reason: str, delivered: Optional[dict] = None, public_key: Optional[str] = None) -> ClaimDecision:
        """Decide a claim by replaying the record. Deterministic: the same chain always gives the same answer.

        reason: "not_what_i_asked" | "changed_mind" | "merchant_fault".
        delivered: what actually arrived or was ticketed, if it differs from the recorded order.
        """
        record = verify_chain(chain, public_key or self.public_key)

        def decide(status: str, basis: str, explanation: str, violations: Optional[list] = None, payable: Optional[dict] = None) -> ClaimDecision:
            return ClaimDecision(status, basis, explanation, violations or [], payable, record)

        intent_env = next((e for e in chain if e["type"] == "intent"), None)
        if not record.ok or not intent_env:
            return decide("review", "record_invalid", f"The record could not be verified: {'; '.join(record.problems) or 'no intent found'}.")
        passes = [e for e in chain if e["type"] == "verdict" and e["body"]["status"] == "pass"]
        if not passes:
            return decide("denied", "never_cleared", "No check ever passed for this request, so the purchase was made outside the guarantee.")
        verdict_env = passes[-1]
        if reason == "merchant_fault":
            return decide("denied", "merchant_responsibility", "A cancellation, delay or defect is the merchant's or carrier's responsibility. This guarantee covers agent mistakes.")

        orders = [e for e in chain if e["type"] == "order"]
        subject = _merge_order(orders[-1]["body"]["delivered"] if orders else verdict_env["body"]["cart"], _order(delivered))
        violations = [f for f in (evaluate(r, subject) for r in intent_env["body"]["rules"]) if _is_violation(f)]
        cover = (verdict_env["body"].get("guarantee") or {}).get("coverage")
        if violations:
            return decide("approved", "delivered_differs_from_request", "What was delivered differs from the signed request.", violations, cover)
        if reason == "changed_mind":
            return decide("denied", "matches_request", "The order matches every requirement in the signed request. A change of plans is not an agent mistake.")

        acked = any(e["type"] == "ack" for e in chain)
        resolved = any(e["type"] == "resolution" and e["body"].get("approved") for e in chain)
        if any(w.get("question") for w in intent_env["body"]["warnings"]) and not acked and not resolved:
            return decide("review", "intent_capture_unconfirmed", "The order matches the structured request, but that request disagreed with the user's own words and was never confirmed with them. A person should compare the two.", [], cover)
        if not acked:
            return decide("review", "summary_not_acknowledged", "The order matches the structured request, but the user never confirmed that summary. A person should compare it with the original words.", [], cover)
        return decide("denied", "matches_acknowledged_request", "The order matches the request the user confirmed.")

    def verify(self, chain: list, public_key: Optional[str] = None) -> ChainCheck:
        """Verify a record's hashes, links and signatures."""
        return verify_chain(chain, public_key or self.public_key)

    def protect(self, *, intent: Callable[..., Any], cart: Callable[..., Any], order: Optional[Callable[..., dict]] = None, on_ask: Optional[Callable[[Verdict], Any]] = None,
                on_drift: Optional[Callable[[Commit, Any], Any]] = None, on_verdict: Optional[Callable[[Verdict], None]] = None) -> Callable:
        """Decorator: wrap a purchase function so it can't run on a mismatched cart.

            @backstop.protect(intent=lambda offer: current_intent, cart=lambda offer: flight.cart(offer))
            def book_flight(offer): ...

        intent(*args)      the intent this call belongs to
        cart(*args)        what the function is about to buy
        order(result, *a)  read the merchant's confirmation out of the result, to catch drift
        on_ask(verdict)    ask the user; return True to proceed. Without it an "ask" raises BackstopNeedsUser
        on_drift(commit, result), on_verdict(verdict)  callbacks

        Works on plain and async functions. In async functions the callbacks may be coroutines too.
        """

        def before(args: tuple, kwargs: dict, it: Intent, c: Cart) -> Verdict:
            v = self.check(it, c)
            if on_verdict:
                on_verdict(v)
            return v

        def answered(v: Verdict, approved: Any) -> Verdict:
            v = self.resolve(v, bool(approved))
            if on_verdict:
                on_verdict(v)
            return v

        def after(v: Verdict, result: Any, args: tuple, kwargs: dict) -> Commit:
            return self.commit(v, order(result, *args, **kwargs) if order else None)

        def decorate(fn: Callable) -> Callable:
            if inspect.iscoroutinefunction(fn):
                async def aw(x: Any) -> Any:
                    return await x if inspect.isawaitable(x) else x

                @functools.wraps(fn)
                async def awrapper(*args: Any, **kwargs: Any) -> Any:
                    v = before(args, kwargs, await aw(intent(*args, **kwargs)), await aw(cart(*args, **kwargs)))
                    if v.status == "ask":
                        if not on_ask:
                            raise BackstopNeedsUser(v)
                        v = answered(v, await aw(on_ask(v)))
                    if v.status != "pass":
                        raise BackstopBlocked(v)
                    result = await fn(*args, **kwargs)
                    c = after(v, result, args, kwargs)
                    if c.status == "drift" and on_drift:
                        await aw(on_drift(c, result))
                    return result

                return awrapper

            @functools.wraps(fn)
            def wrapper(*args: Any, **kwargs: Any) -> Any:
                v = before(args, kwargs, intent(*args, **kwargs), cart(*args, **kwargs))
                if v.status == "ask":
                    if not on_ask:
                        raise BackstopNeedsUser(v)
                    v = answered(v, on_ask(v))
                if v.status != "pass":
                    raise BackstopBlocked(v)
                result = fn(*args, **kwargs)
                c = after(v, result, args, kwargs)
                if c.status == "drift" and on_drift:
                    on_drift(c, result)
                return result

            return wrapper

        return decorate


def _is_violation(f: Finding) -> bool:
    """A failed requirement that blocks. A partial match is a question for the user instead."""
    return not f.ok and f.strength == "must" and f.code != "partial_match"


def _block_message(reasons: list) -> str:
    lines = ["Backstop blocked this purchase. Do not check out.", *(f"- {r.message} {r.fix or ''}".strip() for r in reasons)]
    missing = [r for r in reasons if r.code == "missing_field"]
    if len(missing) >= 3:
        lines.append(f"The cart is missing {len(missing)} fields this request depends on ({', '.join(m.field for m in missing)}). Check that each one is in the cart where checkout expects it.")
    lines.append("Choose another option or ask the user. Don't change how the cart describes the merchant's option to make it pass.")
    return "\n".join(lines)


def _order(order: Optional[dict], **kw: Any) -> dict:
    out = {k: v for k, v in (order or {}).items() if v is not None}
    if "orderId" in out:
        out.setdefault("id", out.pop("orderId"))
    out.update({k: v for k, v in kw.items() if v is not None})
    return out


def _merge_order(cart: Cart, order: dict) -> Cart:
    out = {**cart, "amount": order.get("amount") or cart["amount"], "item": {**cart["item"], **(order.get("item") or {})}}
    merchant = order.get("merchant") or cart.get("merchant")
    if merchant is not None:
        out["merchant"] = merchant
    return out


def _diff_cart(a: Cart, b: Cart) -> list:
    out = []
    if canonical(a["amount"]) != canonical(b["amount"]):
        out.append("amount")
    if a.get("merchant") != b.get("merchant"):
        out.append("merchant")
    for k in dict.fromkeys([*a["item"], *b["item"]]):
        if canonical(a["item"].get(k)) != canonical(b["item"].get(k)):
            out.append(f"item.{k}")
    return out
