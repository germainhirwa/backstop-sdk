"""Primitives: money, dates, names, canonical JSON, hashing.

Everything here is deterministic and matches the TypeScript SDK output for
output, so a record sealed in one language verifies and replays in the other.
"""
from __future__ import annotations

import hashlib
import json
import math
import re
import secrets
import unicodedata
from dataclasses import dataclass, field
from datetime import date as _date, datetime, timedelta, timezone
from typing import Any, Optional
from zoneinfo import ZoneInfo

Money = dict  # {"currency": "USD", "minor": 36200}
ISODate = str  # "2026-11-20"

# ───────────────────────────── Numbers and strings, the JavaScript way ─────────────────────────────


def js_round(x: float) -> int:
    """Math.round: halves round up."""
    return math.floor(x + 0.5)


def js_num(v: float | int) -> str:
    """Render a number the way JavaScript's String() does (362.0 → "362")."""
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, int):
        return str(v)
    if math.isfinite(v) and v == math.floor(v) and abs(v) < 1e21:
        return str(int(v))
    return repr(v)


def js_str(v: Any) -> str:
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return js_num(v)
    if isinstance(v, str):
        return v
    if isinstance(v, (list, tuple)):
        return ",".join("" if x is None else js_str(x) for x in v)
    return "[object Object]"


def is_number(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


# ───────────────────────────── Money ─────────────────────────────

_ZERO_DECIMAL = {"JPY", "KRW", "VND", "CLP", "ISK", "UGX", "RWF", "XAF", "XOF"}
_SYMBOLS = {"USD": "$", "EUR": "€", "GBP": "£", "JPY": "¥", "CAD": "CA$", "AUD": "A$", "MXN": "MX$", "INR": "₹", "CNY": "CN¥", "KRW": "₩", "BRL": "R$", "NZD": "NZ$", "HKD": "HK$", "ILS": "₪", "VND": "₫"}


def money(amount: float, currency: str = "USD") -> Money:
    """Money in integer minor units (cents), so comparisons never hit float error."""
    c = currency.upper()
    if not is_number(amount) or not math.isfinite(amount):
        raise TypeError(f"money(): amount must be a finite number, got {amount!r}")
    return {"currency": c, "minor": js_round(amount * (1 if c in _ZERO_DECIMAL else 100))}


def usd(amount: float) -> Money:
    return money(amount, "USD")


def is_money(v: Any) -> bool:
    return isinstance(v, dict) and isinstance(v.get("currency"), str) and isinstance(v.get("minor"), int) and not isinstance(v.get("minor"), bool)


def format_money(m: Money) -> str:
    cur, minor = m["currency"], m["minor"]
    zero = cur in _ZERO_DECIMAL
    whole = zero or minor % 100 == 0
    n = minor if zero else minor / 100
    text = f"{abs(n):,.0f}" if whole else f"{abs(n):,.2f}"
    sign = "-" if minor < 0 else ""
    sym = _SYMBOLS.get(cur)
    return f"{sign}{sym}{text}" if sym else f"{sign}{cur} {text}"


# ───────────────────────────── Dates ─────────────────────────────

_ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
_DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]


def _parse(d: str) -> Optional[_date]:
    try:
        return _date.fromisoformat(d)
    except ValueError:
        return None


def is_iso_date(v: Any) -> bool:
    return isinstance(v, str) and bool(_ISO_DATE.match(v)) and _parse(v) is not None


def to_iso(dt: datetime) -> str:
    """ISO timestamp exactly as JavaScript's toISOString() writes it."""
    u = dt.astimezone(timezone.utc)
    return u.strftime("%Y-%m-%dT%H:%M:%S.") + f"{u.microsecond // 1000:03d}Z"


def from_iso(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def today_in(time_zone: str, now: Optional[datetime] = None) -> ISODate:
    """Today's calendar date as the user sees it. This is the line the "wrong week" bugs cross."""
    now = now or datetime.now(timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    return now.astimezone(ZoneInfo(time_zone)).date().isoformat()


def add_days(d: ISODate, days: int) -> ISODate:
    return (_date.fromisoformat(d) + timedelta(days=days)).isoformat()


def weekday_of(d: ISODate) -> int:
    """0 = Sunday … 6 = Saturday."""
    return (_date.fromisoformat(d).weekday() + 1) % 7


def days_between(a: ISODate, b: ISODate) -> int:
    return (_date.fromisoformat(b) - _date.fromisoformat(a)).days


def format_date(d: ISODate) -> str:
    x = _date.fromisoformat(d)
    return f"{_DOW[x.weekday()]}, {_MON[x.month - 1]} {x.day}"


def format_time(t: str) -> str:
    parts = t.split(":")
    h = int(parts[0]) if parts and parts[0] else 0
    m = int(parts[1]) if len(parts) > 1 else 0
    return f"{h % 12 or 12}:{m:02d} {'am' if h < 12 else 'pm'}"


_WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]
_WEEKDAY_RE = r"(sun|mon|tue(?:s)?|wed(?:nes)?|thu(?:r|rs)?|fri|sat(?:ur)?)(?:day)?"
_MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"]
_MONTH_RE = r"(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)"
_I = re.IGNORECASE

_DATE_PATTERNS = [
    re.compile(r"\b\d{4}-\d{2}-\d{2}\b", _I),
    re.compile(r"\b(?:day after tomorrow|tomorrow|today|tonight)\b", _I),
    re.compile(r"\bin (\d{1,2}|a|one|two|three|four|five|six|seven) (day|week)s?\b", _I),
    re.compile(rf"\b{_MONTH_RE}\.? (\d{{1,2}})(?:st|nd|rd|th)?(?:,? (\d{{4}}))?\b", _I),
    re.compile(rf"\b(\d{{1,2}})(?:st|nd|rd|th)? (?:of )?{_MONTH_RE}\.?(?:,? (\d{{4}}))?\b", _I),
    re.compile(r"\b(\d{1,2})/(\d{1,2})(?:/(\d{2,4}))?\b"),
    re.compile(rf"\b(?:(this|next|on|coming|this coming) )?{_WEEKDAY_RE}\b", _I),
]
_WORD_NUM = {"a": 1, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7}


@dataclass
class ResolvedDate:
    """A date phrase resolved in the user's time zone."""

    date: ISODate
    phrase: str
    ambiguous: bool = False
    alternatives: list = field(default_factory=list)
    note: Optional[str] = None

    def to_dict(self) -> dict:
        d = {"date": self.date, "phrase": self.phrase, "ambiguous": self.ambiguous, "alternatives": list(self.alternatives)}
        if self.note is not None:
            d["note"] = self.note
        return d


def find_date_phrase(text: str) -> Optional[str]:
    """Find the first date-like phrase in free text."""
    best: Optional[tuple] = None
    for pattern in _DATE_PATTERNS:
        m = pattern.search(text)
        if m and (best is None or m.start() < best[0]):
            best = (m.start(), m.group(0))
    return best[1] if best else None


def resolve_date(text: str, time_zone: str = "UTC", now: Optional[datetime] = None) -> Optional[ResolvedDate]:
    """Resolve "next Friday", "tomorrow", "Nov 20" or "11/20" to a calendar date in the user's zone.

    Returns None when the text holds no date this function understands. It never guesses.
    """
    today = today_in(time_zone, now)
    phrase = find_date_phrase(text)
    if not phrase:
        return None
    p = phrase.lower()

    def plain(d: ISODate) -> ResolvedDate:
        return ResolvedDate(date=d, phrase=phrase)

    if _ISO_DATE.match(p):
        return plain(p) if is_iso_date(p) else None
    if p in ("today", "tonight"):
        return plain(today)
    if p == "tomorrow":
        return plain(add_days(today, 1))
    if p == "day after tomorrow":
        return plain(add_days(today, 2))

    m = re.match(r"^in (\S+) (day|week)s?$", p)
    if m:
        n = _WORD_NUM.get(m.group(1))
        if n is None:
            n = int(m.group(1)) if m.group(1).isdigit() else None
        return plain(add_days(today, n * (7 if m.group(2) == "week" else 1))) if n is not None else None

    def month_index(s: str) -> int:
        return next((i for i, mm in enumerate(_MONTHS) if mm.startswith(s[:3])), -1)

    def from_month_day(month: int, day: int, year: Optional[int] = None) -> Optional[ResolvedDate]:
        y0 = year if year is not None else int(today[:4])

        def mk(y: int) -> str:
            return f"{y}-{month + 1:02d}-{day:02d}"

        d = mk(y0)
        if not is_iso_date(d):
            return None
        if year is None and d < today:
            d = mk(y0 + 1)  # "Jan 5" said in November means next January
            if not is_iso_date(d):
                return None
        return plain(d)

    m = re.match(rf"^{_MONTH_RE}\.? (\d{{1,2}})(?:st|nd|rd|th)?(?:,? (\d{{4}}))?$", p, _I)
    if m:
        return from_month_day(month_index(m.group(1)), int(m.group(2)), int(m.group(3)) if m.group(3) else None)
    m = re.match(rf"^(\d{{1,2}})(?:st|nd|rd|th)? (?:of )?{_MONTH_RE}\.?(?:,? (\d{{4}}))?$", p, _I)
    if m:
        return from_month_day(month_index(m.group(2)), int(m.group(1)), int(m.group(3)) if m.group(3) else None)

    m = re.match(r"^(\d{1,2})/(\d{1,2})(?:/(\d{2,4}))?$", p)
    if m:
        a, b = int(m.group(1)), int(m.group(2))
        year = None
        if m.group(3):
            year = 2000 + int(m.group(3)) if len(m.group(3)) == 2 else int(m.group(3))
        us = from_month_day(a - 1, b, year)  # month/day, the US reading
        intl = from_month_day(b - 1, a, year) if (a != b and a <= 12 and b <= 12) else None
        if us and intl:
            us.ambiguous, us.alternatives = True, [intl.date]
            us.note = f'"{phrase}" could be {format_date(us.date)} or {format_date(intl.date)}.'
            return us
        return us or (from_month_day(b - 1, a, year) if a > 12 else None)

    m = re.match(rf"^(?:(this|next|on|coming|this coming) )?{_WEEKDAY_RE}$", p, _I)
    if m:
        qualifier = m.group(1) or ""
        target = next(i for i, w in enumerate(_WEEKDAYS) if w.startswith(m.group(2)[:3]))
        ahead = (target - weekday_of(today) + 7) % 7
        upcoming = add_days(today, 7 if ahead == 0 else ahead)
        if qualifier == "next":
            # "next Friday" = the Friday of next calendar week (weeks start Monday).
            to_next_monday = ((8 - weekday_of(today)) % 7) or 7
            next_week = add_days(today, to_next_monday + ((target + 6) % 7))
            if next_week != upcoming:
                return ResolvedDate(next_week, phrase, True, [upcoming], f'"{phrase}" could mean {format_date(upcoming)} or {format_date(next_week)}.')
            return plain(next_week)
        if ahead == 0:
            return ResolvedDate(upcoming, phrase, True, [today], f'"{phrase}" could mean today or {format_date(upcoming)}.')
        return plain(upcoming)
    return None


# ───────────────────────────── Names ─────────────────────────────


def tokens(value: Any) -> list:
    """Words of a free-text value, for matching what a site writes ("Men's 10 (D - Medium)") against
    what the user said ("10"). Lowercase, accents dropped, punctuation is a separator, decimals kept
    whole so "10.5" never matches "10"."""
    s = value if isinstance(value, str) else "" if value is None else js_str(value)
    s = "".join(ch for ch in unicodedata.normalize("NFKD", s) if not unicodedata.category(ch).startswith("M")).lower()
    return [t for t in (w.strip(".") for w in re.sub(r"[^a-z0-9.]+", " ", s).split(" ")) if t]


def normalize_name(name: str) -> str:
    n = "".join(ch for ch in unicodedata.normalize("NFD", name) if not ("̀" <= ch <= "ͯ")).lower().strip()
    swap = re.match(r"^([^/,]+)[/,]\s*(.+)$", n)  # "OKAFOR/MAYA" and "Okafor, Maya" mean "Maya Okafor"
    if swap:
        n = f"{swap.group(2)} {swap.group(1)}"
    n = re.sub(r"\b(mr|mrs|ms|miss|dr|mx)\.?\s", " ", n)
    n = re.sub(r"[^a-z\s-]", "", n)
    return re.sub(r"[\s-]+", " ", n).strip()


def _edit_distance(a: str, b: str) -> int:
    prev = list(range(len(b) + 1))
    for i in range(1, len(a) + 1):
        last, prev[0] = prev[0], i
        for j in range(1, len(b) + 1):
            tmp = prev[j]
            prev[j] = min(prev[j] + 1, prev[j - 1] + 1, last + (0 if a[i - 1] == b[j - 1] else 1))
            last = tmp
    return prev[len(b)]


def compare_names(expected: str, actual: str) -> str:
    """Compare a traveler or recipient name the way a gate agent would.

    Returns "exact", "middle_omitted", "typo" or "different".
    """
    e, a = normalize_name(expected), normalize_name(actual)
    if e == a:
        return "exact"
    et, at = e.split(" "), a.split(" ")
    if len(et) >= 2 and len(at) >= 2 and et[0] == at[0] and et[-1] == at[-1]:
        return "middle_omitted"
    return "typo" if _edit_distance(e, a) <= 2 else "different"


# ─────────────────────── Canonical JSON and hashing ───────────────────────


def canonical(value: Any) -> str:
    """Deterministic JSON: sorted keys, JavaScript number formatting. The same record always hashes the same."""
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, (int, float)):
        if isinstance(value, float) and not math.isfinite(value):
            raise TypeError("canonical(): non-finite number")
        return js_num(value)
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(canonical(v) for v in value) + "]"
    if isinstance(value, dict):
        keys = sorted(value.keys(), key=lambda k: k.encode("utf-16-be"))
        return "{" + ",".join(f"{json.dumps(k, ensure_ascii=False)}:{canonical(value[k])}" for k in keys) + "}"
    if hasattr(value, "to_dict"):
        return canonical(value.to_dict())
    raise TypeError(f"canonical(): cannot serialize {type(value).__name__}")


def sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


_B36 = "0123456789abcdefghijklmnopqrstuvwxyz"


def random_id(prefix: str) -> str:
    out = "".join(_B36[b // 36] + _B36[b % 36] for b in secrets.token_bytes(9))
    return f"{prefix}_{out[:14]}"


def get_path(obj: Any, path: str) -> Any:
    """Read a dotted path ("item.variant.size") out of a dict. Missing → None."""
    cur = obj
    for key in path.split("."):
        if not isinstance(cur, dict):
            return None
        cur = cur.get(key)
    return cur
