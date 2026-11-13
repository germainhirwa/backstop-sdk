import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Backstop, BackstopBlocked, BackstopNeedsUser, compareNames, flight, generateKeys, must, nothing, prefer, resolveDate,
  restaurant, retail, usd, type FlightOffer,
} from "../src/index.js";

// Wednesday 11 Nov 2026, 10:00 in New York.
const NOW = new Date("2026-11-11T15:00:00Z");
const TZ = "America/New_York";
const mk = (o: ConstructorParameters<typeof Backstop>[0] = {}) => new Backstop({ now: () => NOW, ...o });

const ask = {
  user: "u_1",
  request: "Book me a flight from JFK to Austin on Nov 20, morning. Under $400, refundable, aisle seat.",
  timeZone: TZ,
  wants: flight.wants({ from: "JFK", to: "AUS", date: "2026-11-20", departs: ["06:00", "12:00"], maxPrice: usd(400), refundable: true, passenger: "Maya Okafor", seat: prefer("aisle") }),
};
const offer: FlightOffer = { from: "JFK", to: "AUS", date: "2026-11-20", departs: "07:05", price: usd(362), refundable: true, passenger: "Maya Okafor", seat: "aisle", airline: "Delta", flight: "DL 1102" };

test("resolveDate works in the user's zone, not the server's", () => {
  // 11:30pm Tuesday in Los Angeles is already Wednesday in UTC.
  const lateNight = new Date("2026-11-11T07:30:00Z");
  assert.equal(resolveDate("tomorrow", { timeZone: "America/Los_Angeles", now: lateNight })?.date, "2026-11-11");
  assert.equal(resolveDate("tomorrow", { timeZone: "UTC", now: lateNight })?.date, "2026-11-12");
});

test("resolveDate flags 'next Friday' as ambiguous midweek and plain on Saturday", () => {
  const wed = resolveDate("fly out next Friday", { timeZone: TZ, now: NOW })!;
  assert.deepEqual([wed.date, wed.ambiguous, wed.alternatives], ["2026-11-20", true, ["2026-11-13"]]);
  const sat = resolveDate("next Friday", { timeZone: TZ, now: new Date("2026-11-14T15:00:00Z") })!;
  assert.deepEqual([sat.date, sat.ambiguous], ["2026-11-20", false]);
  assert.equal(resolveDate("this friday", { timeZone: TZ, now: NOW })?.date, "2026-11-13");
  assert.equal(resolveDate("Jan 5", { timeZone: TZ, now: NOW })?.date, "2027-01-05");
  assert.equal(resolveDate("November 20th", { timeZone: TZ, now: NOW })?.date, "2026-11-20");
  assert.equal(resolveDate("in two weeks", { timeZone: TZ, now: NOW })?.date, "2026-11-25");
  assert.equal(resolveDate("3/4", { timeZone: TZ, now: NOW })?.ambiguous, true);
  assert.equal(resolveDate("something soon", { timeZone: TZ, now: NOW }), null);
});

test("names compare like a gate agent would", () => {
  assert.equal(compareNames("Maya Okafor", "OKAFOR/MAYA"), "exact");
  assert.equal(compareNames("Zoë Okafor-Reyes", "Zoe Okafor Reyes"), "exact");
  assert.equal(compareNames("Maya Anne Okafor", "Maya Okafor"), "middle_omitted");
  assert.equal(compareNames("Maya Okafor", "Maya Okafur"), "typo");
  assert.equal(compareNames("Maya Okafor", "Dana Whitfield"), "different");
});

test("a matching cart passes with a sandbox guarantee and a verifiable signed record", async () => {
  const keys = await generateKeys();
  const b = mk({ keys, guarantee: "sandbox" });
  const intent = await b.intent(ask);
  assert.deepEqual(intent.warnings, []);
  const v = await b.check(intent, flight.cart(offer));
  assert.equal(v.status, "pass");
  assert.equal(v.guarantee?.status, "sandbox");
  assert.deepEqual(v.guarantee?.coverage, usd(650));
  assert.deepEqual(await b.verify(v.chain), { ok: true, signed: true, problems: [] });

  const tampered = structuredClone(v.chain);
  (tampered[0]!.body as { request: string }).request = "Book the cheapest flight, any day";
  const bad = await b.verify(tampered);
  assert.equal(bad.ok, false);
  assert.match(bad.problems[0]!, /changed after sealing/);
});

test("wrong week, over budget, non-refundable and wrong name are blocked with fixes", async () => {
  const b = mk();
  const intent = await b.intent(ask);
  const week = await b.check(intent, flight.cart({ ...offer, date: "2026-11-27" }));
  assert.equal(week.status, "block");
  assert.equal(week.reasons[0]!.code, "date_mismatch");
  assert.match(week.reasons[0]!.message, /exactly 1 week off/);
  assert.match(week.forAgent, /Pick an option on Fri, Nov 20/);

  const multi = await b.check(intent, flight.cart({ ...offer, price: usd(486), refundable: false, passenger: "Maya Okafur" }));
  assert.deepEqual(multi.reasons.map((r) => r.code).sort(), ["mismatch", "name_typo", "over_limit"]);
  assert.match(multi.reasons.find((r) => r.code === "over_limit")!.message, /\$86 over the \$400 limit/);
  assert.equal(multi.guarantee, null);
});

test("missing fields fail closed", async () => {
  const b = mk();
  const cart = flight.cart(offer);
  delete cart.item.refundable;
  const v = await b.check(await b.intent(ask), cart);
  assert.equal(v.status, "block");
  assert.equal(v.reasons[0]!.code, "missing_field");
});

test("a preference miss asks one question; yes passes, no blocks", async () => {
  const b = mk({ guarantee: "sandbox" });
  const v = await b.check(await b.intent(ask), flight.cart({ ...offer, seat: "window" }));
  assert.equal(v.status, "ask");
  assert.match(v.question!, /Seat: this option has window, and you asked for aisle/);
  const yes = await b.resolve(v, { approved: true });
  assert.equal(yes.status, "pass");
  assert.equal(yes.chain.map((e) => e.type).join(">"), "intent>verdict>resolution>verdict");
  assert.equal((await b.verify(yes.chain)).ok, true);
  const no = await b.resolve(v, { approved: false });
  assert.equal(no.status, "block");
});

test("an information request authorizes nothing (cancel-instead-of-look-up)", async () => {
  const b = mk();
  const intent = await b.intent({ user: "u_1", request: "What are the cancellation terms on my Delta flight to Austin?", timeZone: TZ, wants: nothing() });
  const v = await b.check(intent, flight.cancel({ flight: "DL 1102", forfeits: usd(412) }));
  assert.equal(v.status, "block");
  assert.equal(v.reasons[0]!.code, "action_not_authorized");
  assert.match(v.forAgent, /Do not cancel a flight\. Answer the user's question instead/);
});

test("lint catches intent capture errors from the user's own words", async () => {
  const b = mk();
  // The agent resolved "next Friday" on a UTC server a week late.
  const wrongWeek = await b.intent({ ...ask, request: "Book me JFK to Austin next Friday morning, under $400, refundable", wants: flight.wants({ from: "JFK", to: "AUS", date: "2026-11-27", maxPrice: usd(450), passenger: "Maya Okafor" }) });
  assert.deepEqual(wrongWeek.warnings.map((w) => w.code), ["date_differs_from_request", "budget_differs_from_request", "refundable_not_captured"]);

  // The cart matches the wrong intent, but the check still stops to ask, because the words disagree.
  const v = await b.check(wrongWeek, flight.cart({ ...offer, date: "2026-11-27" }));
  assert.equal(v.status, "ask");
  assert.match(v.question!, /You said "next Friday"/);

  const question = await b.intent({ user: "u_1", request: "Any good dinner spots near Union Square on Friday?", timeZone: TZ, wants: restaurant.wants({ date: "2026-11-13", partySize: 2, maxDeposit: usd(200) }) });
  assert.ok(question.warnings.some((w) => w.code === "request_reads_as_question"));

  const qty = await b.intent({ user: "u_1", request: "Order two packs of the AA batteries, under $30", wants: retail.wants({ product: "AA batteries 8-pack", quantity: 1, maxTotal: usd(30) }) });
  assert.ok(qty.warnings.some((w) => w.code === "quantity_differs_from_request"));

  const ambiguous = await b.intent({ ...ask, request: "Book JFK to Austin next Friday, under $400", wants: flight.wants({ from: "JFK", to: "AUS", date: "2026-11-20", maxPrice: usd(400), passenger: "Maya Okafor" }) });
  assert.deepEqual(ambiguous.warnings.map((w) => w.code), ["ambiguous_date"]);
  assert.deepEqual((await b.acknowledge(ambiguous)).questions, []);
});

test("retries can't double-buy, and runaway retries lock the intent", async () => {
  const b = mk();
  const intent = await b.intent(ask);
  const first = await b.check(intent, flight.cart(offer));
  await b.commit(first, { id: "CONF123" });
  const again = await b.check(intent, flight.cart(offer));
  assert.equal(again.reasons[0]!.code, "duplicate_order");

  const flood = await b.intent({ ...ask, maxAttempts: 3 });
  for (let i = 0; i < 3; i++) await b.check(flood, flight.cart({ ...offer, price: usd(500) }));
  assert.equal((await b.check(flood, flight.cart(offer))).reasons[0]!.code, "too_many_attempts");
});

test("commit detects drift between the checked cart and the confirmed order", async () => {
  const b = mk();
  const v = await b.check(await b.intent(ask), flight.cart(offer));
  const ok = await b.commit(v, { id: "CONF1", amount: usd(371) });
  assert.deepEqual([ok.status, ok.changed], ["confirmed", ["amount"]]);

  const v2 = await b.check(await b.intent(ask), flight.cart(offer));
  const drift = await b.commit(v2, { id: "CONF2", amount: usd(415), item: { refundable: false } });
  assert.equal(drift.status, "drift");
  assert.deepEqual(drift.violations.map((x) => x.field).sort(), ["amount", "item.refundable"]);
  assert.match(drift.forAgent, /Cancel or correct it now/);
  await assert.rejects(b.commit(await b.check(await b.intent(ask), flight.cart({ ...offer, date: "2026-11-27" }))), /Only a passed check/);
});

test("claims are decided by replaying the record", async () => {
  const keys = await generateKeys();
  const b = mk({ keys, guarantee: "sandbox" });
  const intent = await b.acknowledge(await b.intent(ask));
  const v = await b.check(intent, flight.cart(offer));
  const done = await b.commit(v, { id: "CONF1" });

  const changedMind = await b.claim({ chain: done.chain, reason: "changed_mind" });
  assert.deepEqual([changedMind.status, changedMind.basis], ["denied", "matches_request"]);
  const airline = await b.claim({ chain: done.chain, reason: "merchant_fault" });
  assert.equal(airline.basis, "merchant_responsibility");
  const matches = await b.claim({ chain: done.chain, reason: "not_what_i_asked" });
  assert.deepEqual([matches.status, matches.basis], ["denied", "matches_acknowledged_request"]);

  const wrongTicket = await b.claim({ chain: done.chain, reason: "not_what_i_asked", delivered: { item: { date: "2026-11-27" } } });
  assert.deepEqual([wrongTicket.status, wrongTicket.basis], ["approved", "delivered_differs_from_request"]);
  assert.deepEqual(wrongTicket.payableUpTo, usd(650));

  const forged = structuredClone(done.chain);
  (forged[0]!.body as { rules: unknown[] }).rules = [];
  assert.equal((await b.claim({ chain: forged, reason: "not_what_i_asked" })).basis, "record_invalid");

  // Without an acknowledgement, a matching order goes to a person, because the capture itself may be wrong.
  const b2 = mk();
  const unacked = await b2.commit(await b2.check(await b2.intent(ask), flight.cart(offer)));
  assert.equal((await b2.claim({ chain: unacked.chain, reason: "not_what_i_asked" })).basis, "summary_not_acknowledged");
  const blockedOnly = await b2.check(await b2.intent(ask), flight.cart({ ...offer, price: usd(999) }));
  assert.equal((await b2.claim({ chain: blockedOnly.chain, reason: "not_what_i_asked" })).basis, "never_cleared");
});

test("protect() wraps a purchase tool end to end", async () => {
  const b = mk();
  const intent = await b.intent(ask);
  let charged = 0;
  const book = b.protect(
    async (o: FlightOffer) => { charged++; return { confirmation: "CONF9", total: o.price, fare: o.refundable }; },
    { intent: () => intent, cart: (o) => flight.cart(o), order: (r) => ({ id: r.confirmation, amount: r.total }) },
  );
  await assert.rejects(book({ ...offer, date: "2026-11-27" }), (e: unknown) => e instanceof BackstopBlocked && /Pick an option on Fri, Nov 20/.test(e.message));
  await assert.rejects(book({ ...offer, seat: "middle" }), BackstopNeedsUser);
  assert.equal(charged, 0);
  assert.equal((await book(offer)).confirmation, "CONF9");
  assert.equal(charged, 1);
  await assert.rejects(book(offer), /already produced an order/);
  assert.equal(charged, 1);
});

test("retail and restaurant packs, custom rules and policy", async () => {
  const b = mk({ policy: { askAbove: usd(500) } });
  const shoes = await b.intent({
    user: "u_2", request: "Buy the Pegasus 41 in size 10, black, from Nike. Max $150, here by Nov 18.", timeZone: TZ,
    wants: retail.wants({ product: "Pegasus 41", variant: { size: "10", color: "black" }, merchant: "Nike", maxTotal: usd(150), deliverBy: "2026-11-18" }),
    also: [must.is("item.returnable", true, "Returnable")],
  });
  const base = { product: "Pegasus 41", merchant: "Nike", variant: { size: "10", color: "Black" }, quantity: 1, total: usd(139.99), arrives: "2026-11-16" };
  const good = retail.cart(base);
  good.item.returnable = true;
  assert.equal((await b.check(shoes, good)).status, "pass");
  const bad = retail.cart({ ...base, merchant: "SneakerDealz", variant: { size: "10.5", color: "black" }, quantity: 2, arrives: "2026-11-21" });
  bad.item.returnable = true;
  assert.deepEqual((await b.check(shoes, bad)).reasons.map((r) => r.code).sort(), ["mismatch", "mismatch", "not_allowed", "too_late"]);

  const dinner = await b.intent({ user: "u_2", request: "Reserve a table for 2 at Carbone on Nov 13 around 8pm", timeZone: TZ, wants: restaurant.wants({ venue: "Carbone", date: "2026-11-13", time: ["19:30", "20:30"], partySize: 2 }) });
  const hold = await b.check(dinner, restaurant.cart({ venue: "Carbone", date: "2026-11-13", time: "20:00", partySize: 2, deposit: usd(200) }));
  assert.match(hold.reasons[0]!.message, /\$200 is \$200 over the \$0 limit/);

  const pricey = await b.intent({ ...ask, wants: flight.wants({ from: "JFK", to: "LHR", date: "2026-11-20", maxPrice: usd(900), passenger: "Maya Okafor" }), request: "Book JFK to London on Nov 20, under $900" });
  const v = await b.check(pricey, flight.cart({ ...offer, to: "LHR", price: usd(840) }));
  assert.deepEqual([v.status, v.asks[0]!.key], ["ask", "policy:askAbove"]);
});

test("free text from a site: extra words ask the user, wrong words block", async () => {
  const b = mk();
  const shoes = await b.intent({ user: "u_3", request: "Buy the Nike Pegasus 41 in black, men's size 10, under $150.", timeZone: TZ,
    wants: retail.wants({ product: "Pegasus 41", variant: { size: "10", color: "black" }, maxTotal: usd(150) }) });
  const base = { product: "Nike Air Zoom Pegasus 41", merchant: "Foot Locker", variant: { size: "Men's 10 (D - Medium)", color: "Black/Medium Ash/Pure Platinum" }, quantity: 1, total: usd(109.99) };
  const v = await b.check(shoes, retail.cart(base));
  assert.equal(v.status, "ask");
  assert.deepEqual(v.findings.filter((f) => f.code === "partial_match").map((f) => f.field), ["item.product", "item.variant.size", "item.variant.color"]);
  assert.equal(v.asks.length, 1);
  assert.match(v.question!, /color is Black\/Medium Ash\/Pure Platinum \(you asked for black\)\. Is that what you want\?$/);
  const wrong = await b.check(shoes, retail.cart({ ...base, variant: { size: "10.5", color: "Black" } }));
  assert.deepEqual([wrong.status, wrong.reasons.map((r) => r.field)], ["block", ["item.variant.size"]]);
  assert.equal((await b.check(shoes, retail.cart({ ...base, product: "Pegasus 41", variant: { size: "10", color: "BLACK" } }))).status, "pass");
  const yes = await b.resolve(v, { approved: true });
  assert.equal(yes.status, "pass");
  // The agent checks the same cart again later: the user's yes still stands, for that exact cart only.
  assert.equal((await b.check(shoes, retail.cart(base))).status, "pass");
  assert.equal((await b.check(shoes, retail.cart({ ...base, total: usd(119.99) }))).status, "ask");
  assert.equal((await b.commit(yes, { id: "FL-1" })).status, "confirmed");
});

test("block messages never hand the agent a value to type into the cart", async () => {
  const b = mk();
  const i = await b.intent(ask);
  const v = await b.check(i, flight.cart({ ...offer, from: "LGA", passenger: "Dana Whitfield", refundable: false }));
  assert.doesNotMatch(v.forAgent, /Change |Use JFK|Include /);
  assert.match(v.forAgent, /Don't change how the cart describes the merchant's option/);
  const empty = await b.check(i, { action: "flight.book", amount: usd(300), item: { flight: { from: "JFK" } } });
  assert.match(empty.forAgent, /The cart is missing \d+ fields this request depends on \(item\.from, item\.to, item\.date/);
});

test("an agent rewriting a flagged field on the same offer has to ask the user", async () => {
  const b = mk();
  const i = await b.intent({ user: "u_3", request: "Buy the Pegasus 41 in black, size 10. Max $150.", timeZone: TZ,
    wants: retail.wants({ product: "Pegasus 41", variant: { size: "10", color: "black" }, maxTotal: usd(150) }) });
  const ref = "https://shop.example/p/pegasus-41-fd2722";
  const real = { product: "Pegasus 41", merchant: "Shop", variant: { size: "10", color: "White" }, quantity: 1, total: usd(101), ref };
  assert.equal((await b.check(i, retail.cart(real))).status, "block");
  const rewritten = await b.check(i, retail.cart({ ...real, variant: { size: "10", color: "Black" } }));
  assert.equal(rewritten.status, "ask");
  assert.equal(rewritten.asks[0]!.key, "edited:item.variant.color");
  assert.match(rewritten.question!, /your agent changed how it described it: color from White to Black\. Go ahead only if the merchant's page shows the new value/);
  // Filling in fields that were missing is not an edit.
  const late = { ...real, ref: ref + "-late" };
  assert.equal((await b.check(i, { action: "retail.purchase", amount: usd(101), item: {}, ref: late.ref })).status, "block");
  assert.equal((await b.check(i, retail.cart({ ...late, variant: { size: "10", color: "Black" } }))).status, "pass");
  // A different offer is not an edit.
  assert.equal((await b.check(i, retail.cart({ ...real, variant: { size: "10", color: "Black" }, ref: ref + "-black" }))).status, "pass");
});

test("the user's reply in your own chat clears the intent's questions", async () => {
  const b = mk();
  const i = await b.intent({ ...ask, request: "Book JFK to Austin next Friday, morning, under $400", wants: flight.wants({ from: "JFK", to: "AUS", date: "2026-11-20", departs: ["06:00", "12:00"], maxPrice: usd(400), passenger: "Maya Okafor" }) });
  assert.equal(i.questions.length, 1);
  assert.equal((await b.check(i, flight.cart(offer))).status, "ask");
  const answered = await b.acknowledge(i, { method: "chat", answers: [{ question: i.questions[0]!, answer: "Nov 20" }] });
  assert.equal((await b.check(answered, flight.cart(offer))).status, "pass");
  assert.deepEqual((answered.chain.at(-1)!.body as { answers: unknown[] }).answers, [{ question: i.questions[0], answer: "Nov 20" }]);
});
