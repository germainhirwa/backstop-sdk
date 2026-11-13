"""Domain packs: shortcuts that turn "what the user asked" into rules and
"what the agent picked" into a cart.

    flight.wants(from_="JFK", to="AUS", date="2026-11-20", max_price=usd(400), passenger="Maya Okafor")
    flight.cart(from_="JFK", to="AUS", date="2026-11-20", departs="07:05", price=usd(362), refundable=True, passenger="Maya Okafor")

Keyword names are snake_case; a camelCase dict (as the TypeScript SDK and MCP use) is accepted too.
"""
from __future__ import annotations

import re
from typing import Any, Optional

from .primitives import ResolvedDate, format_date, format_money, usd
from .rules import Cart, Rule, unwrap

PackIntent = dict  # {"pack": str, "allow": [str], "rules": [Rule]}

_CAMEL = {"from_": "from", "max_price": "maxPrice", "max_total": "maxTotal", "max_deposit": "maxDeposit", "party_size": "partySize", "deliver_by": "deliverBy"}


def _args(d: Optional[dict], kw: dict) -> dict:
    out = dict(d or {})
    for k, v in kw.items():
        out[_CAMEL.get(k, k)] = v
    return {k: v for k, v in out.items() if v is not None}


def _date(d: Any) -> str:
    return d.date if isinstance(d, ResolvedDate) else d


def _rule(field: str, label: str, strength: str, test: dict) -> Rule:
    return {"field": field, "label": label, "strength": strength, "test": test}


def _clean(d: dict) -> dict:
    return {k: v for k, v in d.items() if v is not None}


class _Flight:
    """Flights. Actions: flight.book, flight.cancel, flight.change."""

    BOOK, CANCEL, CHANGE = "flight.book", "flight.cancel", "flight.change"

    def wants(self, ask: Optional[dict] = None, **kw: Any) -> PackIntent:
        """from_, to, date, passenger; optional departs=("06:00","12:00"), max_price, refundable, seat, cabin, nonstop, airline."""
        a = _args(ask, kw)
        rules = [
            _rule("item.from", "Origin", "must", {"op": "eq", "value": a["from"].upper()}),
            _rule("item.to", "Destination", "must", {"op": "eq", "value": a["to"].upper()}),
            _rule("item.date", "Date", "must", {"op": "date", "value": _date(a["date"])}),
            _rule("item.passenger", "Passenger", "must", {"op": "name", "value": a["passenger"]}),
        ]
        if a.get("departs"):
            v, s = unwrap(a["departs"])
            rules.append(_rule("item.departs", "Departure time", s, {"op": "between", "min": v[0], "max": v[1]}))
        if a.get("maxPrice"):
            rules.append(_rule("amount", "Price", "must", {"op": "money_lte", "value": a["maxPrice"]}))
        if "refundable" in a:
            v, s = unwrap(a["refundable"])
            if v:
                rules.append(_rule("item.refundable", "Refundable", s, {"op": "is", "value": True}))
        if "seat" in a:
            v, s = unwrap(a["seat"])
            rules.append(_rule("item.seat", "Seat", s, {"op": "eq", "value": v}))
        if "cabin" in a:
            v, s = unwrap(a["cabin"])
            rules.append(_rule("item.cabin", "Cabin", s, {"op": "eq", "value": v}))
        if "nonstop" in a:
            v, s = unwrap(a["nonstop"])
            if v:
                rules.append(_rule("item.stops", "Stops", s, {"op": "lte", "value": 0}))
        if "airline" in a:
            v, s = unwrap(a["airline"])
            rules.append(_rule("item.airline", "Airline", s, {"op": "in", "values": list(v) if isinstance(v, (list, tuple)) else [v]}))
        return {"pack": "flight", "allow": [self.BOOK], "rules": rules}

    def cart(self, offer: Optional[dict] = None, **kw: Any) -> Cart:
        """from_, to, date, departs, price, refundable, passenger; optional seat, cabin, stops, airline, flight."""
        o = _args(offer, kw)
        frm, to = o["from"].upper(), o["to"].upper()
        summary = re.sub(r"\s+", " ", f"{o.get('airline') or 'Flight'} {o.get('flight') or ''} {frm}→{to} {format_date(o['date'])} {o['departs']}").strip()
        return _clean({
            "action": self.BOOK, "amount": o["price"], "merchant": o.get("airline"), "summary": summary,
            "item": _clean({
                "from": frm, "to": to, "date": o["date"], "departs": o["departs"], "refundable": o["refundable"], "passenger": o["passenger"],
                "seat": o["seat"].lower() if o.get("seat") else None, "cabin": o["cabin"].lower() if o.get("cabin") else None,
                "stops": o.get("stops", 0), "airline": o.get("airline"), "flight": o.get("flight"),
            }),
        })

    def cancel(self, flight: str, forfeits: dict) -> Cart:
        """A cancellation is a purchase-sized decision: `forfeits` is what the user loses."""
        return {"action": self.CANCEL, "amount": forfeits, "summary": f"Cancel {flight} (forfeits {format_money(forfeits)})", "item": {"flight": flight}}


class _Retail:
    """Retail. Actions: retail.purchase, retail.cancel, retail.return."""

    PURCHASE, CANCEL, RETURN = "retail.purchase", "retail.cancel", "retail.return"

    def wants(self, ask: Optional[dict] = None, **kw: Any) -> PackIntent:
        """product or sku; optional variant={"size": "M"}, quantity (default 1), max_total, merchant, deliver_by."""
        a = _args(ask, kw)
        rules = []
        if a.get("sku"):
            rules.append(_rule("item.sku", "Product", "must", {"op": "eq", "value": a["sku"]}))
        elif a.get("product"):
            rules.append(_rule("item.product", "Product", "must", {"op": "eq", "value": a["product"]}))
        for key, val in (a.get("variant") or {}).items():
            v, s = unwrap(val)
            rules.append(_rule(f"item.variant.{key}", key[0].upper() + key[1:], s, {"op": "eq", "value": v}))
        rules.append(_rule("item.quantity", "Quantity", "must", {"op": "eq", "value": a.get("quantity", 1)}))
        if a.get("maxTotal"):
            rules.append(_rule("amount", "Total", "must", {"op": "money_lte", "value": a["maxTotal"]}))
        if "merchant" in a:
            v, s = unwrap(a["merchant"])
            rules.append(_rule("merchant", "Seller", s, {"op": "in", "values": list(v) if isinstance(v, (list, tuple)) else [v]}))
        if "deliverBy" in a:
            v, s = unwrap(a["deliverBy"])
            rules.append(_rule("item.arrives", "Delivery", s, {"op": "date_lte", "value": v}))
        return {"pack": "retail", "allow": [self.PURCHASE], "rules": rules}

    def cart(self, offer: Optional[dict] = None, **kw: Any) -> Cart:
        """product, merchant, quantity, total (items + shipping + tax); optional sku, variant, arrives."""
        o = _args(offer, kw)
        variant = dict(o.get("variant") or {})
        v = ", ".join(str(x) for x in variant.values())
        return {
            "action": self.PURCHASE, "amount": o["total"], "merchant": o["merchant"],
            "summary": f"{o['quantity']} × {o['product']}{f' ({v})' if v else ''} from {o['merchant']}",
            "item": _clean({"product": o["product"], "sku": o.get("sku"), "variant": variant, "quantity": o["quantity"], "arrives": o.get("arrives")}),
        }


class _Restaurant:
    """Restaurants. Actions: restaurant.reserve, restaurant.cancel."""

    RESERVE, CANCEL = "restaurant.reserve", "restaurant.cancel"

    def wants(self, ask: Optional[dict] = None, **kw: Any) -> PackIntent:
        """date, party_size; optional venue, time=("19:00","20:30"), max_deposit (default $0)."""
        a = _args(ask, kw)
        rules = [
            _rule("item.date", "Date", "must", {"op": "date", "value": _date(a["date"])}),
            _rule("item.partySize", "Party size", "must", {"op": "eq", "value": a["partySize"]}),
            _rule("amount", "Deposit at risk", "must", {"op": "money_lte", "value": a.get("maxDeposit") or usd(0)}),
        ]
        if a.get("venue"):
            rules.append(_rule("item.venue", "Restaurant", "must", {"op": "eq", "value": a["venue"]}))
        if a.get("time"):
            v, s = unwrap(a["time"])
            rules.append(_rule("item.time", "Time", s, {"op": "between", "min": v[0], "max": v[1]}))
        return {"pack": "restaurant", "allow": [self.RESERVE], "rules": rules}

    def cart(self, offer: Optional[dict] = None, **kw: Any) -> Cart:
        """venue, date, time, party_size; optional deposit (deposit or no-show fee the card is exposed to)."""
        o = _args(offer, kw)
        return {
            "action": self.RESERVE, "amount": o.get("deposit") or usd(0), "merchant": o["venue"],
            "summary": f"Table for {o['partySize']} at {o['venue']}, {format_date(o['date'])} {o['time']}",
            "item": {"venue": o["venue"], "date": o["date"], "time": o["time"], "partySize": o["partySize"]},
        }


flight = _Flight()
retail = _Retail()
restaurant = _Restaurant()


def nothing() -> PackIntent:
    """The user asked a question or wants information only. Authorizes no purchase at all."""
    return {"pack": "none", "allow": [], "rules": []}
