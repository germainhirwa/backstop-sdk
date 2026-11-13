/**
 * Domain packs: typed shortcuts that turn "what the user asked" into rules and
 * "what the agent picked" into a cart. Each pack is a thin layer over the rule
 * builders in ../rules.ts. Anything a pack can't express, add with `must.*`.
 */
import { formatDate, formatMoney, type ISODate, type Money, type ResolvedDate, usd } from "../primitives.js";
import { type Cart, type Preferred, type Rule, type Strength, unwrap } from "../rules.js";

export interface PackIntent {
  pack: string;
  /** Actions this request authorizes. */
  allow: string[];
  rules: Rule[];
}

type Opt<T> = T | Preferred<T>;
const dateOf = (d: ISODate | ResolvedDate): ISODate => (typeof d === "string" ? d : d.date);
const rule = (field: string, label: string, strength: Strength, test: Rule["test"]): Rule => ({ field, label, strength, test });

// ───────────────────────────── Flights ─────────────────────────────

export interface FlightAsk {
  from: string;
  to: string;
  date: ISODate | ResolvedDate;
  /** Departure window, 24h local time: ["06:00", "12:00"]. */
  departs?: Opt<[string, string]>;
  maxPrice?: Money;
  refundable?: Opt<boolean>;
  /** Name as it must appear on the ticket. */
  passenger: string;
  seat?: Opt<string>;
  cabin?: Opt<string>;
  nonstop?: Opt<boolean>;
  airline?: Opt<string | string[]>;
}

export interface FlightOffer {
  from: string;
  to: string;
  date: ISODate;
  departs: string;
  price: Money;
  refundable: boolean;
  passenger: string;
  seat?: string;
  cabin?: string;
  stops?: number;
  airline?: string;
  flight?: string;
  /** The offer's URL or id, so edits to a flagged offer are noticed. */
  ref?: string;
}

export const flight = {
  actions: { book: "flight.book", cancel: "flight.cancel", change: "flight.change" },

  wants(ask: FlightAsk): PackIntent {
    const rules: Rule[] = [
      rule("item.from", "Origin", "must", { op: "eq", value: ask.from.toUpperCase() }),
      rule("item.to", "Destination", "must", { op: "eq", value: ask.to.toUpperCase() }),
      rule("item.date", "Date", "must", { op: "date", value: dateOf(ask.date) }),
      rule("item.passenger", "Passenger", "must", { op: "name", value: ask.passenger }),
    ];
    if (ask.departs) { const { value, strength } = unwrap(ask.departs); rules.push(rule("item.departs", "Departure time", strength, { op: "between", min: value[0], max: value[1] })); }
    if (ask.maxPrice) rules.push(rule("amount", "Price", "must", { op: "money_lte", value: ask.maxPrice }));
    if (ask.refundable !== undefined) { const { value, strength } = unwrap(ask.refundable); if (value) rules.push(rule("item.refundable", "Refundable", strength, { op: "is", value: true })); }
    if (ask.seat !== undefined) { const { value, strength } = unwrap(ask.seat); rules.push(rule("item.seat", "Seat", strength, { op: "eq", value })); }
    if (ask.cabin !== undefined) { const { value, strength } = unwrap(ask.cabin); rules.push(rule("item.cabin", "Cabin", strength, { op: "eq", value })); }
    if (ask.nonstop !== undefined) { const { value, strength } = unwrap(ask.nonstop); if (value) rules.push(rule("item.stops", "Stops", strength, { op: "lte", value: 0 })); }
    if (ask.airline !== undefined) { const { value, strength } = unwrap(ask.airline); rules.push(rule("item.airline", "Airline", strength, { op: "in", values: Array.isArray(value) ? value : [value] })); }
    return { pack: "flight", allow: [flight.actions.book], rules };
  },

  cart(o: FlightOffer): Cart {
    return {
      action: flight.actions.book,
      amount: o.price,
      merchant: o.airline,
      summary: `${o.airline ?? "Flight"} ${o.flight ?? ""} ${o.from.toUpperCase()}→${o.to.toUpperCase()} ${formatDate(o.date)} ${o.departs}`.replace(/\s+/g, " ").trim(),
      item: {
        from: o.from.toUpperCase(), to: o.to.toUpperCase(), date: o.date, departs: o.departs, refundable: o.refundable,
        passenger: o.passenger, seat: o.seat?.toLowerCase(), cabin: o.cabin?.toLowerCase(), stops: o.stops ?? 0, airline: o.airline, flight: o.flight,
      },
      ...(o.ref ? { ref: o.ref } : {}),
    };
  },

  /** A cancellation is a purchase-sized decision: `forfeits` is what the user loses. */
  cancel(o: { flight: string; forfeits: Money }): Cart {
    return { action: flight.actions.cancel, amount: o.forfeits, summary: `Cancel ${o.flight} (forfeits ${formatMoney(o.forfeits)})`, item: { flight: o.flight } };
  },
};

// ───────────────────────────── Retail ─────────────────────────────

export interface RetailAsk {
  /** Exact product name, when there is no SKU. */
  product?: string;
  sku?: string;
  merchant?: Opt<string | string[]>;
  /** Variant attributes the user named: { size: "M", color: prefer("cream") }. */
  variant?: Record<string, Opt<string>>;
  /** Units to buy. Defaults to 1 so an agent can't silently add more. */
  quantity?: number;
  /** Cap on the full total, shipping and tax included. */
  maxTotal?: Money;
  deliverBy?: Opt<ISODate>;
}

export interface RetailOffer {
  product: string;
  sku?: string;
  merchant: string;
  variant?: Record<string, string>;
  quantity: number;
  /** Full total: items + shipping + tax. */
  total: Money;
  arrives?: ISODate;
  /** The offer's URL or id, so edits to a flagged offer are noticed. */
  ref?: string;
}

export const retail = {
  actions: { purchase: "retail.purchase", cancel: "retail.cancel", return: "retail.return" },

  wants(ask: RetailAsk): PackIntent {
    const rules: Rule[] = [];
    if (ask.sku) rules.push(rule("item.sku", "Product", "must", { op: "eq", value: ask.sku }));
    else if (ask.product) rules.push(rule("item.product", "Product", "must", { op: "has", value: ask.product }));
    for (const [key, v] of Object.entries(ask.variant ?? {})) {
      const { value, strength } = unwrap(v);
      rules.push(rule(`item.variant.${key}`, key[0]!.toUpperCase() + key.slice(1), strength, { op: "has", value }));
    }
    rules.push(rule("item.quantity", "Quantity", "must", { op: "eq", value: ask.quantity ?? 1 }));
    if (ask.maxTotal) rules.push(rule("amount", "Total", "must", { op: "money_lte", value: ask.maxTotal }));
    if (ask.merchant !== undefined) { const { value, strength } = unwrap(ask.merchant); rules.push(rule("merchant", "Seller", strength, { op: "in", values: Array.isArray(value) ? value : [value] })); }
    if (ask.deliverBy !== undefined) { const { value, strength } = unwrap(ask.deliverBy); rules.push(rule("item.arrives", "Delivery", strength, { op: "date_lte", value })); }
    return { pack: "retail", allow: [retail.actions.purchase], rules };
  },

  cart(o: RetailOffer): Cart {
    const variant = Object.fromEntries(Object.entries(o.variant ?? {}).map(([k, v]) => [k, v]));
    const v = Object.values(variant).join(", ");
    return {
      action: retail.actions.purchase,
      amount: o.total,
      merchant: o.merchant,
      summary: `${o.quantity} × ${o.product}${v ? ` (${v})` : ""} from ${o.merchant}`,
      item: { product: o.product, sku: o.sku, variant, quantity: o.quantity, arrives: o.arrives },
      ...(o.ref ? { ref: o.ref } : {}),
    };
  },
};

// ───────────────────────────── Restaurants ─────────────────────────────

export interface RestaurantAsk {
  venue?: string;
  date: ISODate | ResolvedDate;
  /** Arrival window: ["19:00", "20:30"]. */
  time?: Opt<[string, string]>;
  partySize: number;
  /** Most the user will put at risk in deposits or no-show fees. Defaults to $0. */
  maxDeposit?: Money;
}

export interface RestaurantOffer {
  venue: string;
  date: ISODate;
  time: string;
  partySize: number;
  /** Deposit or no-show fee the card is exposed to. */
  deposit?: Money;
  /** The offer's URL or id, so edits to a flagged offer are noticed. */
  ref?: string;
}

export const restaurant = {
  actions: { reserve: "restaurant.reserve", cancel: "restaurant.cancel" },

  wants(ask: RestaurantAsk): PackIntent {
    const rules: Rule[] = [
      rule("item.date", "Date", "must", { op: "date", value: dateOf(ask.date) }),
      rule("item.partySize", "Party size", "must", { op: "eq", value: ask.partySize }),
      rule("amount", "Deposit at risk", "must", { op: "money_lte", value: ask.maxDeposit ?? usd(0) }),
    ];
    if (ask.venue) rules.push(rule("item.venue", "Restaurant", "must", { op: "has", value: ask.venue }));
    if (ask.time) { const { value, strength } = unwrap(ask.time); rules.push(rule("item.time", "Time", strength, { op: "between", min: value[0], max: value[1] })); }
    return { pack: "restaurant", allow: [restaurant.actions.reserve], rules };
  },

  cart(o: RestaurantOffer): Cart {
    return {
      action: restaurant.actions.reserve,
      amount: o.deposit ?? usd(0),
      merchant: o.venue,
      summary: `Table for ${o.partySize} at ${o.venue}, ${formatDate(o.date)} ${o.time}`,
      item: { venue: o.venue, date: o.date, time: o.time, partySize: o.partySize },
      ...(o.ref ? { ref: o.ref } : {}),
    };
  },
};

/** The user asked a question or wants information only. Authorizes no purchase at all. */
export const nothing = (): PackIntent => ({ pack: "none", allow: [], rules: [] });
