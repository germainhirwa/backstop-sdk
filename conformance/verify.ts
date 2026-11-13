/** Verify a record read from stdin as {"chain": [...], "publicKey": "..."}. Used to prove records sealed by other SDKs verify here. */
import { verifyChain } from "../src/index.js";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const { chain, publicKey } = JSON.parse(input);
console.log(JSON.stringify(await verifyChain(chain, publicKey)));
