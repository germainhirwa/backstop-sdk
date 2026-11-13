import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { Backstop } from "../src/index.js";
import { cheapestAgent, formatReport, runEval, suite, type Agent } from "../src/eval/index.js";
import { truthFor } from "../src/eval/suite.js";
import { callTool, type McpState } from "../src/mcp.js";

test("the suite has 50 tasks and every one is solvable by a careful agent", async () => {
  assert.equal(suite.length, 50);
  assert.equal(new Set(suite.map((t) => t.id)).size, 50);
  // An oracle that knows the ground truth must score 50/50. This proves no task is broken.
  const oracle: Agent = async (task) => {
    const b = new Backstop({ now: () => new Date(task.now), policy: { askOnWarnings: false } });
    const intent = await b.intent({ user: task.user.id, request: task.request, timeZone: task.timeZone, wants: truthFor(task.id).wants, maxAttempts: 100 });
    let ask: string | null = null;
    for (const offer of task.offers) {
      const v = await b.check(intent, offer);
      if (v.status === "pass") return { cart: offer };
      if (v.status === "ask") ask = v.question;
    }
    return ask ? { ask } : { decline: "Nothing fits." };
  };
  const report = await runEval(oracle);
  assert.equal(report.counts.correct, 50, formatReport(report));
});

test("a careless agent scores badly, and its own captured intent catches the mistakes", async () => {
  const careless = await runEval(cheapestAgent);
  assert.ok(careless.wrongPurchaseRate > 0.7);
  assert.equal(careless.backstop, null);
  assert.match(formatReport(careless), /Wrong purchases\s+\d+/);

  // Same careless buying, but the agent captured the request properly: every wrong purchase is stopped.
  const guarded: Agent = async (task) => {
    const answer = await cheapestAgent(task);
    return "cart" in answer ? { cart: answer.cart, intent: { user: task.user.id, request: task.request, timeZone: task.timeZone, wants: truthFor(task.id).wants } } : answer;
  };
  const report = await runEval(guarded);
  assert.ok(report.backstop);
  assert.equal(report.backstop.caught, report.backstop.wrongWithIntent);
  assert.equal(report.backstop.wrongWithIntent, report.counts.wrong_purchase);
});

test("MCP tools: capture, block, fix, pass, confirm", async () => {
  const state: McpState = { backstop: new Backstop({ now: () => new Date("2026-11-11T15:00:00Z"), guarantee: "sandbox" }), intents: new Map(), verdicts: new Map() };
  const cap = await callTool(state, "backstop_capture_intent", {
    user: "u_1", request: "Book JFK to Austin on Nov 20, under $400, aisle if possible", timeZone: "America/New_York", pack: "flight",
    wants: { from: "JFK", to: "AUS", date: "2026-11-20", maxPrice: 400, passenger: "Maya Okafor", seat: { prefer: "aisle" } },
  });
  assert.match(String(cap.summary), /I'll book a flight: origin JFK/);
  const cart = { from: "JFK", to: "AUS", date: "2026-11-20", departs: "07:05", price: "$486", refundable: true, passenger: "Maya Okafor", seat: "aisle" };
  const blocked = await callTool(state, "backstop_check_cart", { intentId: cap.intentId, pack: "flight", cart });
  assert.equal(blocked.status, "block");
  const ask = await callTool(state, "backstop_check_cart", { intentId: cap.intentId, pack: "flight", cart: { ...cart, price: 362, seat: "window" } });
  assert.equal(ask.status, "ask");
  const pass = await callTool(state, "backstop_check_cart", { intentId: cap.intentId, pack: "flight", cart: {}, approved: true });
  assert.equal(pass.status, "pass");
  const done = await callTool(state, "backstop_confirm_order", { intentId: cap.intentId, orderId: "CONF1", amount: 362 });
  assert.equal(done.status, "confirmed");
  const d = await callTool(state, "backstop_resolve_date", { phrase: "tomorrow", timeZone: "UTC" });
  assert.match(String(d.date), /^\d{4}-\d{2}-\d{2}$/);
  await assert.rejects(callTool(state, "backstop_check_cart", { intentId: "nope", pack: "flight", cart }), /Call backstop_capture_intent first/);
});

test("MCP server speaks JSON-RPC over stdio", async () => {
  const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "mcp"], { stdio: ["pipe", "pipe", "inherit"] });
  const replies: Record<string, any>[] = [];
  const got = (n: number) => new Promise<void>((res, rej) => {
    const timer = setTimeout(() => rej(new Error("MCP server did not answer")), 15_000);
    let buf = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split("\n");
      buf = lines.pop()!;
      for (const l of lines) if (l.trim()) replies.push(JSON.parse(l));
      if (replies.length >= n) { clearTimeout(timer); res(); }
    });
  });
  const wait = got(3);
  const send = (m: object) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
  send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } });
  send({ method: "notifications/initialized" });
  send({ id: 2, method: "tools/list" });
  send({ id: 3, method: "tools/call", params: { name: "backstop_capture_intent", arguments: { user: "u", request: "What's the baggage policy?", timeZone: "UTC", pack: "none" } } });
  await wait;
  child.kill();
  assert.equal(replies[0]!.result.serverInfo.name, "backstop");
  assert.equal(replies[1]!.result.tools.length, 4);
  assert.deepEqual(replies[2]!.result.structuredContent.authorizes, []);
});

test("MCP: an answer the agent already got from the user is passed through, not asked again", async () => {
  const state: McpState = { backstop: new Backstop({ now: () => new Date("2026-11-11T15:00:00Z") }), intents: new Map(), verdicts: new Map() };
  const cap = await callTool(state, "backstop_capture_intent", { user: "u", request: "Book JFK to Austin next Friday, morning, under $400", timeZone: "America/New_York", pack: "flight",
    wants: { from: "JFK", to: "AUS", date: "2026-11-20", departs: ["05:00", "12:00"], maxPrice: 400, passenger: "Maya Okafor" } });
  assert.equal((cap.questionsForUser as string[]).length, 1);
  const cart = { from: "JFK", to: "AUS", date: "2026-11-20", departs: "06:30", price: 331, refundable: false, passenger: "Maya Okafor", url: "https://example.com/f/1" };
  const v = await callTool(state, "backstop_check_cart", { intentId: cap.intentId, pack: "flight", cart, userReply: "Nov 20" });
  assert.equal(v.status, "pass");
});
