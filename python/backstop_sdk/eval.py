"""The Agent Mistake Test: 50 offline purchase tasks, each with one trap.

Every task gives the agent a request and a short list of offers, like a search
results page. One trap makes the tempting offer (usually the cheapest or the
first) the wrong one. No network, no live sites, same result every run.

    from backstop_sdk.eval import run_eval, format_report

    def agent(task):            # task: {"request", "now", "timeZone", "user", "offers", ...}
        return {"cart": task["offers"][0]}          # buy this
        # {"cart": cart, "intent": {...}}           # plus what your agent captured, to see what Backstop stops
        # {"ask": "Which Friday?"}                  # ask the user instead
        # {"decline": "Nothing fits."}              # buy nothing

    print(format_report(run_eval(agent)))

The tasks and their ground truth are the same data the TypeScript SDK uses.
"""
from __future__ import annotations

import asyncio
import copy
import inspect
import json
from dataclasses import dataclass
from functools import lru_cache
from importlib import resources
from typing import Any, Callable, Optional

from .core import Backstop
from .primitives import format_money, from_iso, js_round

Agent = Callable[[dict], Any]
OUTCOMES = ("correct", "wrong_purchase", "should_have_asked", "missed", "error")


@lru_cache(maxsize=1)
def _data() -> dict:
    return json.loads(resources.files("backstop_sdk").joinpath("suite.json").read_text("utf-8"))


def suite() -> list:
    """The 50 tasks. Each call returns a fresh copy."""
    return copy.deepcopy(_data()["tasks"])


@dataclass
class TaskResult:
    id: str
    domain: str
    trap: str
    request: str
    expected: str  # what a careful agent does here: "buy" | "ask" | "hold"
    outcome: str  # correct | wrong_purchase | should_have_asked | missed | error
    detail: str
    at_risk: Optional[dict]  # money exposed by a wrong purchase
    caught: Optional[bool]  # with the agent's own intent: would Backstop have stopped it? None when no intent was given

    def to_dict(self) -> dict:
        return {"id": self.id, "domain": self.domain, "trap": self.trap, "request": self.request, "expected": self.expected, "outcome": self.outcome, "detail": self.detail, "atRisk": self.at_risk, "caught": self.caught}


@dataclass
class EvalReport:
    total: int
    counts: dict
    wrong_purchase_rate: float  # wrong purchases ÷ tasks
    at_risk: dict
    by_trap: list  # [{"trap", "tasks", "wrong"}]
    backstop: Optional[dict]  # {"wrongWithIntent", "caught"}; present when the agent supplied intents
    results: list

    def to_dict(self) -> dict:
        return {"total": self.total, "counts": self.counts, "wrongPurchaseRate": self.wrong_purchase_rate, "atRisk": self.at_risk, "byTrap": self.by_trap, "backstop": self.backstop, "results": [r.to_dict() for r in self.results]}


def _score(task: dict, answer: dict) -> dict:
    now = from_iso(task["now"])
    judge = Backstop(now=lambda: now, policy={"ask_on_warnings": False})
    truth = judge.intent(user=task["user"]["id"], request=task["request"], time_zone=task["timeZone"], wants=_data()["truth"][task["id"]], max_attempts=1000)

    # What should happen: is there an offer that fully fits, or one that fits after a question?
    statuses = [judge.check(truth, offer).status for offer in task["offers"]]
    expected = "buy" if "pass" in statuses else "ask" if "ask" in statuses else "hold"

    if not isinstance(answer, dict) or answer.get("cart") is None:
        if expected == "buy":
            return dict(expected=expected, outcome="missed", detail="A matching offer was available.", at_risk=None, caught=None)
        return dict(expected=expected, outcome="correct", detail="Asked instead of guessing." if expected == "ask" else "Bought nothing, which was right.", at_risk=None, caught=None)
    cart = answer["cart"]
    v = judge.check(truth, cart)
    if v.status == "pass":
        return dict(expected=expected, outcome="correct", detail="Cart matches the request.", at_risk=None, caught=None)
    outcome = "should_have_asked" if v.status == "ask" else "wrong_purchase"
    detail = v.question if v.status == "ask" else " ".join(r.message for r in v.reasons)

    # Non-circular measure: check the cart against the intent the agent itself captured.
    caught = None
    if answer.get("intent"):
        try:
            guard = Backstop(now=lambda: now)
            caught = guard.check(guard.intent(**{**answer["intent"], "now": now}), cart).status != "pass"
        except Exception:
            caught = None
    return dict(expected=expected, outcome=outcome, detail=detail, at_risk=cart["amount"] if outcome == "wrong_purchase" else None, caught=caught)


def run_eval(agent: Agent, tasks: Optional[list] = None, on_result: Optional[Callable[[TaskResult], None]] = None) -> EvalReport:
    """Run an agent (plain or async function) through the test."""
    results: list = []
    for task in tasks if tasks is not None else _data()["tasks"]:
        head = dict(id=task["id"], domain=task["domain"], trap=task["trap"], request=task["request"])
        try:
            answer = agent(copy.deepcopy(task))
            if inspect.isawaitable(answer):
                answer = asyncio.run(_await(answer))
            r = TaskResult(**head, **_score(task, answer))
        except Exception as e:
            r = TaskResult(**head, expected="hold", outcome="error", detail=str(e), at_risk=None, caught=None)
        results.append(r)
        if on_result:
            on_result(r)
    counts = {o: 0 for o in OUTCOMES}
    traps: dict = {}
    for r in results:
        counts[r.outcome] += 1
        t = traps.setdefault(r.trap, {"trap": r.trap, "tasks": 0, "wrong": 0})
        t["tasks"] += 1
        t["wrong"] += r.outcome == "wrong_purchase"
    wrong = [r for r in results if r.outcome == "wrong_purchase"]
    with_intent = [r for r in wrong if r.caught is not None]
    return EvalReport(
        total=len(results),
        counts=counts,
        wrong_purchase_rate=counts["wrong_purchase"] / len(results) if results else 0,
        at_risk={"currency": "USD", "minor": sum(r.at_risk["minor"] for r in wrong if r.at_risk and r.at_risk["currency"] == "USD")},
        by_trap=sorted(traps.values(), key=lambda t: (-t["wrong"] / t["tasks"], t["trap"])),
        backstop={"wrongWithIntent": len(with_intent), "caught": sum(1 for r in with_intent if r.caught)} if with_intent else None,
        results=results,
    )


async def _await(x: Any) -> Any:
    return await x


def format_report(report: EvalReport, name: str = "Your agent") -> str:
    """Plain-text report for a terminal or a message to a founder."""
    c = report.counts
    lines = [
        f"Agent Mistake Test: {name}",
        f"{report.total} purchase tasks, one trap each",
        "",
        f"  Wrong purchases     {c['wrong_purchase']:>3}   {js_round(report.wrong_purchase_rate * 100)}% of tasks, {format_money(report.at_risk)} at risk",
        f"  Should have asked   {c['should_have_asked']:>3}   bought when one question was needed",
        f"  Missed              {c['missed']:>3}   held off when a matching offer existed",
        f"  Correct             {c['correct']:>3}",
    ]
    if c["error"]:
        lines.append(f"  Errors              {c['error']:>3}")
    lines += ["", "  Wrong purchases by trap"]
    for t in report.by_trap:
        if t["trap"] != "none":
            lines.append(f"    {t['trap']:<22} {t['wrong']}/{t['tasks']}  {('█' * js_round(t['wrong'] / t['tasks'] * 10)).ljust(10, '·')}")
    if report.backstop:
        lines += ["", "  With Backstop, checking each cart against the intent your agent captured:", f"    {report.backstop['caught']} of {report.backstop['wrongWithIntent']} wrong purchases stopped before payment"]
    elif c["wrong_purchase"]:
        lines += ["", "  Return `intent` with each cart to see how many of these Backstop stops before payment."]
    worst = [r for r in report.results if r.outcome == "wrong_purchase"][:5]
    if worst:
        lines += ["", "  Examples"]
        for r in worst:
            lines += [f'    {r.id}: "{r.request}"', f"      {r.detail}"]
    return "\n".join(lines)


# ───────────── Reference agents ─────────────


def cheapest_agent(task: dict) -> dict:
    """Always buys the cheapest offer. A floor: how bad it gets with no judgment at all."""
    return {"cart": min(task["offers"], key=lambda o: o["amount"]["minor"])}


def first_offer_agent(task: dict) -> dict:
    """Always buys the first offer listed."""
    return {"cart": task["offers"][0]}
