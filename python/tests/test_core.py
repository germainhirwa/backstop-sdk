import asyncio
import json
import subprocess
import sys
from datetime import timedelta
from pathlib import Path

import pytest

from backstop_sdk import Backstop, BackstopBlocked, BackstopError, BackstopNeedsUser, flight, generate_keys, must, nothing, prefer, restaurant, retail, usd
from backstop_sdk.eval import cheapest_agent, format_report, run_eval, suite
from backstop_sdk.mcp import McpState, call_tool, handle
from backstop_sdk.primitives import from_iso

NOW = from_iso("2026-11-11T15:00:00Z")
NY = "America/New_York"
REQ = "Book me a flight from JFK to Austin on Nov 20, morning. Under $400, refundable, aisle seat."
WANTS = dict(from_="JFK", to="AUS", date="2026-11-20", departs=("06:00", "12:00"), max_price=usd(400), refundable=True, passenger="Maya Okafor")
OFFER = dict(from_="JFK", to="AUS", date="2026-11-20", departs="07:05", price=usd(362), refundable=True, passenger="Maya Okafor", seat="aisle", airline="Delta", flight="DL 1102")


def make(**kw):
    return Backstop(now=lambda: NOW, **kw)


def ask(b, **over):
    return b.intent(user="u_1", request=REQ, time_zone=NY, wants=flight.wants(**{**WANTS, **over}))


def test_pass_block_ask():
    b = make(guarantee="sandbox")
    i = ask(b, seat=prefer("aisle"))
    assert i.warnings == [] and i.summary.startswith("I'll book a flight: origin JFK")
    v = b.check(i, flight.cart(**OFFER))
    assert v.status == "pass" and v.guarantee["status"] == "sandbox" and v.guarantee["coverage"] == usd(650)
    v = b.check(i, flight.cart(**{**OFFER, "date": "2026-11-27", "price": usd(455)}))
    assert v.status == "block" and [r.code for r in v.reasons] == ["date_mismatch", "over_limit"] and v.guarantee is None
    assert "exactly 1 week off" in v.for_agent
    v = b.check(i, flight.cart(**{**OFFER, "seat": "window"}))
    assert v.status == "ask" and v.asks[0]["key"] == "item.seat"
    assert b.resolve(v, True).status == "pass"
    no = b.resolve(v, False)
    assert no.status == "block" and no.reasons[0].message == "The user declined this option."


def test_fails_closed_and_validates():
    b = make()
    cart = flight.cart(**OFFER)
    del cart["item"]["refundable"]
    v = b.check(ask(b), cart)
    assert v.status == "block" and v.reasons[0].code == "missing_field"
    with pytest.raises(BackstopError):
        b.check(ask(b), {"action": "flight.book", "amount": 362, "item": {}})
    with pytest.raises(ValueError):
        b.intent(user="u", request="x", wants=nothing(), time_zone="Mars/Olympus")


def test_question_is_not_an_order_and_action_allow_list():
    b = make()
    q = b.intent(user="u_1", request="What are the cancellation terms on my Delta flight?", time_zone=NY, wants=nothing())
    v = b.check(q, flight.cancel("DL 1102", usd(412)))
    assert v.status == "block" and v.reasons[0].code == "action_not_authorized"
    v = b.check(ask(b), restaurant.cart(venue="Lilia", date="2026-11-20", time="19:00", party_size=2))
    assert v.reasons[0].message == "The user asked to book a flight. The agent is about to reserve a table."


def test_lint_questions_then_acknowledge():
    b = make()
    i = b.intent(user="u_1", request="Book JFK to Austin next Friday, under $400", time_zone=NY, wants=flight.wants(from_="JFK", to="AUS", date="2026-11-13", max_price=usd(450), passenger="Maya Okafor"))
    assert {w["code"] for w in i.warnings} == {"ambiguous_date", "budget_differs_from_request"}
    cart = flight.cart(**{**OFFER, "date": "2026-11-13"})
    assert b.check(i, cart).status == "ask"
    assert b.check(b.acknowledge(i), cart).status == "pass"


def test_commit_duplicates_drift_and_attempts():
    b = make()
    i = ask(b)
    v = b.check(i, flight.cart(**OFFER))
    c = b.commit(v, id="DL-1", amount=usd(371))
    assert c.status == "confirmed" and c.changed == ["amount"] and [e["type"] for e in c.chain] == ["intent", "verdict", "order"]
    assert b.check(i, flight.cart(**OFFER)).reasons[0].code == "duplicate_order"
    i2 = ask(b)
    d = b.commit(b.check(i2, flight.cart(**OFFER)), {"id": "DL-2", "item": {"date": "2026-11-27"}})
    assert d.status == "drift" and d.violations[0].code == "date_mismatch" and "Cancel or correct it now" in d.for_agent
    with pytest.raises(BackstopError):
        b.commit(b.check(ask(b), flight.cart(**{**OFFER, "price": usd(999)})))
    i3 = ask(b)
    bad = flight.cart(**{**OFFER, "price": usd(999)})
    codes = [b.check(i3, bad).reasons[0].code for _ in range(9)]
    assert codes[7] == "over_limit" and codes[8] == "too_many_attempts"


def test_policy_and_expiry():
    b = make(policy={"ask_above": usd(300), "require_amount_limit": True})
    i = b.intent(user="u", request="Book JFK to Austin on Nov 20", time_zone=NY, wants=flight.wants(**{**WANTS, "max_price": None}))
    v = b.check(i, flight.cart(**OFFER))
    assert [a["key"] for a in v.asks] == ["policy:requireAmountLimit", "policy:askAbove"]
    assert b.check(i, flight.cart(**OFFER), waive=["policy:requireAmountLimit", "policy:askAbove"]).status == "pass"
    clock = [NOW]
    b2 = Backstop(now=lambda: clock[0])
    i2 = ask(b2)
    clock[0] = NOW + timedelta(days=2)
    assert b2.check(i2, flight.cart(**OFFER)).asks[0]["key"] == "intent_expired"


def test_custom_rules_and_retail():
    b = make()
    i = b.intent(user="u", request="Order the black Pegasus in a 10 from Nike, under $150", time_zone=NY,
                 wants=retail.wants(product="Nike Pegasus 41", variant={"size": "10", "color": "black"}, max_total=usd(150), merchant="Nike"), also=[must.at_least("item.rating", 4, "Rating")])
    cart = retail.cart(product="Nike Pegasus 41", merchant="Nike", variant={"size": "10.5", "color": "black"}, quantity=1, total=usd(139.99))
    cart["item"]["rating"] = 4.6
    v = b.check(i, cart)
    assert [r.field for r in v.reasons] == ["item.variant.size"] and v.reasons[0].fix == "Change size to 10."


def test_signed_record_claims_and_tampering():
    pytest.importorskip("cryptography")
    keys = generate_keys()
    b = make(keys=keys, guarantee="sandbox")
    i = b.acknowledge(ask(b), method="tapped confirm")
    done = b.commit(b.check(i, flight.cart(**OFFER)), id="DL-1")
    assert b.verify(done.chain).to_dict() == {"ok": True, "signed": True, "problems": []}
    assert b.claim(done.chain, "changed_mind").basis == "matches_request"
    assert b.claim(done.chain, "not_what_i_asked").basis == "matches_acknowledged_request"
    d = b.claim(done.chain, "not_what_i_asked", delivered={"item": {"date": "2026-11-27"}})
    assert d.status == "approved" and d.payable_up_to == usd(650)
    bad = json.loads(json.dumps(done.chain))
    bad[0]["body"]["request"] = "Book the cheapest flight, any day"
    assert b.claim(bad, "not_what_i_asked").basis == "record_invalid"
    assert b.verify(done.chain, generate_keys().public_key).ok is False
    assert b.restore(done.chain).acknowledged is True


def test_python_record_verifies_in_typescript():
    pytest.importorskip("cryptography")
    root = Path(__file__).parents[2]
    if not (root / "node_modules" / ".bin" / "tsx").exists():
        pytest.skip("TypeScript SDK not installed")
    keys = generate_keys()
    b = make(keys=keys, guarantee="sandbox")
    v = b.check(ask(b, seat=prefer("aisle")), flight.cart(**{**OFFER, "seat": "window"}))
    done = b.commit(b.resolve(v, True), id="DL-CONF-1", amount=usd(371))
    out = subprocess.run(["node_modules/.bin/tsx", "conformance/verify.ts"], cwd=root, input=json.dumps({"chain": done.chain, "publicKey": keys.public_key}), capture_output=True, text=True, timeout=120)
    assert out.returncode == 0, out.stderr
    assert json.loads(out.stdout) == {"ok": True, "signed": True, "problems": []}


def test_protect_sync_and_async():
    b = make()
    booked = []

    @b.protect(intent=lambda offer: current, cart=lambda offer: flight.cart(**offer), order=lambda result, offer: {"id": result["confirmation"]})
    def book(offer):
        booked.append(offer)
        return {"confirmation": "DL-1"}

    current = ask(b)
    with pytest.raises(BackstopBlocked) as e:
        book({**OFFER, "date": "2026-11-27"})
    assert "Use 2026-11-20" in str(e.value) and booked == []
    assert book(OFFER) == {"confirmation": "DL-1"} and len(booked) == 1

    drifted = []

    @b.protect(intent=lambda offer: current, cart=lambda offer: flight.cart(**offer), order=lambda r, offer: {"item": {"refundable": False}}, on_ask=lambda v: True, on_drift=lambda c, r: drifted.append(c))
    async def abook(offer):
        return "ok"

    current = ask(b, seat=prefer("aisle"))
    assert asyncio.run(abook({**OFFER, "seat": "window"})) == "ok" and drifted[0].violations[0].field == "item.refundable"

    @b.protect(intent=lambda offer: current, cart=lambda offer: flight.cart(**offer))
    def plain(offer):
        return "ok"

    current = ask(b, seat=prefer("aisle"))
    with pytest.raises(BackstopNeedsUser):
        plain({**OFFER, "seat": "window"})


def test_eval():
    r = run_eval(cheapest_agent)
    assert r.total == 50 and r.counts["wrong_purchase"] == 43 and r.at_risk == usd(5450.06)
    assert "$5,450.06 at risk" in format_report(r)

    def careful(task):
        if task["domain"] == "question":
            return {"decline": "Just a question."}
        return {"cart": task["offers"][0], "intent": {"user": "u", "request": task["request"], "timeZone": task["timeZone"], "wants": nothing()}}

    r2 = run_eval(careful)
    assert r2.backstop and r2.backstop["caught"] == r2.backstop["wrongWithIntent"]
    assert run_eval(lambda t: 1 / 0, tasks=suite()[:2]).counts["error"] == 2


def test_mcp():
    s = McpState(Backstop(now=lambda: NOW, guarantee="sandbox"))
    assert len(handle(s, {"jsonrpc": "2.0", "id": 1, "method": "tools/list"})["result"]["tools"]) == 4
    assert handle(s, {"jsonrpc": "2.0", "method": "notifications/initialized"}) is None
    i = call_tool(s, "backstop_capture_intent", {"user": "u_1", "request": REQ, "timeZone": NY, "pack": "flight",
                                                 "wants": {"from": "JFK", "to": "AUS", "date": "2026-11-20", "maxPrice": 400, "refundable": True, "passenger": "Maya Okafor", "seat": {"prefer": "aisle"}}})
    cart = {"from": "JFK", "to": "AUS", "date": "2026-11-27", "departs": "07:05", "price": "$362", "refundable": True, "passenger": "Maya Okafor", "seat": "window"}
    assert call_tool(s, "backstop_check_cart", {"intentId": i["intentId"], "pack": "flight", "cart": cart})["status"] == "block"
    v = call_tool(s, "backstop_check_cart", {"intentId": i["intentId"], "pack": "flight", "cart": {**cart, "date": "2026-11-20"}})
    assert v["status"] == "ask"
    assert call_tool(s, "backstop_check_cart", {"intentId": i["intentId"], "pack": "flight", "cart": {}, "approved": True})["status"] == "pass"
    assert call_tool(s, "backstop_confirm_order", {"intentId": i["intentId"], "orderId": "DL-1", "amount": 362})["status"] == "confirmed"
    assert call_tool(s, "backstop_resolve_date", {"phrase": "tomorrow", "timeZone": NY})["date"]
    err = handle(s, {"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "backstop_check_cart", "arguments": {"intentId": "nope", "pack": "flight", "cart": {}}}})
    assert err["result"]["isError"] is True


def test_cli_runs():
    out = subprocess.run([sys.executable, "-m", "backstop_sdk", "demo"], capture_output=True, text=True, cwd=Path(__file__).parents[1])
    assert out.returncode == 0 and out.stdout.count("BLOCKED") == 3 and "PASS" in out.stdout
