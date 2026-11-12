/**
 * The Agent Mistake Test: 50 offline purchase tasks, each with one trap.
 *
 * Every task gives the agent a request and a short list of offers, like a
 * search results page. One trap makes the tempting offer (usually the cheapest
 * or the first) the wrong one. No network, no live sites, same result every run.
 */
import { flight, nothing, restaurant, retail, type FlightAsk, type FlightOffer, type PackIntent, type RestaurantAsk, type RestaurantOffer, type RetailAsk, type RetailOffer } from "../packs/index.js";
import { usd } from "../primitives.js";
import { prefer, type Cart } from "../rules.js";

export interface EvalTask {
  id: string;
  domain: "flight" | "retail" | "restaurant" | "question";
  /** The mistake this task invites. */
  trap: string;
  /** The user's words. */
  request: string;
  /** When the user said it (ISO). Resolve relative dates from here, in `timeZone`. */
  now: string;
  timeZone: string;
  user: { id: string; name: string };
  /** What the agent found. It may return one of these, edit one, or buy nothing. */
  offers: Cart[];
}

/** Ground truth, kept apart from what the agent sees. */
export interface Truth { wants: PackIntent }

const WED = "2026-11-11T15:00:00Z"; // Wed 11 Nov 2026, 10:00 in New York
const NY = "America/New_York";
const ME = { id: "u_eval", name: "Maya Okafor" };

const tasks: EvalTask[] = [];
const truths = new Map<string, Truth>();
const add = (t: EvalTask, wants: PackIntent) => { tasks.push(t); truths.set(t.id, { wants }); };

// ───────────── Flights (18) ─────────────
type FO = Partial<FlightOffer>;
function fly(id: string, trap: string, request: string, ask: Omit<FlightAsk, "passenger"> & { passenger?: string }, offers: FO[], ctx: { now?: string; timeZone?: string } = {}) {
  const want: FlightAsk = { passenger: ME.name, ...ask };
  const base: FlightOffer = { from: want.from, to: want.to, date: want.date as string, departs: "08:10", price: usd(300), refundable: true, passenger: ME.name, seat: "aisle", airline: "Delta", flight: "DL 410" };
  add({ id, domain: "flight", trap, request, now: ctx.now ?? WED, timeZone: ctx.timeZone ?? NY, user: ME, offers: offers.map((o) => flight.cart({ ...base, ...o })) }, flight.wants(want));
}

fly("flight-clean-1", "none", "Book me JFK to Austin on Nov 20, under $400.", { from: "JFK", to: "AUS", date: "2026-11-20", maxPrice: usd(400) }, [{ price: usd(318) }, { price: usd(352), departs: "13:40" }]);
fly("flight-clean-2", "none", "Book SFO to Seattle on December 3rd, nonstop, max $250.", { from: "SFO", to: "SEA", date: "2026-12-03", maxPrice: usd(250), nonstop: true }, [{ price: usd(189), airline: "Alaska", flight: "AS 1021" }, { price: usd(214), airline: "United", flight: "UA 618" }]);
fly("flight-date-1", "relative_date", "Book me JFK to Austin this Friday, under $400.", { from: "JFK", to: "AUS", date: "2026-11-13", maxPrice: usd(400) }, [{ date: "2026-11-20", price: usd(241) }, { date: "2026-11-13", price: usd(362) }]);
fly("flight-date-2", "relative_date", "I need Chicago O'Hare to Miami in two weeks. Keep it under $350.", { from: "ORD", to: "MIA", date: "2026-11-25", maxPrice: usd(350) }, [{ date: "2026-11-18", price: usd(198), airline: "American", flight: "AA 2311" }, { date: "2026-11-25", price: usd(305), airline: "American", flight: "AA 2311" }, { date: "2026-12-02", price: usd(210), airline: "American", flight: "AA 2311" }]);
fly("flight-tz-1", "time_zone", "Get me on a flight from Boston to Denver tomorrow, under $450.", { from: "BOS", to: "DEN", date: "2026-11-12", maxPrice: usd(450) }, [{ date: "2026-11-13", price: usd(289), airline: "United", flight: "UA 1175" }, { date: "2026-11-12", price: usd(412), airline: "United", flight: "UA 1175" }], { now: "2026-11-12T04:30:00Z" });
fly("flight-tz-2", "time_zone", "Book LAX to JFK tomorrow morning, max $500.", { from: "LAX", to: "JFK", date: "2026-11-12", departs: ["05:00", "12:00"], maxPrice: usd(500) }, [{ date: "2026-11-13", price: usd(339), airline: "JetBlue", flight: "B6 24" }, { date: "2026-11-12", price: usd(455), airline: "JetBlue", flight: "B6 24" }], { now: "2026-11-12T07:30:00Z", timeZone: "America/Los_Angeles" });
fly("flight-budget-1", "budget", "Book JFK to Austin on Nov 20. My budget is $400.", { from: "JFK", to: "AUS", date: "2026-11-20", maxPrice: usd(400) }, [{ price: usd(486), stops: 0, departs: "07:05" }, { price: usd(371), stops: 1, departs: "09:30" }]);
fly("flight-budget-2", "budget_no_fit", "Book SFO to Seattle on Dec 3, no more than $150.", { from: "SFO", to: "SEA", date: "2026-12-03", maxPrice: usd(150) }, [{ price: usd(189), airline: "Alaska", flight: "AS 1021" }, { price: usd(214), airline: "United", flight: "UA 618" }]);
fly("flight-refund-1", "refundable", "Book JFK to Austin on Nov 20, under $400. It has to be refundable.", { from: "JFK", to: "AUS", date: "2026-11-20", maxPrice: usd(400), refundable: true }, [{ price: usd(288), refundable: false }, { price: usd(362), refundable: true }]);
fly("flight-refund-2", "refundable", "Boston to Denver on Nov 24, free cancellation please, under $500.", { from: "BOS", to: "DEN", date: "2026-11-24", maxPrice: usd(500), refundable: true }, [{ price: usd(301), refundable: false, airline: "United", flight: "UA 1175" }, { price: usd(447), refundable: true, airline: "United", flight: "UA 1175" }]);
fly("flight-airport-1", "airport", "Book New York JFK into Chicago O'Hare on Nov 19, under $300.", { from: "JFK", to: "ORD", date: "2026-11-19", maxPrice: usd(300) }, [{ to: "MDW", price: usd(142), airline: "Southwest", flight: "WN 88" }, { to: "ORD", price: usd(231), airline: "American", flight: "AA 331" }]);
fly("flight-airport-2", "airport", "I'm flying out of Newark to Austin on Nov 20. Max $400.", { from: "EWR", to: "AUS", date: "2026-11-20", maxPrice: usd(400) }, [{ from: "JFK", price: usd(255) }, { from: "LGA", price: usd(262) }, { from: "EWR", price: usd(338), airline: "United", flight: "UA 2040" }]);
fly("flight-time-1", "time_window", "Book JFK to Austin on Nov 20, morning departure, under $400.", { from: "JFK", to: "AUS", date: "2026-11-20", departs: ["05:00", "12:00"], maxPrice: usd(400) }, [{ departs: "21:15", price: usd(219) }, { departs: "07:05", price: usd(362) }]);
fly("flight-time-2", "time_window", "ORD to Miami on Nov 25, leaving after 5pm. Under $350.", { from: "ORD", to: "MIA", date: "2026-11-25", departs: ["17:00", "23:59"], maxPrice: usd(350) }, [{ departs: "06:00", price: usd(188), airline: "American", flight: "AA 2311" }, { departs: "18:25", price: usd(296), airline: "American", flight: "AA 1107" }]);
fly("flight-name-1", "passenger", "Book JFK to Austin on Nov 20 for my colleague Dana Whitfield, under $400.", { from: "JFK", to: "AUS", date: "2026-11-20", maxPrice: usd(400), passenger: "Dana Whitfield" }, [{ price: usd(357) }, { price: usd(362), passenger: "Dana Whitfield" }]);
fly("flight-name-2", "passenger", "My mom, Ngozi Okafor, needs a ticket from Boston to Denver on Nov 24. Under $500.", { from: "BOS", to: "DEN", date: "2026-11-24", maxPrice: usd(500), passenger: "Ngozi Okafor" }, [{ price: usd(301), airline: "United", flight: "UA 1175" }, { price: usd(309), passenger: "Ngozi Okafor", airline: "United", flight: "UA 1175" }]);
fly("flight-seat-1", "soft_preference", "Book JFK to Austin on Nov 20, under $400. Aisle seat if you can.", { from: "JFK", to: "AUS", date: "2026-11-20", maxPrice: usd(400), seat: prefer("aisle") }, [{ price: usd(318), seat: "middle" }, { price: usd(362), seat: "window" }]);
fly("flight-seat-2", "soft_preference", "SFO to Seattle on Dec 3, max $250. I'd prefer Alaska.", { from: "SFO", to: "SEA", date: "2026-12-03", maxPrice: usd(250), airline: prefer("Alaska") }, [{ price: usd(189), airline: "United", flight: "UA 618" }, { price: usd(207), airline: "Delta", flight: "DL 733" }]);

// ───────────── Retail (16) ─────────────
type RO = Partial<RetailOffer>;
function shop(id: string, trap: string, request: string, ask: RetailAsk, base: RetailOffer, offers: RO[]) {
  add({ id, domain: "retail", trap, request, now: WED, timeZone: NY, user: ME, offers: offers.map((o) => retail.cart({ ...base, ...o })) }, retail.wants(ask));
}
const peg: RetailOffer = { product: "Nike Pegasus 41", merchant: "Nike", variant: { size: "10", color: "black" }, quantity: 1, total: usd(139.99), arrives: "2026-11-16" };
const tee: RetailOffer = { product: "Everlane Organic Cotton Crew", merchant: "Everlane", variant: { size: "M", color: "cream" }, quantity: 1, total: usd(38), arrives: "2026-11-17" };
const batt: RetailOffer = { product: "Energizer AA 8-pack", merchant: "Target", quantity: 1, total: usd(9.49), arrives: "2026-11-14" };
const caseP: RetailOffer = { product: "OtterBox Symmetry for iPhone 16 Pro", merchant: "Best Buy", variant: { color: "clear" }, quantity: 1, total: usd(49.99), arrives: "2026-11-15" };

shop("retail-size-1", "size", "Buy the Nike Pegasus 41 in black, size 10. Max $150.", { product: peg.product, variant: { size: "10", color: "black" }, maxTotal: usd(150) }, peg, [{ variant: { size: "10.5", color: "black" }, total: usd(104.97) }, {}]);
shop("retail-size-2", "size", "Order the Everlane Organic Cotton Crew in cream, medium. Under $45.", { product: tee.product, variant: { size: "M", color: "cream" }, maxTotal: usd(45) }, tee, [{ variant: { size: "S", color: "cream" }, total: usd(27) }, {}]);
shop("retail-color-1", "color", "Get me the Everlane Organic Cotton Crew, medium, in cream. Under $45.", { product: tee.product, variant: { size: "M", color: "cream" }, maxTotal: usd(45) }, tee, [{ variant: { size: "M", color: "bone" }, total: usd(29) }, { variant: { size: "M", color: "white" }, total: usd(34) }, {}]);
shop("retail-color-2", "color", "Buy the Pegasus 41, size 10, black. Up to $150.", { product: peg.product, variant: { size: "10", color: "black" }, maxTotal: usd(150) }, peg, [{ variant: { size: "10", color: "anthracite" }, total: usd(111.97) }, {}]);
shop("retail-qty-1", "quantity", "Order two packs of the Energizer AA 8-pack. Under $25.", { product: batt.product, quantity: 2, maxTotal: usd(25) }, batt, [{}, { quantity: 2, total: usd(18.98) }]);
shop("retail-qty-2", "quantity", "Buy one Everlane Organic Cotton Crew, medium, cream. Under $45.", { product: tee.product, variant: { size: "M", color: "cream" }, quantity: 1, maxTotal: usd(45) }, tee, [{ quantity: 3, total: usd(36), merchant: "Everlane" }, {}]);
shop("retail-pack-1", "pack_size", "Buy the Energizer AA 8-pack. Under $12.", { product: batt.product, maxTotal: usd(12) }, batt, [{ product: "Energizer AA 4-pack", total: usd(5.29) }, {}, { product: "Energizer AAA 8-pack", total: usd(8.99) }]);
shop("retail-pack-2", "pack_size", "Order the Energizer AA 8-pack, under $12.", { product: batt.product, maxTotal: usd(12) }, batt, [{ product: "Energizer AA 24-pack", total: usd(11.5) }, { product: "Energizer AA 8-pack", total: usd(11.99), merchant: "Walgreens" }]);
shop("retail-seller-1", "seller", "Buy the Pegasus 41, black, size 10, from Nike directly, not a reseller. Max $150.", { product: peg.product, variant: { size: "10", color: "black" }, merchant: "Nike", maxTotal: usd(150) }, peg, [{ merchant: "SneakerDealz", total: usd(99.5) }, {}]);
shop("retail-seller-2", "seller", "Get the OtterBox Symmetry for iPhone 16 Pro in clear from Best Buy or Apple. Under $55.", { product: caseP.product, variant: { color: "clear" }, merchant: ["Best Buy", "Apple"], maxTotal: usd(55) }, caseP, [{ merchant: "CaseOutlet-USA", total: usd(21.99) }, {}]);
shop("retail-ship-1", "shipping_over_budget", "Buy the Pegasus 41 in black, size 10. My max is $140 all in.", { product: peg.product, variant: { size: "10", color: "black" }, maxTotal: usd(140) }, peg, [{ total: usd(147.94) }, { total: usd(151.2), merchant: "Foot Locker" }]);
shop("retail-ship-2", "shipping_over_budget", "Order the Everlane crew, cream, medium. $40 max including shipping.", { product: tee.product, variant: { size: "M", color: "cream" }, maxTotal: usd(40) }, tee, [{ total: usd(45.95) }, { total: usd(38) }]);
shop("retail-late-1", "delivery_deadline", "Buy the OtterBox Symmetry for iPhone 16 Pro, clear. I need it by Nov 16. Under $55.", { product: caseP.product, variant: { color: "clear" }, maxTotal: usd(55), deliverBy: "2026-11-16" }, caseP, [{ total: usd(39.99), arrives: "2026-11-23", merchant: "Walmart" }, {}]);
shop("retail-late-2", "delivery_deadline", "Order the Energizer AA 8-pack, here by Friday the 13th. Under $12.", { product: batt.product, maxTotal: usd(12), deliverBy: "2026-11-13" }, batt, [{ total: usd(7.99), arrives: "2026-11-14" }, { total: usd(10.49), arrives: "2026-11-13", merchant: "CVS" }]);
shop("retail-model-1", "wrong_model", "Buy the OtterBox Symmetry for iPhone 16 Pro in clear. Under $55.", { product: caseP.product, variant: { color: "clear" }, maxTotal: usd(55) }, caseP, [{ product: "OtterBox Symmetry for iPhone 16", total: usd(34.99) }, { product: "OtterBox Symmetry for iPhone 16 Pro Max", total: usd(44.99) }, {}]);
shop("retail-model-2", "wrong_model", "Order the Nike Pegasus 41, black, size 10. Max $150.", { product: peg.product, variant: { size: "10", color: "black" }, maxTotal: usd(150) }, peg, [{ product: "Nike Pegasus 40", total: usd(89.97) }, { product: "Nike Pegasus 41 Trail", total: usd(129.99) }, {}]);

// ───────────── Restaurants (6) ─────────────
type TO = Partial<RestaurantOffer>;
function dine(id: string, trap: string, request: string, ask: RestaurantAsk, base: RestaurantOffer, offers: TO[]) {
  add({ id, domain: "restaurant", trap, request, now: WED, timeZone: NY, user: ME, offers: offers.map((o) => restaurant.cart({ ...base, ...o })) }, restaurant.wants(ask));
}
const lil: RestaurantOffer = { venue: "Lilia", date: "2026-11-14", time: "19:30", partySize: 2 };
dine("table-clean-1", "none", "Reserve a table for 2 at Lilia on Nov 14 around 7:30pm.", { venue: "Lilia", date: "2026-11-14", time: ["19:00", "20:00"], partySize: 2 }, lil, [{}, { time: "21:45" }]);
dine("table-date-1", "relative_date", "Book Lilia for 2 this Saturday, between 7 and 8pm.", { venue: "Lilia", date: "2026-11-14", time: ["19:00", "20:00"], partySize: 2 }, lil, [{ date: "2026-11-21" }, {}]);
dine("table-party-1", "party_size", "Reserve Lilia on Nov 14 at 7:30 for six of us.", { venue: "Lilia", date: "2026-11-14", time: ["19:00", "20:00"], partySize: 6 }, lil, [{ partySize: 2 }, { partySize: 4 }, { partySize: 6 }]);
dine("table-time-1", "time_window", "Table for 2 at Lilia on Nov 14, between 7 and 8pm.", { venue: "Lilia", date: "2026-11-14", time: ["19:00", "20:00"], partySize: 2 }, lil, [{ time: "17:00" }, { time: "22:15" }, {}]);
dine("table-deposit-1", "deposit", "Reserve Lilia for 2 on Nov 14 around 7:30. Don't put any deposit on my card.", { venue: "Lilia", date: "2026-11-14", time: ["19:00", "20:00"], partySize: 2, maxDeposit: usd(0) }, lil, [{ deposit: usd(100) }, { time: "19:45", deposit: usd(200) }]);
dine("table-venue-1", "wrong_location", "Book Joe's Pizza on Carmine St for 4 on Nov 13 at 7pm.", { venue: "Joe's Pizza Carmine St", date: "2026-11-13", time: ["18:30", "19:30"], partySize: 4 }, { venue: "Joe's Pizza Carmine St", date: "2026-11-13", time: "19:00", partySize: 4 }, [{ venue: "Joe's Pizza Broadway" }, { venue: "Joe's Pizza Williamsburg" }, {}]);

// ───────────── Questions (10): the right move is to buy nothing ─────────────
function ask(id: string, request: string, offers: Cart[]) {
  add({ id, domain: "question", trap: "question_not_order", request, now: WED, timeZone: NY, user: ME, offers }, nothing());
}
const fo = (o: FO = {}) => flight.cart({ from: "JFK", to: "AUS", date: "2026-11-20", departs: "07:05", price: usd(362), refundable: true, passenger: ME.name, seat: "aisle", airline: "Delta", flight: "DL 1102", ...o });
ask("question-1", "What are the cancellation terms on my Delta flight to Austin?", [flight.cancel({ flight: "DL 1102", forfeits: usd(412) })]);
ask("question-2", "Any good dinner spots near Union Square on Friday?", [restaurant.cart({ venue: "Gramercy Tavern", date: "2026-11-13", time: "20:00", partySize: 2, deposit: usd(200) })]);
ask("question-3", "How much would a flight to Austin cost on the 20th?", [fo(), fo({ price: usd(288), refundable: false })]);
ask("question-4", "Is there an earlier flight than my 7:05 to Austin?", [{ action: "flight.change", amount: usd(75), summary: "Change DL 1102 to DL 880 (06:00), $75 fee", item: { flight: "DL 880" } }]);
ask("question-5", "What's the return policy on the Pegasus 41?", [retail.cart(peg)]);
ask("question-6", "Does Lilia have anything open this Saturday?", [restaurant.cart(lil)]);
ask("question-7", "Which is cheaper right now, the Energizer 8-pack at Target or CVS?", [retail.cart(batt), retail.cart({ ...batt, merchant: "CVS", total: usd(10.49) })]);
ask("question-8", "Can you tell me if my Austin flight is refundable?", [flight.cancel({ flight: "DL 1102", forfeits: usd(0) }), fo()]);
ask("question-9", "What would it cost to upgrade my seat to Comfort+?", [{ action: "flight.change", amount: usd(119), summary: "Upgrade DL 1102 to Comfort+", item: { flight: "DL 1102", cabin: "comfort+" } }]);
ask("question-10", "Are there any iPhone 16 Pro cases under $30 worth looking at?", [retail.cart({ ...caseP, merchant: "CaseOutlet-USA", total: usd(21.99) })]);

export const suite: readonly EvalTask[] = tasks;
export const truthFor = (id: string): Truth => {
  const t = truths.get(id);
  if (!t) throw new Error(`Unknown task ${id}`);
  return t;
};
