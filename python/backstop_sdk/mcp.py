"""MCP server (stdio, JSON-RPC 2.0, no dependencies).

Gives any MCP-capable agent four tools, so the model itself can capture the
request, check a cart before paying, record the confirmation, and resolve
relative dates in the user's time zone. Same tools and schemas as the
TypeScript server.

    python -m backstop_sdk mcp
"""
from __future__ import annotations

import json
import math
import os
import sys
from typing import Any, Optional

from .core import Backstop
from .packs import flight, nothing, restaurant, retail
from .primitives import is_money, is_number, money, resolve_date
from .rules import prefer

_MONEY_KEYS = {"maxPrice", "price", "maxTotal", "total", "maxDeposit", "deposit", "forfeits", "amount"}


def to_money(v: Any) -> dict:
    """Models send prices as numbers; accept 362, "362", {amount, currency} or Money."""
    if is_money(v):
        return v
    if is_number(v):
        return money(v)
    if isinstance(v, str) and v.strip():
        try:
            n = float(v.replace("$", "").replace(",", ""))
            if math.isfinite(n):
                return money(n)
        except ValueError:
            pass
    if isinstance(v, dict) and is_number(v.get("amount")):
        return money(v["amount"], v.get("currency") or "USD")
    raise ValueError(f"Expected a money amount, got {json.dumps(v)}")


def _normalize(obj: dict) -> dict:
    """Convert money fields, and {"prefer": x} into a preference."""
    out: dict = {}
    for k, v in obj.items():
        if v is None:
            continue
        if k in _MONEY_KEYS:
            out[k] = to_money(v)
        elif isinstance(v, dict) and "prefer" in v:
            out[k] = prefer(v["prefer"])
        elif k == "variant" and isinstance(v, dict):
            out[k] = _normalize(v)
        else:
            out[k] = v
    return out


def _wants_for(pack: str, fields: dict) -> dict:
    f = _normalize(fields)
    if pack == "flight":
        return flight.wants(f)
    if pack == "retail":
        return retail.wants(f)
    if pack == "restaurant":
        return restaurant.wants(f)
    if pack == "none":
        return nothing()
    raise ValueError(f'Unknown pack "{pack}". Use flight, retail, restaurant or none.')


def _cart_for(pack: str, fields: dict) -> dict:
    f = _normalize(fields)
    if pack == "flight":
        return flight.cart(f)
    if pack == "retail":
        return retail.cart(f)
    if pack == "restaurant":
        return restaurant.cart(f)
    if pack == "custom":
        cart = {"action": str(f.get("action")), "amount": to_money(f.get("amount")), "item": f.get("item") or {}}
        for k in ("merchant", "summary"):
            if f.get(k) is not None:
                cart[k] = f[k]
        return cart
    raise ValueError(f'Unknown pack "{pack}". Use flight, retail, restaurant or custom.')


def _obj(properties: dict, required: list) -> dict:
    return {"type": "object", "properties": properties, "required": required}


TOOLS = [
    {
        "name": "backstop_capture_intent",
        "description": 'Call FIRST, as soon as the user asks you to buy, book, reserve or cancel something, and also when they only ask a question (use pack "none"). Records what the user asked for, in their words and as structured fields. Returns an intentId, a one-line summary to show the user, and any questions to ask them before acting.',
        "inputSchema": _obj({
            "user": {"type": "string", "description": "Your id for the user."},
            "request": {"type": "string", "description": "The user's request, verbatim."},
            "timeZone": {"type": "string", "description": "The user's IANA time zone, e.g. America/New_York."},
            "pack": {"type": "string", "enum": ["flight", "retail", "restaurant", "none"], "description": '"none" when the user is only asking a question: it authorizes no purchase.'},
            "wants": {
                "type": "object",
                "description": 'What the user asked for. flight: {from,to,date(YYYY-MM-DD),departs:["06:00","12:00"],maxPrice,refundable,passenger,seat,cabin,nonstop,airline}. retail: {product|sku,variant:{size,color},quantity,maxTotal,merchant,deliverBy}. restaurant: {venue,date,time:[from,to],partySize,maxDeposit}. Only include what the user actually said. Wrap a soft preference as {"prefer": value}. Prices are numbers in USD.',
            },
        }, ["user", "request", "timeZone", "pack"]),
    },
    {
        "name": "backstop_check_cart",
        "description": 'Call IMMEDIATELY BEFORE paying, booking or cancelling. Compares what you are about to do with what the user asked for. status "pass": proceed with exactly this cart. "block": do not pay; follow the fixes and check again. "ask": put the question to the user, then call again with approved set to their answer.',
        "inputSchema": _obj({
            "intentId": {"type": "string"},
            "pack": {"type": "string", "enum": ["flight", "retail", "restaurant", "custom"]},
            "cart": {
                "type": "object",
                "description": "What you are about to buy. flight: {from,to,date,departs(HH:MM),price,refundable,passenger,seat,cabin,stops,airline,flight}. retail: {product,sku,merchant,variant,quantity,total(incl. shipping and tax),arrives}. restaurant: {venue,date,time,partySize,deposit}. custom: {action,amount,merchant,summary,item}.",
            },
            "approved": {"type": "boolean", "description": 'Only after an "ask" verdict: the user\'s answer to the question.'},
        }, ["intentId", "pack", "cart"]),
    },
    {
        "name": "backstop_confirm_order",
        "description": 'Call RIGHT AFTER the merchant confirms. Compares the confirmation with the checked cart. status "drift" means the merchant confirmed something the user did not ask for: cancel or correct it now and tell the user.',
        "inputSchema": _obj({
            "intentId": {"type": "string"},
            "orderId": {"type": "string", "description": "The merchant's confirmation number."},
            "amount": {"type": "number", "description": "What was actually charged, in USD."},
            "item": {"type": "object", "description": "Any fields the confirmation shows that could differ (date, seat, size…)."},
        }, ["intentId"]),
    },
    {
        "name": "backstop_resolve_date",
        "description": 'Turn a date phrase ("next Friday", "tomorrow", "Nov 20") into a calendar date in the user\'s time zone. Use it instead of computing dates yourself. If ambiguous is true, ask the user which date they mean.',
        "inputSchema": _obj({"phrase": {"type": "string"}, "timeZone": {"type": "string"}}, ["phrase", "timeZone"]),
    },
]


class McpState:
    def __init__(self, backstop: Optional[Backstop] = None):
        self.backstop = backstop or Backstop()
        self.intents: dict = {}
        self.verdicts: dict = {}


def call_tool(state: McpState, name: str, args: dict) -> dict:
    """Handle one tool call. Exposed so it can be tested without a transport."""
    b = state.backstop

    def intent_of(id_: Any):
        i = state.intents.get(str(id_))
        if not i:
            raise ValueError(f"No intent {id_}. Call backstop_capture_intent first.")
        return i

    if name == "backstop_capture_intent":
        intent = b.intent(user=str(args.get("user")), request=str(args.get("request")), time_zone=str(args.get("timeZone") or "UTC"), wants=_wants_for(str(args.get("pack")), args.get("wants") or {}))
        state.intents[intent.id] = intent
        return {"intentId": intent.id, "summary": intent.summary, "questionsForUser": intent.questions, "warnings": [w["message"] for w in intent.warnings], "authorizes": intent.body["allow"]}
    if name == "backstop_check_cart":
        intent = intent_of(args.get("intentId"))
        pending = state.verdicts.get(intent.id)
        if isinstance(args.get("approved"), bool) and pending is not None and pending.status == "ask":
            v = b.resolve(pending, args["approved"])
        else:
            v = b.check(intent, _cart_for(str(args.get("pack")), args.get("cart") or {}))
        state.verdicts[intent.id] = v
        return {
            "status": v.status,
            "instruction": v.for_agent,
            "questionForUser": v.question,
            "fixes": [r.fix for r in v.reasons],
            "checks": [{"field": f.label, "ok": f.ok, "expected": f.expected, "actual": f.actual} for f in v.findings],
            "guarantee": v.guarantee,
            "verdictId": v.id,
        }
    if name == "backstop_confirm_order":
        intent = intent_of(args.get("intentId"))
        v = state.verdicts.get(intent.id)
        if v is None or v.status != "pass":
            raise ValueError('No passed check for this intent. Call backstop_check_cart and get status "pass" before ordering.')
        c = b.commit(v, id=args.get("orderId"), amount=None if args.get("amount") is None else to_money(args["amount"]), item=args.get("item"))
        return {"status": c.status, "instruction": c.for_agent, "changed": c.changed, "violations": [x.message for x in c.violations]}
    if name == "backstop_resolve_date":
        r = resolve_date(str(args.get("phrase")), str(args.get("timeZone") or "UTC"))
        return r.to_dict() if r else {"date": None, "note": "No date found in that phrase. Ask the user for the date."}
    raise ValueError(f"Unknown tool {name}")


def handle(state: McpState, req: dict) -> Optional[dict]:
    """Handle one JSON-RPC message. Returns the reply, or None for a notification."""
    if "id" not in req:
        return None
    id_, method, params = req["id"], req.get("method"), req.get("params") or {}
    try:
        if method == "initialize":
            result: Any = {"protocolVersion": params.get("protocolVersion") or "2025-06-18", "capabilities": {"tools": {}}, "serverInfo": {"name": "backstop", "version": "0.1.0"},
                           "instructions": "Capture the user's intent before acting, check every cart right before paying, and confirm every order right after."}
        elif method == "ping":
            result = {}
        elif method == "tools/list":
            result = {"tools": TOOLS}
        elif method == "tools/call":
            try:
                out = call_tool(state, str(params.get("name")), params.get("arguments") or {})
                result = {"content": [{"type": "text", "text": json.dumps(out, indent=2, ensure_ascii=False)}], "structuredContent": out, "isError": False}
            except Exception as e:
                result = {"content": [{"type": "text", "text": str(e)}], "isError": True}
        else:
            return {"jsonrpc": "2.0", "id": id_, "error": {"code": -32601, "message": f"Method not found: {method}"}}
        return {"jsonrpc": "2.0", "id": id_, "result": result}
    except Exception as e:
        return {"jsonrpc": "2.0", "id": id_, "error": {"code": -32603, "message": str(e)}}


def serve(backstop: Optional[Backstop] = None) -> None:
    """Start the server on stdin/stdout."""
    state = McpState(backstop or Backstop(guarantee="sandbox" if os.environ.get("BACKSTOP_SANDBOX") == "1" else None))
    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            req = json.loads(line)
        except ValueError:
            reply: Optional[dict] = {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Parse error"}}
        else:
            reply = handle(state, req) if isinstance(req, dict) else None
        if reply is not None:
            sys.stdout.write(json.dumps(reply, ensure_ascii=False) + "\n")
            sys.stdout.flush()
