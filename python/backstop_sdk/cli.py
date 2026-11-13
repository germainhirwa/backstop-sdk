"""backstop demo            Replay three publicly reported agent mistakes through the check.
backstop eval [file]     Run an agent through the 50-task Agent Mistake Test.
backstop keys            Generate an Ed25519 signing key pair.
backstop mcp             Start the MCP server on stdio.
"""
from __future__ import annotations

import importlib.util
import json
import os
import sys
from typing import Optional

from .core import Backstop, Verdict
from .eval import cheapest_agent, first_offer_agent, format_report, run_eval
from .packs import flight, nothing, restaurant
from .primitives import format_money, from_iso, usd

_COLOR = sys.stdout.isatty() and not os.environ.get("NO_COLOR")


def _paint(code: int, s: str) -> str:
    return f"\x1b[{code}m{s}\x1b[0m" if _COLOR else s


def bold(s: str) -> str: return _paint(1, s)
def dim(s: str) -> str: return _paint(2, s)
def red(s: str) -> str: return _paint(31, s)
def green(s: str) -> str: return _paint(32, s)
def yellow(s: str) -> str: return _paint(33, s)


def _print_verdict(v: Verdict) -> None:
    for f in v.findings:
        mark = green("✓") if f.ok else red("✕") if f.strength == "must" else yellow("?")
        print(f"    {mark} {f.label:<18} {dim(f.message) if f.ok else f.message}")
    stamp = green("PASS") if v.status == "pass" else red("BLOCKED") if v.status == "block" else yellow("ASK USER")
    kept = f"  {format_money(v.cart['amount'])} stays with the user" if v.status == "block" else ""
    print(f"    {bold(stamp)}{kept}")
    if v.question:
        print(f"    {yellow('→')} {v.question}")
    for r in v.reasons:
        if r.fix:
            print(f"    {dim('→ to agent:')} {r.fix}")
    if v.guarantee:
        print("    " + dim(f"guarantee {v.guarantee['id']} ({v.guarantee['status']})"))


def demo() -> None:
    now = from_iso("2026-11-11T15:00:00Z")  # Wed 11 Nov 2026, 10:00 in New York
    try:
        from .record import generate_keys
        keys = generate_keys()
    except RuntimeError:
        keys = None  # cryptography isn't installed: records are hashed but unsigned
    b = Backstop(now=lambda: now, guarantee="sandbox", keys=keys)
    tz, maya = "America/New_York", "Maya Okafor"
    wants = flight.wants(from_="JFK", to="AUS", date="2026-11-20", departs=("06:00", "12:00"), max_price=usd(400), refundable=True, passenger=maya)
    cases = [
        ("Booked the wrong week", "From a travel agent's public postmortem: a relative date resolved in server time.",
         "Book me JFK to Austin on Nov 20, morning, under $400, refundable.", wants,
         flight.cart(from_="JFK", to="AUS", date="2026-11-27", departs="07:05", price=usd(362), refundable=True, passenger=maya, airline="Delta", flight="DL 1102")),
        ("Cancelled a flight when asked about its terms", "Reported for a consumer agent: the user asked a question; the agent cancelled.",
         "What are the cancellation terms on my Delta flight to Austin?", nothing(), flight.cancel("DL 1102", usd(412))),
        ("Reserved a table nobody asked for", "Reported for a consumer agent: a $200 no-show fee on an unrequested booking.",
         "Any good dinner spots near Union Square on Friday?", nothing(),
         restaurant.cart(venue="Gramercy Tavern", date="2026-11-13", time="20:00", party_size=2, deposit=usd(200))),
        ("A clean booking", "Everything matches, so it clears with no question to the user.",
         "Book me JFK to Austin on Nov 20, morning, under $400, refundable.", wants,
         flight.cart(from_="JFK", to="AUS", date="2026-11-20", departs="07:05", price=usd(362), refundable=True, passenger=maya, airline="Delta", flight="DL 1102")),
    ]
    print(bold("\nBackstop demo: four carts through the pre-checkout check\n"))
    for title, note, request, w, cart in cases:
        print(f"  {bold(title)}  {dim(note)}")
        print(f'    {dim("user:")}  "{request}"')
        print(f"    {dim('agent:')} {cart['summary']}")
        _print_verdict(b.check(b.intent(user="u_1", request=request, time_zone=tz, wants=w), cart))
        print()
    print(dim("  Names and fares are sample data. Run `backstop eval` to test an agent on 50 tasks.\n"))


def eval_cmd(args: list) -> None:
    as_json = "--json" in args
    file: Optional[str] = next((a for a in args if not a.startswith("--")), None)
    if not file or file == "cheapest":
        agent, name = cheapest_agent, "reference agent (always buys the cheapest offer)"
    elif file == "first":
        agent, name = first_offer_agent, "reference agent (always buys the first offer)"
    else:
        spec = importlib.util.spec_from_file_location("backstop_user_agent", os.path.abspath(file))
        if spec is None or spec.loader is None:
            raise ValueError(f"Can't load {file}.")
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        agent = getattr(mod, "agent", None)
        if not callable(agent):
            raise ValueError(f"{file} must define a function named `agent`.")
        name = file

    def tick(r) -> None:
        sys.stdout.write(green("·") if r.outcome == "correct" else red("✕") if r.outcome == "wrong_purchase" else yellow("?"))
        sys.stdout.flush()

    report = run_eval(agent, on_result=None if as_json else tick)
    if as_json:
        print(json.dumps(report.to_dict(), indent=2, ensure_ascii=False))
    else:
        print(f"\n\n{format_report(report, name)}\n")


HELP = """backstop <command>

  demo            Replay three publicly reported agent mistakes through the check
  eval [file]     Run an agent through the 50-task Agent Mistake Test
                  file: a Python file defining agent(task) -> {"cart"} | {"ask"} | {"decline"}
                  or "cheapest" / "first" for a reference agent. Add --json for raw output.
  keys            Generate an Ed25519 signing key pair
  mcp             Start the MCP server on stdio
"""


def main(argv: Optional[list] = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    cmd, rest = (argv[0], argv[1:]) if argv else (None, [])
    try:
        if cmd == "demo":
            demo()
        elif cmd == "eval":
            eval_cmd(rest)
        elif cmd == "keys":
            from .record import generate_keys
            print(json.dumps(generate_keys().to_dict(), indent=2))
        elif cmd == "mcp":
            from .mcp import serve
            serve()
        else:
            print(HELP)
    except Exception as e:
        print(red(str(e)), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
