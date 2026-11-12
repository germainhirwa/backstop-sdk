// Run: npx tsx examples/quickstart.ts
import { Backstop, flight, generateKeys, prefer, usd } from "backstop-sdk";

const backstop = new Backstop({ keys: await generateKeys(), guarantee: "sandbox" });

// 1. Capture what the user asked for, in their words and as fields.
const intent = await backstop.intent({
  user: "user_123",
  request: "Book me JFK to Austin on Nov 20, morning, under $400, refundable. Aisle if you can.",
  timeZone: "America/New_York",
  wants: flight.wants({
    from: "JFK", to: "AUS", date: "2026-11-20",
    departs: ["06:00", "12:00"], maxPrice: usd(400), refundable: true,
    passenger: "Maya Okafor", seat: prefer("aisle"),
  }),
});
console.log(intent.summary);

// 2. Right before paying, check the cart the agent built.
const wrongWeek = flight.cart({ from: "JFK", to: "AUS", date: "2026-11-27", departs: "07:05", price: usd(362), refundable: true, passenger: "Maya Okafor", seat: "aisle", airline: "Delta", flight: "DL 1102" });
let verdict = await backstop.check(intent, wrongWeek);
console.log(verdict.status);   // "block"
console.log(verdict.forAgent); // hand this back to the model

// The agent fixes the date and tries again.
verdict = await backstop.check(intent, { ...wrongWeek, item: { ...wrongWeek.item, date: "2026-11-20" } });
console.log(verdict.status, verdict.guarantee?.id); // "pass"

// 3. After the merchant confirms, compare the confirmation with what was checked.
const order = await backstop.commit(verdict, { id: "DL-CONF-8841", amount: usd(362) });
console.log(order.status);     // "confirmed"

// Later: decide a claim by replaying the signed record.
const claim = await backstop.claim({ chain: order.chain, reason: "not_what_i_asked", delivered: { item: { date: "2026-11-27" } } });
console.log(claim.status, claim.basis); // "approved" "delivered_differs_from_request"
