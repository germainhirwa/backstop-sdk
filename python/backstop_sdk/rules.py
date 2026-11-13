"""Rules: what the user asked for, as data.

A rule is a plain dict, never a function. That is what lets the same rule be
signed into a record, re-run against the delivered order when a claim comes in,
and evaluated identically by the TypeScript SDK.

    {"field": "item.date", "label": "Date", "strength": "must", "test": {"op": "date", "value": "2026-11-20"}}
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Optional

from .primitives import compare_names, days_between, format_date, format_money, format_time, get_path, is_iso_date, is_money, is_number, js_num, js_str

Rule = dict
Cart = dict  # {"action", "amount", "merchant"?, "summary"?, "item": {...}}


@dataclass
class Finding:
    """The result of one rule against one cart."""

    field: str
    label: str
    strength: str  # "must" | "prefer"
    ok: bool
    code: str
    expected: str  # what the user asked for, in words
    actual: str  # what the cart has, in words
    message: str  # sentence for a human reviewer
    fix: Optional[str] = None  # instruction for the agent; only when the rule failed

    def to_dict(self) -> dict:
        d = {"field": self.field, "label": self.label, "strength": self.strength, "ok": self.ok, "code": self.code, "expected": self.expected, "actual": self.actual, "message": self.message}
        if self.fix is not None:
            d["fix"] = self.fix
        return d


_TIME = re.compile(r"^\d{2}:\d{2}$")


def _show(v: Any) -> str:
    if v is None or v == "" and isinstance(v, str):
        return "nothing"
    if is_money(v):
        return format_money(v)
    if is_iso_date(v):
        return format_date(v)
    if isinstance(v, str) and _TIME.match(v):
        return format_time(v)
    if isinstance(v, bool):
        return "yes" if v else "no"
    return js_str(v)


def _fold(v: Any) -> Any:
    return v.strip().lower() if isinstance(v, str) else v


def _same(a: Any, b: Any) -> bool:
    """JavaScript ===: no coercion between booleans, numbers and strings."""
    if isinstance(a, bool) or isinstance(b, bool):
        return isinstance(a, bool) and isinstance(b, bool) and a == b
    if is_number(a) and is_number(b):
        return a == b
    if isinstance(a, str) and isinstance(b, str):
        return a == b
    return a is None and b is None


def describe(rule: Rule) -> str:
    """Describe what a rule requires, for summaries shown to the user."""
    t = rule["test"]
    op = t["op"]
    if op == "eq":
        return _show(t["value"])
    if op == "in":
        return " or ".join(_show(v) for v in t["values"])
    if op == "lte":
        return f"at most {js_num(t['value'])}"
    if op == "gte":
        return f"at least {js_num(t['value'])}"
    if op == "between":
        return f"{_show(t['min'])}–{_show(t['max'])}"
    if op == "money_lte":
        return f"up to {format_money(t['value'])}"
    if op == "date":
        return format_date(t["value"])
    if op == "date_lte":
        return f"by {format_date(t['value'])}"
    if op == "name":
        return t["value"]
    if op == "is":
        return "yes" if t["value"] else "no"
    raise ValueError(f"Unknown rule op {op!r}")


def evaluate(rule: Rule, cart: Cart) -> Finding:
    """Run one rule against a cart. Missing data fails closed: what can't be verified isn't cleared."""
    actual = get_path(cart, rule["field"])
    expected = describe(rule)
    L = rule["label"]
    low = L.lower()
    base = dict(field=rule["field"], label=L, strength=rule["strength"], expected=expected, actual=_show(actual))

    def ok(message: str) -> Finding:
        return Finding(ok=True, code="ok", message=message, **base)

    def fail(code: str, message: str, fix: str) -> Finding:
        return Finding(ok=False, code=code, message=message, fix=fix, **base)

    if actual is None or (isinstance(actual, str) and actual == ""):
        return fail("missing_field", f"{L} is missing from the cart, so it can't be verified.", f"Include {rule['field']} in the cart. The user asked for {low}: {expected}.")
    t = rule["test"]
    op = t["op"]
    if op == "eq":
        if _same(_fold(actual), _fold(t["value"])):
            return ok(f"{L} is {_show(actual)}, as asked.")
        return fail("mismatch", f"{L} is {_show(actual)}; the user asked for {expected}.", f"Change {low} to {expected}.")
    if op == "in":
        if any(_same(_fold(v), _fold(actual)) for v in t["values"]):
            return ok(f"{L} is {_show(actual)}, which is allowed.")
        return fail("not_allowed", f"{L} is {_show(actual)}; the user allowed only {expected}.", f"Use {expected} for {low}.")
    if op == "lte":
        lim = js_num(t["value"])
        if is_number(actual) and actual <= t["value"]:
            return ok(f"{L} is {js_num(actual)}, within the limit of {lim}.")
        return fail("over_limit", f"{L} is {_show(actual)}; the limit is {lim}.", f"Keep {low} at or below {lim}.")
    if op == "gte":
        lim = js_num(t["value"])
        if is_number(actual) and actual >= t["value"]:
            return ok(f"{L} is {js_num(actual)}, at least {lim}.")
        return fail("under_limit", f"{L} is {_show(actual)}; the minimum is {lim}.", f"Keep {low} at or above {lim}.")
    if op == "between":
        lo, hi = t["min"], t["max"]
        same_kind = (is_number(actual) and is_number(lo)) or (isinstance(actual, str) and isinstance(lo, str))
        if same_kind and lo <= actual <= hi:
            return ok(f"{L} is {_show(actual)}, inside {expected}.")
        return fail("out_of_range", f"{L} is {_show(actual)}, outside {expected}.", f"Pick an option with {low} inside {expected}.")
    if op == "money_lte":
        cap = t["value"]
        if not is_money(actual):
            return fail("mismatch", f"{L} isn't a money amount.", f"Send {rule['field']} as {{ currency, minor }}.")
        if actual["currency"] != cap["currency"]:
            return fail("currency_mismatch", f"{L} is in {actual['currency']}; the user's limit is in {cap['currency']}.", f"Quote the total in {cap['currency']}.")
        if actual["minor"] <= cap["minor"]:
            return ok(f"{format_money(actual)} is within the {format_money(cap)} limit.")
        over = format_money({"currency": actual["currency"], "minor": actual["minor"] - cap["minor"]})
        return fail("over_limit", f"{format_money(actual)} is {over} over the {format_money(cap)} limit the user set.", f"Find an option at or under {format_money(cap)}, or ask the user to raise the limit.")
    if op == "date":
        want = t["value"]
        if actual == want and isinstance(actual, str):
            return ok(f"{L} is {format_date(want)}, as asked.")
        if not is_iso_date(actual):
            return fail("date_mismatch", f"{L} isn't a valid date.", f"Send {rule['field']} as YYYY-MM-DD.")
        diff = days_between(want, actual)
        hint = ""
        if abs(diff) % 7 == 0:
            hint = f" That is exactly {abs(diff) // 7} week{'' if abs(diff) == 7 else 's'} off, which usually means a relative date was resolved in the wrong time zone or week."
        return fail("date_mismatch", f"{L} is {format_date(actual)}; the user asked for {format_date(want)} ({'+' if diff > 0 else ''}{diff} days).{hint}", f"Use {want} ({format_date(want)}).")
    if op == "date_lte":
        if is_iso_date(actual) and actual <= t["value"]:
            return ok(f"{L} is {format_date(actual)}, in time for {format_date(t['value'])}.")
        return fail("too_late", f"{L} is {_show(actual)}; the user needs it by {format_date(t['value'])}.", f"Pick an option that arrives by {t['value']}.")
    if op == "name":
        want = t["value"]
        match = compare_names(want, js_str(actual))
        if match == "exact":
            return ok(f"{L} is {want}.")
        if match == "middle_omitted":
            return ok(f"{L} matches {want} on first and last name.")
        if match == "typo":
            return fail("name_typo", f'{L} reads "{js_str(actual)}", which looks like a misspelling of "{want}".', f"Spell the name exactly: {want}.")
        return fail("name_mismatch", f'{L} is "{js_str(actual)}"; the user asked for "{want}".', f"Use the name {want}.")
    if op == "is":
        if _same(actual, t["value"]):
            return ok(f"{L}: {_show(actual)}, as asked.")
        return fail("mismatch", f"{L} is {_show(actual)}; the user asked for {_show(t['value'])}.", f"Choose an option where {low} is {_show(t['value'])}.")
    raise ValueError(f"Unknown rule op {op!r}")


# ───────────────────────────── Rule builders ─────────────────────────────


class _Builder:
    def __init__(self, strength: str):
        self._s = strength

    def _r(self, field: str, label: Optional[str], test: dict) -> Rule:
        return {"field": field, "label": label or field, "strength": self._s, "test": test}

    def eq(self, field: str, value: Any, label: Optional[str] = None) -> Rule:
        return self._r(field, label, {"op": "eq", "value": value})

    def one_of(self, field: str, values: list, label: Optional[str] = None) -> Rule:
        return self._r(field, label, {"op": "in", "values": list(values)})

    def at_most(self, field: str, value: float, label: Optional[str] = None) -> Rule:
        return self._r(field, label, {"op": "lte", "value": value})

    def at_least(self, field: str, value: float, label: Optional[str] = None) -> Rule:
        return self._r(field, label, {"op": "gte", "value": value})

    def between(self, field: str, low: Any, high: Any, label: Optional[str] = None) -> Rule:
        return self._r(field, label, {"op": "between", "min": low, "max": high})

    def costs_at_most(self, value: dict, label: str = "Price", field: str = "amount") -> Rule:
        """Cap on the cart total."""
        return self._r(field, label, {"op": "money_lte", "value": value})

    def on(self, field: str, value: str, label: str = "Date") -> Rule:
        return self._r(field, label, {"op": "date", "value": value})

    def by(self, field: str, value: str, label: str = "Arrives") -> Rule:
        return self._r(field, label, {"op": "date_lte", "value": value})

    def named(self, field: str, value: str, label: str = "Name") -> Rule:
        return self._r(field, label, {"op": "name", "value": value})

    def is_(self, field: str, value: bool, label: Optional[str] = None) -> Rule:
        return self._r(field, label, {"op": "is", "value": value})


must = _Builder("must")
"""Hard requirements. A failed `must` rule blocks the purchase."""
prefers = _Builder("prefer")
"""Soft preferences. A failed `prefers` rule asks the user one question."""


@dataclass(frozen=True)
class Preferred:
    value: Any


def prefer(value: Any) -> Preferred:
    """Mark a value in a pack as a preference rather than a requirement: `seat=prefer("aisle")`."""
    return Preferred(value)


def unwrap(v: Any) -> tuple:
    return (v.value, "prefer") if isinstance(v, Preferred) else (v, "must")
