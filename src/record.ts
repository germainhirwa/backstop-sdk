/**
 * The record: a hash-linked, signed chain of what happened.
 *
 *   intent → (ack) → verdict → (resolution) → order → (claim)
 *
 * Each envelope carries the hash of the one before it, so nobody (including
 * the agent company) can quietly edit the request after a bad purchase. A
 * merchant, insurer or auditor holding the public key can verify the chain
 * offline. Ed25519 via Web Crypto; no dependencies.
 */
import { canonical, randomId, sha256 } from "./primitives.js";

export type EnvelopeType = "intent" | "ack" | "verdict" | "resolution" | "order" | "claim";

export interface Envelope<T = unknown> {
  v: 1;
  type: EnvelopeType;
  id: string;
  /** ISO timestamp. */
  at: string;
  /** Hash of the previous envelope in the chain, or null for the first. */
  prev: string | null;
  body: T;
  /** SHA-256 of the canonical JSON of everything above. */
  hash: string;
  /** Ed25519 signature over `hash`, base64url. Null when no signing key is configured. */
  sig: string | null;
  keyId: string | null;
}

export interface KeyPair {
  keyId: string;
  /** PKCS#8, base64url. Keep secret. */
  privateKey: string;
  /** Raw 32 bytes, base64url. Safe to publish. */
  publicKey: string;
}

const b64u = (buf: ArrayBuffer | Uint8Array): string => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const unb64u = (s: string): Uint8Array<ArrayBuffer> => {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

export async function generateKeys(): Promise<KeyPair> {
  const pair = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
  const publicKey = b64u(await crypto.subtle.exportKey("raw", pair.publicKey));
  const privateKey = b64u(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  return { keyId: (await sha256(publicKey)).slice(0, 16), privateKey, publicKey };
}

export interface Signer {
  keyId: string;
  publicKey: string;
  sign(hash: string): Promise<string>;
}

export async function signerFrom(keys: KeyPair): Promise<Signer> {
  const key = await crypto.subtle.importKey("pkcs8", unb64u(keys.privateKey), "Ed25519", false, ["sign"]);
  return {
    keyId: keys.keyId,
    publicKey: keys.publicKey,
    sign: async (hash) => b64u(await crypto.subtle.sign("Ed25519", key, new TextEncoder().encode(hash))),
  };
}

export interface SealOptions {
  prev?: Envelope | null;
  signer?: Signer | null;
  at?: Date;
  id?: string;
}

const PREFIX: Record<EnvelopeType, string> = { intent: "int", ack: "ack", verdict: "chk", resolution: "res", order: "ord", claim: "clm" };

export async function seal<T>(type: EnvelopeType, body: T, opts: SealOptions = {}): Promise<Envelope<T>> {
  const core = {
    v: 1 as const,
    type,
    id: opts.id ?? randomId(PREFIX[type]),
    at: (opts.at ?? new Date()).toISOString(),
    prev: opts.prev?.hash ?? null,
    body: JSON.parse(canonical(body)) as T, // strips undefined, freezes key order
  };
  const hash = await sha256(canonical(core));
  const sig = opts.signer ? await opts.signer.sign(hash) : null;
  return { ...core, hash, sig, keyId: opts.signer?.keyId ?? null };
}

export interface ChainCheck {
  ok: boolean;
  /** True when every envelope carried a valid signature. */
  signed: boolean;
  problems: string[];
}

/** Verify hashes, links and (when a public key is given) signatures. */
export async function verifyChain(chain: Envelope[], publicKey?: string): Promise<ChainCheck> {
  const problems: string[] = [];
  let signed = chain.length > 0;
  const key = publicKey ? await crypto.subtle.importKey("raw", unb64u(publicKey), "Ed25519", false, ["verify"]) : null;
  let prev: Envelope | null = null;
  for (const env of chain) {
    const { hash, sig, keyId: _keyId, ...core } = env;
    if ((await sha256(canonical(core))) !== hash) problems.push(`${env.id}: contents were changed after sealing`);
    if (env.prev !== (prev?.hash ?? null)) problems.push(`${env.id}: does not follow the previous record`);
    if (!sig) signed = false;
    else if (key && !(await crypto.subtle.verify("Ed25519", key, unb64u(sig), new TextEncoder().encode(hash)))) {
      problems.push(`${env.id}: signature does not match the public key`);
      signed = false;
    }
    prev = env;
  }
  if (!key) signed = false;
  return { ok: problems.length === 0, signed, problems };
}
