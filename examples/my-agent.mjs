// A template for testing your own agent: npx backstop eval examples/my-agent.mjs
//
// Each task has { request, now, timeZone, user, offers }. Return one of:
//   { cart }            buy this (one of task.offers, or your own edit of one)
//   { cart, intent }    same, plus the intent your agent captured, to see what Backstop would stop
//   { ask: "..." }      ask the user a question instead
//   { decline: "..." }  buy nothing
export default async function agent(task) {
  // Replace this with a call into your agent. This stand-in refuses to act on questions
  // and otherwise buys the cheapest offer.
  if (/\?\s*$/.test(task.request)) return { decline: "That's a question, so I'll just answer it." };
  const cheapest = task.offers.reduce((a, b) => (b.amount.minor < a.amount.minor ? b : a));
  return { cart: cheapest };
}
