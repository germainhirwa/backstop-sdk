"""Backstop: check what an AI agent is about to buy against what the user asked for.

    from backstop_sdk import Backstop, flight, usd

    backstop = Backstop()
    intent = backstop.intent(
        user="u_1",
        request="Book me JFK to Austin on Nov 20, under $400.",
        time_zone="America/New_York",
        wants=flight.wants(from_="JFK", to="AUS", date="2026-11-20", max_price=usd(400), passenger="Maya Okafor"),
    )
    verdict = backstop.check(intent, flight.cart(...))   # "pass" | "block" | "ask"
    if verdict.status == "pass":
        ...  # pay, then: backstop.commit(verdict, id=confirmation, amount=charged)
"""
from .core import Backstop, BackstopBlocked, BackstopError, BackstopNeedsUser, ClaimDecision, Commit, Intent, MemoryStore, Policy, Store, Verdict, sandbox_guarantee
from .intent import action_words, build_intent_body, lint, summarize
from .packs import flight, nothing, restaurant, retail
from .primitives import (ResolvedDate, add_days, canonical, compare_names, days_between, find_date_phrase, format_date, format_money, format_time, is_iso_date, is_money, money,
                         normalize_name, resolve_date, sha256, today_in, usd, weekday_of)
from .record import ChainCheck, KeyPair, generate_keys, seal, verify_chain
from .rules import Finding, describe, evaluate, must, prefer, prefers

__version__ = "0.1.0"

__all__ = [
    "Backstop", "BackstopBlocked", "BackstopError", "BackstopNeedsUser", "ClaimDecision", "Commit", "Intent", "MemoryStore", "Policy", "Store", "Verdict", "sandbox_guarantee",
    "action_words", "build_intent_body", "lint", "summarize",
    "flight", "nothing", "restaurant", "retail",
    "ResolvedDate", "add_days", "canonical", "compare_names", "days_between", "find_date_phrase", "format_date", "format_money", "format_time", "is_iso_date", "is_money", "money",
    "normalize_name", "resolve_date", "sha256", "today_in", "usd", "weekday_of",
    "ChainCheck", "KeyPair", "generate_keys", "seal", "verify_chain",
    "Finding", "describe", "evaluate", "must", "prefer", "prefers",
]
