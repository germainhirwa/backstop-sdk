/**
 * Writes the shared test cases every Backstop SDK must reproduce exactly:
 *   conformance/fixtures.json     inputs and expected outputs from the TypeScript reference
 *   python/backstop_sdk/suite.json  the 50-task Agent Mistake Test, with ground truth
 * Run: npx tsx scripts/fixtures.ts
 */
import { writeFileSync } from "node:fs";
import { Backstop } from "../src/backstop.js";
import { suite } from "../src/eval/index.js";
import { truthFor } from "../src/eval/suite.js";
import { buildIntentBody, summarize } from "../src/intent.js";
import { flight, nothing, restaurant, retail } from "../src/packs/index.js";
import { canonical, compareNames, formatDate, formatMoney, formatTime, money, normalizeName, resolveDate, sha256, usd } from "../src/primitives.js";
import { generateKeys } from "../src/record.js";
import { evaluate, must, prefer, prefers, type Cart, type Rule } from "../src/rules.js";

const NOW = "2026-11-11T15:00:00.000Z";
const NY = "America/New_York";

// Dates
const dateCases: [string, string, string][] = [];
for (const now of [NOW, "2026-11-12T04:30:00.000Z", "2026-11-14T15:00:00.000Z", "2026-11-15T15:00:00.000Z", "2026-11-16T15:00:00.000Z", "2026-12-30T15:00:00.000Z"]) {
  for (const tz of [NY, "UTC", "America/Los_Angeles", "Asia/Tokyo"]) {
    for (const text of ["today", "tonight", "tomorrow", "day after tomorrow", "in 3 days", "in two weeks", "in a week", "friday", "this Friday", "next Friday", "on monday", "next Sunday", "coming wed", "this coming Thursday", "Sat", "Nov 20", "November 20th", "20 November", "3rd of Dec, 2027", "Jan 5", "Feb 30", "11/20", "3/4", "13/4", "3/4/27", "2026-11-20", "2026-02-30", "fly out next Friday morning", "something soon", "book it for Tues the latest"]) {
      dateCases.push([text, tz, now]);
    }
  }
}
const dates = dateCases.map(([text, timeZone, now]) => ({ text, timeZone, now, result: resolveDate(text, { timeZone, now: new Date(now) }) }));

// Names
const namePairs: [string, string][] = [["Maya Okafor", "OKAFOR/MAYA"], ["Maya Okafor", "Okafor, Maya"], ["Zoë Okafor-Reyes", "Zoe Okafor Reyes"], ["Maya Anne Okafor", "Maya Okafor"], ["Maya Okafor", "Maya Okafur"], ["Maya Okafor", "Dana Whitfield"], ["Dr. Maya Okafor", "maya okafor"], ["José Álvarez", "Jose Alvarez"], ["Maya Okafor", "Mya Okafr"], ["Li Na", "Li Ma"], ["Ngozi Okafor", "Ngozi A. Okafor"], ["O'Brien, Pat", "Pat OBrien"]];
const names = namePairs.map(([a, b]) => ({ a, b, result: compareNames(a, b), normalized: [normalizeName(a), normalizeName(b)] }));

// Formatting
const moneyCases: [number, string][] = [[362, "USD"], [139.99, "USD"], [1234.5, "USD"], [0, "USD"], [0.5, "USD"], [1000000, "USD"], [19.999, "USD"], [400, "EUR"], [12.5, "GBP"], [5000, "JPY"], [99.99, "CAD"], [250000, "RWF"], [10.005, "USD"], [1.005, "USD"]];
const format = {
  money: moneyCases.map(([amount, currency]) => { const m = money(amount, currency); return { amount, currency, value: m, text: formatMoney(m) }; }),
  dates: ["2026-11-20", "2026-01-05", "2027-12-31", "2026-02-09"].map((d) => ({ date: d, text: formatDate(d) })),
  times: ["06:00", "12:00", "00:05", "13:40", "23:59", "07:05"].map((t) => ({ time: t, text: formatTime(t) })),
};

// Lint and summaries
const lintInputs = [
  { request: "Book me a flight from JFK to Austin on Nov 20, morning. Under $400, refundable, aisle seat.", wants: flight.wants({ from: "JFK", to: "AUS", date: "2026-11-20", departs: ["06:00", "12:00"], maxPrice: usd(400), refundable: true, passenger: "Maya Okafor", seat: prefer("aisle") }) },
  { request: "Book me JFK to Austin next Friday morning, under $400, refundable", wants: flight.wants({ from: "JFK", to: "AUS", date: "2026-11-27", maxPrice: usd(450), passenger: "Maya Okafor" }) },
  { request: "Book JFK to Austin next Friday, under $400", wants: flight.wants({ from: "JFK", to: "AUS", date: "2026-11-20", maxPrice: usd(400), passenger: "Maya Okafor" }) },
  { request: "Book JFK to Austin next Friday, under $400", wants: flight.wants({ from: "JFK", to: "AUS", date: "2026-11-13", maxPrice: usd(400), passenger: "Maya Okafor" }), clarifications: [{ question: "Which Friday?", answer: "this week" }] },
  { request: "Any good dinner spots near Union Square on Friday?", wants: restaurant.wants({ date: "2026-11-13", partySize: 2, maxDeposit: usd(200) }) },
  { request: "Order two packs of the AA batteries, under $30", wants: retail.wants({ product: "AA batteries 8-pack", quantity: 1, maxTotal: usd(30) }) },
  { request: "Get me the black Pegasus in a 10", wants: retail.wants({ product: "Nike Pegasus 41", variant: { size: "10", color: "black" } }) },
  { request: "Book the Marriott for the 20th, free cancellation, budget of 1.5k", wants: { allow: ["hotel.book"], rules: [must.on("item.checkIn", "2026-11-20", "Check-in")] } },
  { request: "Buy a non-refundable ticket to Miami tomorrow for $180", wants: flight.wants({ from: "JFK", to: "MIA", date: "2026-11-12", maxPrice: usd(180), passenger: "Maya Okafor" }) },
  { request: "What are the cancellation terms on my Delta flight to Austin?", wants: nothing() },
  { request: "Can you book me a table for 4 at Lilia this Saturday at 7?", wants: restaurant.wants({ venue: "Lilia", date: "2026-11-14", time: ["18:30", "19:30"], partySize: 4 }) },
  { request: "Reserve 3 pairs of the wool socks, no more than $60, here by 11/18", wants: retail.wants({ product: "Wool socks", quantity: 3, maxTotal: usd(75), deliverBy: "2026-11-18" }) },
];
const lint = lintInputs.map((i) => {
  const body = buildIntentBody({ user: "u_1", timeZone: NY, now: new Date(NOW), ...i });
  return { input: { request: i.request, wants: i.wants, clarifications: i.clarifications ?? [] }, warnings: body.warnings, summary: summarize(body), body };
});

// Rule findings: every offer of every suite task against its ground truth, plus hand-picked edge cases.
const extraRules: Rule[] = [
  must.eq("item.cabin", "Economy", "Cabin"), must.oneOf("merchant", ["Nike", "Foot Locker"], "Seller"), must.atMost("item.stops", 1, "Stops"), must.atLeast("item.rating", 4.5, "Rating"),
  must.between("item.nights", 2, 4, "Nights"), must.between("item.departs", "06:00", "12:00", "Departure time"), must.costsAtMost(money(400, "EUR")), must.on("item.date", "2026-11-20"),
  must.by("item.arrives", "2026-11-18"), must.named("item.passenger", "Maya Okafor", "Passenger"), must.is("item.refundable", true, "Refundable"), prefers.eq("item.seat", "aisle", "Seat"),
  must.eq("item.quantity", 2, "Quantity"), must.eq("item.flag", true, "Flag"),
];
const extraCarts: Cart[] = [
  { action: "x.buy", amount: money(380, "EUR"), merchant: "nike", item: { cabin: " economy ", stops: 1, rating: 4.5, nights: 3, departs: "07:05", date: "2026-11-20", arrives: "2026-11-18", passenger: "OKAFOR/MAYA", refundable: true, seat: "Aisle", quantity: 2, flag: true } },
  { action: "x.buy", amount: usd(380), merchant: "Amazon", item: { cabin: "First", stops: 2, rating: 4.2, nights: 5, departs: "13:40", date: "2026-12-04", arrives: "2026-11-19", passenger: "Maya Okafur", refundable: false, seat: "window", quantity: "2", flag: 1 } },
  { action: "x.buy", amount: money(455.5, "EUR"), item: { stops: "1", rating: "4.9", nights: "3", departs: 700, date: "20 Nov", arrives: "", passenger: "Dana Whitfield", refundable: null, quantity: 2.0, flag: "true" } },
  { action: "x.buy", amount: money(400, "EUR"), merchant: "Foot Locker", item: { cabin: "ECONOMY", stops: 0, rating: 5, nights: 2, departs: "06:00", date: "2026-11-13", arrives: "2026-11-01", passenger: "Maya A. Okafor", refundable: true, seat: "aisle", quantity: 3, flag: false } },
];
const findings: unknown[] = [];
for (const cart of extraCarts) findings.push({ rules: extraRules, cart, cartHash: await sha256(canonical(cart)), findings: extraRules.map((r) => evaluate(r, cart)) });

const verdicts: unknown[] = [];
for (const task of suite) {
  const now = new Date(task.now);
  const judge = new Backstop({ now: () => now, policy: { askOnWarnings: false }, guarantee: "sandbox" });
  const wants = truthFor(task.id).wants;
  const intent = await judge.intent({ user: task.user.id, request: task.request, timeZone: task.timeZone, wants, maxAttempts: 1000 });
  for (const cart of task.offers) {
    findings.push({ rules: wants.rules, cart, cartHash: await sha256(canonical(cart)), findings: wants.rules.map((r) => evaluate(r, cart)) });
    const v = await judge.check(intent, cart);
    verdicts.push({ task: task.id, cart, status: v.status, forAgent: v.forAgent, question: v.question, reasons: v.reasons, asks: v.asks, guarantee: v.guarantee });
  }
}

// A signed record and the claim decisions that follow from it.
const keys = await generateKeys();
let t = Date.parse(NOW);
const b = new Backstop({ keys, guarantee: "sandbox", now: () => new Date((t += 1000)) });
const ask = { user: "u_1", request: "Book me a flight from JFK to Austin on Nov 20, morning. Under $400, refundable, aisle seat.", timeZone: NY, wants: lintInputs[0]!.wants };
const offer = { from: "JFK", to: "AUS", date: "2026-11-20", departs: "07:05", price: usd(362), refundable: true, passenger: "Maya Okafor", seat: "window", airline: "Delta", flight: "DL 1102" };
const acked = await b.acknowledge(await b.intent(ask), { method: "tapped confirm" });
const asked = await b.check(acked, flight.cart(offer));
const passed = await b.resolve(asked, { approved: true });
const done = await b.commit(passed, { id: "DL-CONF-8841", amount: usd(371) });
const b2 = new Backstop({ keys, now: () => new Date((t += 1000)) });
const unacked = await b2.commit(await b2.check(await b2.intent(ask), flight.cart({ ...offer, seat: "aisle" })), { id: "DL-CONF-9", item: { refundable: false } });
const blockedOnly = await b2.check(await b2.intent(ask), flight.cart({ ...offer, price: usd(999) }));
const tampered = structuredClone(done.chain);
(tampered[0]!.body as { request: string }).request = "Book the cheapest flight, any day";
const claimCases = [
  { name: "changed mind", chain: done.chain, reason: "changed_mind" },
  { name: "merchant fault", chain: done.chain, reason: "merchant_fault" },
  { name: "matches acknowledged", chain: done.chain, reason: "not_what_i_asked" },
  { name: "delivered differs", chain: done.chain, reason: "not_what_i_asked", delivered: { item: { date: "2026-11-27" } } },
  { name: "drift recorded at commit", chain: unacked.chain, reason: "not_what_i_asked" },
  { name: "never cleared", chain: blockedOnly.chain, reason: "not_what_i_asked" },
  { name: "tampered", chain: tampered, reason: "not_what_i_asked" },
] as const;
const claims = [];
for (const c of claimCases) {
  const d = await b.claim({ chain: c.chain as never, reason: c.reason, delivered: "delivered" in c ? c.delivered : undefined });
  claims.push({ ...c, decision: d });
}
const chain = { publicKey: keys.publicKey, keyId: keys.keyId, chain: done.chain, types: done.chain.map((e) => e.type), commit: { status: done.status, changed: done.changed }, verify: await b.verify(done.chain), tamperedVerify: await b.verify(tampered) };

writeFileSync("conformance/fixtures.json", JSON.stringify({ about: "Reference outputs from the TypeScript SDK. Every Backstop SDK must reproduce these exactly.", dates, names, format, lint, findings, verdicts, chain, claims }, null, 1) + "\n");
writeFileSync("python/backstop_sdk/suite.json", JSON.stringify({ tasks: suite, truth: Object.fromEntries(suite.map((s) => [s.id, truthFor(s.id).wants])) }, null, 1) + "\n");
console.log(`dates ${dates.length}, names ${names.length}, lint ${lint.length}, findings ${findings.length}, verdicts ${verdicts.length}, claims ${claims.length}`);
