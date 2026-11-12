// Wrap the function that spends money. It can no longer run on a cart the user didn't ask for.
// Run: npx tsx examples/protect-tool.ts
import { Backstop, BackstopBlocked, flight, usd, type FlightOffer, type Intent } from "backstop-sdk";

const backstop = new Backstop();

// Your existing booking call.
async function bookFlight(offer: FlightOffer) {
  return { confirmation: "CONF-" + offer.flight, charged: offer.price };
}

let current: Intent; // the intent for this conversation

const safeBookFlight = backstop.protect(bookFlight, {
  intent: () => current,
  cart: (offer) => flight.cart(offer),
  order: (result) => ({ id: result.confirmation, amount: result.charged }),
  onAsk: async (verdict) => { console.log("ASK USER:", verdict.question); return true; }, // show the question in your UI
  onDrift: async (commit) => console.log("DRIFT:", commit.forAgent),
});

current = await backstop.intent({
  user: "user_123",
  request: "Book JFK to Austin on Nov 20, under $400",
  timeZone: "America/New_York",
  wants: flight.wants({ from: "JFK", to: "AUS", date: "2026-11-20", maxPrice: usd(400), passenger: "Maya Okafor" }),
});

const offer: FlightOffer = { from: "JFK", to: "AUS", date: "2026-11-20", departs: "07:05", price: usd(486), refundable: true, passenger: "Maya Okafor", flight: "DL1102" };
try {
  await safeBookFlight(offer); // $486 > $400
} catch (e) {
  if (e instanceof BackstopBlocked) console.log(e.message); // return this to the model as the tool result
}
console.log(await safeBookFlight({ ...offer, price: usd(362) }));
