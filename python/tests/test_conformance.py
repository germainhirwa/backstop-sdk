"""Parity with the TypeScript reference: every case in conformance/fixtures.json must come out identical."""
import copy
import json
from pathlib import Path

import pytest

from backstop_sdk import Backstop, build_intent_body, flight, retail, usd, canonical, compare_names, evaluate, format_date, format_money, format_time, money, normalize_name, resolve_date, sha256, summarize, verify_chain
from backstop_sdk.eval import _data
from backstop_sdk.primitives import from_iso, tokens

FX = json.loads((Path(__file__).parents[2] / "conformance" / "fixtures.json").read_text("utf-8"))
NOW = from_iso("2026-11-11T15:00:00.000Z")


def test_dates():
    for c in FX["dates"]:
        r = resolve_date(c["text"], c["timeZone"], from_iso(c["now"]))
        assert (r.to_dict() if r else None) == c["result"], c


def test_names():
    for c in FX["names"]:
        assert compare_names(c["a"], c["b"]) == c["result"], c
        assert [normalize_name(c["a"]), normalize_name(c["b"])] == c["normalized"]


def test_formatting():
    for c in FX["format"]["money"]:
        assert money(c["amount"], c["currency"]) == c["value"], c
        assert format_money(c["value"]) == c["text"], c
    for c in FX["format"]["dates"]:
        assert format_date(c["date"]) == c["text"]
    for c in FX["format"]["times"]:
        assert format_time(c["time"]) == c["text"]


def test_lint_and_summaries():
    for c in FX["lint"]:
        i = c["input"]
        body = build_intent_body(user="u_1", request=i["request"], wants=i["wants"], time_zone="America/New_York", clarifications=i["clarifications"], now=NOW)
        assert body["warnings"] == c["warnings"], i["request"]
        assert summarize(body) == c["summary"]
        assert json.loads(canonical(body)) == json.loads(canonical(c["body"]))


def test_findings_and_cart_hashes():
    for c in FX["findings"]:
        assert sha256(canonical(c["cart"])) == c["cartHash"]
        assert [evaluate(r, c["cart"]).to_dict() for r in c["rules"]] == c["findings"], c["cart"]


def test_verdicts():
    by_task = {}
    for v in FX["verdicts"]:
        by_task.setdefault(v["task"], []).append(v)
    data = _data()
    assert len(data["tasks"]) == 50
    for task in data["tasks"]:
        now = from_iso(task["now"])
        judge = Backstop(now=lambda: now, policy={"ask_on_warnings": False}, guarantee="sandbox")
        intent = judge.intent(user=task["user"]["id"], request=task["request"], time_zone=task["timeZone"], wants=data["truth"][task["id"]], max_attempts=1000)
        assert len(task["offers"]) == len(by_task[task["id"]])
        for cart, want in zip(task["offers"], by_task[task["id"]]):
            v = judge.check(intent, cart)
            got = {"task": task["id"], "cart": cart, "status": v.status, "forAgent": v.for_agent, "question": v.question, "reasons": [r.to_dict() for r in v.reasons], "asks": v.asks, "guarantee": v.guarantee}
            assert got == want


def test_typescript_signed_chain_verifies_here():
    pytest.importorskip("cryptography")
    c = FX["chain"]
    assert [e["type"] for e in c["chain"]] == c["types"]
    assert verify_chain(c["chain"], c["publicKey"]).to_dict() == c["verify"] == {"ok": True, "signed": True, "problems": []}
    bad = copy.deepcopy(c["chain"])
    bad[0]["body"]["request"] = "Book the cheapest flight, any day"
    assert verify_chain(bad, c["publicKey"]).to_dict() == c["tamperedVerify"]
    forged = copy.deepcopy(c["chain"])
    forged[-1]["sig"] = forged[0]["sig"]
    assert verify_chain(forged, c["publicKey"]).problems == [f"{forged[-1]['id']}: signature does not match the public key"]


def test_claim_decisions():
    pytest.importorskip("cryptography")
    b = Backstop()
    for c in FX["claims"]:
        d = b.claim(c["chain"], c["reason"], delivered=c.get("delivered"), public_key=FX["chain"]["publicKey"])
        assert d.to_dict() == c["decision"], c["name"]


def test_tokens():
    for c in FX["tokens"]:
        assert tokens(c["text"]) == c["tokens"], c


def test_sequences_edit_detection_and_partial_matches():
    b = Backstop(now=lambda: NOW)
    shoes = b.intent(user="u_1", request="Buy the Nike Pegasus 41 in black, men's size 10, under $150.", time_zone="America/New_York",
                     wants=retail.wants(product="Pegasus 41", variant={"size": "10", "color": "black"}, max_total=usd(150)))
    for want in FX["sequences"]:
        v = b.check(shoes, want["cart"])
        got = {"cart": want["cart"], "status": v.status, "forAgent": v.for_agent, "question": v.question, "asks": v.asks, "findings": [f.to_dict() for f in v.findings]}
        assert got == want


def test_recorded_answers():
    a = FX["answers"]
    b = Backstop(now=lambda: NOW)
    i = b.intent(user="u_1", request=a["request"], time_zone="America/New_York",
                 wants=flight.wants(from_="JFK", to="AUS", date="2026-11-20", departs=("06:00", "12:00"), max_price=usd(400), passenger="Maya Okafor"))
    done = b.acknowledge(i, method="chat", answers=[{"question": i.questions[0], "answer": "Nov 20"}])
    cart = flight.cart(from_="JFK", to="AUS", date="2026-11-20", departs="06:30", price=usd(331), refundable=False, passenger="Maya Okafor", airline="JetBlue")
    assert [b.check(i, cart).status, b.check(done, cart).status] == [a["before"], a["after"]] == ["ask", "pass"]
    body = {k: v for k, v in done.chain[-1]["body"].items() if k != "intentId"}
    assert body == {k: v for k, v in a["ackBody"].items() if k != "intentId"}
