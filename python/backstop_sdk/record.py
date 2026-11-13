"""The record: a hash-linked, signed chain of what happened.

    intent → (ack) → verdict → (resolution) → order → (claim)

Each envelope carries the hash of the one before it, so nobody can quietly edit
the request after a bad purchase. Envelopes are plain dicts with the same JSON
shape as the TypeScript SDK, so a chain sealed there verifies here and back.

Hashing needs nothing. Signing and signature checks use Ed25519 from the
optional `cryptography` package: pip install "backstop-sdk[sign]".
"""
from __future__ import annotations

import base64
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Optional

from .primitives import canonical, random_id, sha256, to_iso

Envelope = dict  # {"v", "type", "id", "at", "prev", "body", "hash", "sig", "keyId"}
_PREFIX = {"intent": "int", "ack": "ack", "verdict": "chk", "resolution": "res", "order": "ord", "claim": "clm"}


def _b64u(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode().rstrip("=")


def _unb64u(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def _crypto():
    try:
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.asymmetric import ed25519
    except ImportError as e:  # pragma: no cover
        raise RuntimeError('Signing needs the "cryptography" package: pip install "backstop-sdk[sign]"') from e
    return ed25519, serialization


@dataclass(frozen=True)
class KeyPair:
    key_id: str
    private_key: str  # PKCS#8, base64url. Keep secret.
    public_key: str  # raw 32 bytes, base64url. Safe to publish.

    def to_dict(self) -> dict:
        return {"keyId": self.key_id, "privateKey": self.private_key, "publicKey": self.public_key}

    @staticmethod
    def from_dict(d: dict) -> "KeyPair":
        return KeyPair(d["keyId"], d["privateKey"], d["publicKey"])


def generate_keys() -> KeyPair:
    ed25519, ser = _crypto()
    key = ed25519.Ed25519PrivateKey.generate()
    public = _b64u(key.public_key().public_bytes(ser.Encoding.Raw, ser.PublicFormat.Raw))
    private = _b64u(key.private_bytes(ser.Encoding.DER, ser.PrivateFormat.PKCS8, ser.NoEncryption()))
    return KeyPair(sha256(public)[:16], private, public)


class Signer:
    def __init__(self, keys: KeyPair):
        _, ser = _crypto()
        self.key_id, self.public_key = keys.key_id, keys.public_key
        self._key = ser.load_der_private_key(_unb64u(keys.private_key), password=None)

    def sign(self, digest: str) -> str:
        return _b64u(self._key.sign(digest.encode("utf-8")))


def seal(type: str, body: Any, prev: Optional[Envelope] = None, signer: Optional[Signer] = None, at: Optional[datetime] = None, id: Optional[str] = None) -> Envelope:
    core = {
        "v": 1,
        "type": type,
        "id": id or random_id(_PREFIX[type]),
        "at": to_iso(at or datetime.now(timezone.utc)),
        "prev": prev["hash"] if prev else None,
        "body": json.loads(canonical(body)),
    }
    digest = sha256(canonical(core))
    return {**core, "hash": digest, "sig": signer.sign(digest) if signer else None, "keyId": signer.key_id if signer else None}


@dataclass
class ChainCheck:
    ok: bool
    signed: bool  # True when every envelope carried a valid signature
    problems: list

    def to_dict(self) -> dict:
        return {"ok": self.ok, "signed": self.signed, "problems": list(self.problems)}


def verify_chain(chain: list, public_key: Optional[str] = None) -> ChainCheck:
    """Verify hashes, links and (when a public key is given) signatures."""
    problems: list = []
    signed = len(chain) > 0
    key = None
    if public_key and any(e.get("sig") for e in chain):
        ed25519, _ = _crypto()
        key = ed25519.Ed25519PublicKey.from_public_bytes(_unb64u(public_key))
    prev: Optional[Envelope] = None
    for env in chain:
        core = {k: v for k, v in env.items() if k not in ("hash", "sig", "keyId")}
        if sha256(canonical(core)) != env.get("hash"):
            problems.append(f"{env.get('id')}: contents were changed after sealing")
        if env.get("prev") != (prev["hash"] if prev else None):
            problems.append(f"{env.get('id')}: does not follow the previous record")
        sig = env.get("sig")
        if not sig:
            signed = False
        elif key is not None:
            try:
                key.verify(_unb64u(sig), env["hash"].encode("utf-8"))
            except Exception:
                problems.append(f"{env.get('id')}: signature does not match the public key")
                signed = False
        prev = env
    if not public_key:
        signed = False
    return ChainCheck(len(problems) == 0, signed, problems)
