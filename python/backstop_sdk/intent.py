"""Intent capture.

Once a cart is checked against a structured intent, the remaining risk moves
upstream: did the structured intent capture what the person actually said?
`lint()` is the cheap guard for that. It re-reads the user's own words and
compares them with the fields, in the user's time zone, with no model call.
"""
from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from typing import Optional
from zoneinfo import ZoneInfo

from .primitives import format_date, format_money, from_iso, js_num, js_round, resolve_date, to_iso
from .rules import describe

IntentBody = dict
Warning = dict  # {"code", "message", "question"?}

_I = re.IGNORECASE
_BUDGET = re.compile(r"(?:under|below|less than|max(?:imum)?(?: of)?|up to|no more than|at most|budget(?: is| of)?|cap(?:ped)? at|within)\s*\$?\s*([\d,]+(?:\.\d{1,2})?)\s*(k\b)?", _I)
_DOLLARS = re.compile(r"\$\s*([\d,]+(?:\.\d{1,2})?)")
_REFUNDABLE = re.compile(r"\b(refundable|free cancell?ation|cancel(?:lable)? for free|flexible (?:fare|ticket|rate))\b", _I)
_NON_REFUNDABLE = re.compile(r"\bnon[- ]?refundable\b", _I)
_BUY_VERB = re.compile(r"\b(book|buy|order|purchase|reserve|get me|grab|sign me up|go ahead|rebook|pay for|cancel (?:it|my|the|that)|renew|subscribe)\b", _I)
_QUESTION = re.compile(r"\?|^\s*(what|when|where|which|who|how|is|are|do|does|can you tell|could you tell|any)\b", _I)
_QTY = re.compile(r"\b(\d{1,3}|one|two|three|four|five|six|a pair of|a couple of)\s+(?:x\s+)?(?:packs?|boxes|pairs?|bottles|units|sets|copies|of them|of these)\b", _I)
_QTY_WORDS = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "a pair of": 1, "a couple of": 2}
_DATE_WORDS = re.compile(r"\b(date|day|week|friday|monday|tuesday|wednesday|thursday|saturday|sunday)\b")
_REFUND_FIELD = re.compile(r"refund|cancel", _I)


def _num(s: str) -> float:
    return float(s.replace(",", ""))


def _budget_in(text: str) -> Optional[float]:
    m = _BUDGET.search(text)
    if m:
        return _num(m.group(1)) * (1000 if m.group(2) else 1)
    found = _DOLLARS.findall(text)
    return _num(found[0]) if len(found) == 1 else None


def lint(body: IntentBody) -> list:
    """Compare the user's words with the structured fields. Pure and deterministic."""
    out: list = []
    text = body["request"]
    rules = body["rules"]
    buying = len(body["allow"]) > 0
    settled = " ".join(f"{c['question']} {c['answer']}" for c in body.get("clarifications", [])).lower()

    # 1. Dates: resolve the phrase the way the user meant it, in their zone.
    date_rule = next((r for r in rules if r["test"]["op"] == "date"), None)
    said = resolve_date(text, body["timeZone"], from_iso(body["createdAt"]))
    if said and date_rule:
        want = date_rule["test"]["value"]
        date_settled = bool(_DATE_WORDS.search(settled))
        if want == said.date or want in said.alternatives:
            if said.ambiguous and not date_settled:
                other = said.alternatives[0] if want == said.date else said.date
                out.append({"code": "ambiguous_date", "message": f'"{said.phrase}" has two readings: {format_date(want)} (captured) and {format_date(other)}.', "question": f'By "{said.phrase}", do you mean {format_date(want)} or {format_date(other)}?'})
        elif not date_settled:
            out.append({
                "code": "date_differs_from_request",
                "message": f'The request says "{said.phrase}", which is {format_date(said.date)} in {body["timeZone"]}. The intent says {format_date(want)}.',
                "question": f'You said "{said.phrase}". Should this be {format_date(said.date)} or {format_date(want)}?',
            })

    # 2. Budget.
    cap = next((r for r in rules if r["test"]["op"] == "money_lte" and r["field"] == "amount"), None)
    budget = _budget_in(text)
    if budget is not None and cap and cap["test"]["value"]["minor"] > js_round(budget * 100):
        out.append({"code": "budget_differs_from_request", "message": f"The request mentions {js_num(budget)}; the intent allows {format_money(cap['test']['value'])}.", "question": f"Is {format_money(cap['test']['value'])} okay, or should I stay under {js_num(budget)}?"})
    elif budget is not None and not cap and buying:
        out.append({"code": "budget_not_captured", "message": f"The request mentions a budget of {js_num(budget)}, but the intent has no price limit."})
    elif not cap and buying:
        out.append({"code": "no_amount_limit", "message": "The intent has no price limit. Any amount would pass the check."})

    # 3. Refundability.
    if buying and _REFUNDABLE.search(text) and not _NON_REFUNDABLE.search(text) and not any(_REFUND_FIELD.search(r["field"]) for r in rules):
        out.append({"code": "refundable_not_captured", "message": "The request asks for something refundable, but no rule checks it."})

    # 4. Quantity.
    qty = next((r for r in rules if r["field"].endswith("quantity") and r["test"]["op"] == "eq"), None)
    qm = _QTY.search(text)
    if qty and qm:
        word = qm.group(1).lower()
        n = _QTY_WORDS.get(word, int(word) if word.isdigit() else None)
        if n is not None and n != qty["test"]["value"]:
            out.append({"code": "quantity_differs_from_request", "message": f'The request says "{qm.group(0)}"; the intent says quantity {js_num(qty["test"]["value"])}.', "question": f"How many do you want: {n} or {js_num(qty['test']['value'])}?"})

    # 5. A question is not an order.
    if buying and _QUESTION.search(text) and not _BUY_VERB.search(text):
        out.append({"code": "request_reads_as_question", "message": f"The request reads like a question, but the intent authorizes {', '.join(body['allow'])}.", "question": "Do you want me to go ahead, or just tell you what I find?"})
    return out


def build_intent_body(user: str, request: str, wants: dict, time_zone: str = "UTC", also: Optional[list] = None, max_orders: int = 1, max_attempts: int = 8,
                      expires_in: int = 86_400, clarifications: Optional[list] = None, now: Optional[datetime] = None) -> IntentBody:
    if not user:
        raise TypeError("intent(): `user` is required")
    if not isinstance(request, str) or not request.strip():
        raise TypeError("intent(): `request` must be the user's words")
    try:
        ZoneInfo(time_zone)
    except Exception as e:
        raise ValueError(f'intent(): unknown time zone "{time_zone}"') from e
    now = now or datetime.now(timezone.utc)
    body: IntentBody = {
        "user": user,
        "request": request.strip(),
        "timeZone": time_zone,
        "createdAt": to_iso(now),
        "expiresAt": to_iso(now + timedelta(seconds=expires_in)),
        "pack": wants.get("pack") or "custom",
        "allow": list(wants["allow"]),
        "rules": [*wants["rules"], *(also or [])],
        "maxOrders": max_orders,
        "maxAttempts": max_attempts,
        "clarifications": list(clarifications or []),
        "warnings": [],
    }
    body["warnings"] = lint(body)
    return body


_ACTION_WORDS = {
    "flight.book": "book a flight", "flight.cancel": "cancel a flight", "flight.change": "change a flight",
    "retail.purchase": "buy", "retail.return": "return an item", "restaurant.reserve": "reserve a table",
}


def action_words(action: str) -> str:
    return _ACTION_WORDS.get(action) or re.sub(r"[._]", " ", action)


def summarize(body: IntentBody) -> str:
    """One line to show the user before the agent acts. Acknowledging it makes the record much stronger."""
    if not body["allow"]:
        return "You asked a question. I won't buy, book or cancel anything."
    parts = [f"{r['label'].lower()} {describe(r)}{' (preferred)' if r['strength'] == 'prefer' else ''}" for r in body["rules"]]
    return f"I'll {' or '.join(action_words(a) for a in body['allow'])}: {', '.join(parts)}."
