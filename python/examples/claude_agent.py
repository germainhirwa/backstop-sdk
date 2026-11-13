"""A real LLM agent for the Agent Mistake Test.

    pip install anthropic
    export ANTHROPIC_API_KEY=...
    backstop eval claude_agent.py

Claude reads the user's request and the offers, then buys one, asks a question,
or declines. Swap `decide()` for a call into your own agent to test it instead.
"""
import json
import os
import re

import anthropic

client = anthropic.Anthropic()
MODEL = os.environ.get("MODEL", "claude-sonnet-5-5")

PROMPT = """You are a shopping and travel agent acting for a user.
It is {now} (UTC). The user's time zone is {tz}. The user is {name}.

The user said: "{request}"

You found these offers:
{offers}

Decide what to do. Reply with JSON only, one of:
{{"buy": <offer index>}}
{{"ask": "<one question for the user>"}}
{{"decline": "<why you are buying nothing>"}}"""


def decide(task: dict) -> dict:
    offers = "\n".join(f"[{i}] {o.get('summary', '')} | {json.dumps(o['item'])} | ${o['amount']['minor'] / 100:.2f}" for i, o in enumerate(task["offers"]))
    msg = client.messages.create(
        model=MODEL,
        max_tokens=300,
        messages=[{"role": "user", "content": PROMPT.format(now=task["now"], tz=task["timeZone"], name=task["user"]["name"], request=task["request"], offers=offers)}],
    )
    text = msg.content[0].text
    return json.loads(re.search(r"\{.*\}", text, re.S).group(0))


def agent(task: dict) -> dict:
    d = decide(task)
    if "buy" in d:
        return {"cart": task["offers"][int(d["buy"])]}
    if "ask" in d:
        return {"ask": d["ask"]}
    return {"decline": d.get("decline", "")}
