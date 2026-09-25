"""Plan changes requested by the athlete from the dashboard.

The dashboard encrypts a small JSON command with the athlete's passphrase
and publishes it to a private ntfy topic (``<NTFY_TOPIC>-plan``). Each sync
reads new commands, rewrites the affected days as user overrides and pushes a
confirmation. Commands that cannot be decrypted are ignored, so knowing the
topic name is not enough to change the plan.
"""

import copy
import json
import os
import sys
from datetime import date, timedelta

import requests

from . import crypto
from .adapt import adapt_day
from .plan import WEEKDAYS_LONG, monday_of

PRIORITY = {"run": 1, "bike": 2, "row": 2, "swim": 2, "strength": 3}


def command_topic() -> str | None:
    topic = os.getenv("NTFY_TOPIC")
    return f"{topic}-plan" if topic else None


def fetch(state: dict, passphrase: str) -> list[dict]:
    """New, decryptable commands from the ntfy topic (oldest first)."""
    topic = command_topic()
    if not topic:
        return []
    server = (os.getenv("NTFY_SERVER") or "https://ntfy.sh").rstrip("/")
    headers = {"Authorization": f"Bearer {os.environ['NTFY_TOKEN']}"} if os.getenv("NTFY_TOKEN") else {}
    since = state.get("cmd_since") or "12h"
    try:
        resp = requests.get(f"{server}/{topic}/json", params={"poll": "1", "since": since}, headers=headers, timeout=15)
        resp.raise_for_status()
    except requests.RequestException as err:
        print(f"[commands] fetch failed: {err}", file=sys.stderr)
        return []
    out = []
    for line in resp.text.splitlines():
        msg = json.loads(line) if line.strip() else {}
        if msg.get("event") != "message":
            continue
        state["cmd_since"] = msg["id"]
        try:
            cmd = crypto.decrypt_json(msg.get("message") or "", passphrase)
        except Exception:
            print("[commands] ignoring message that does not decrypt", file=sys.stderr)
            continue
        if isinstance(cmd, dict) and cmd.get("type"):
            out.append(cmd)
    return out


class Editor:
    """Applies commands to a copy of the effective week and tracks touched days."""

    def __init__(self, effective: dict[str, list[dict]], today: date):
        self.days = copy.deepcopy(effective)
        self.today = today
        self.changed: set[str] = set()
        self.notes: list[str] = []

    # -- helpers ------------------------------------------------------------
    def _get(self, d: date) -> list[dict]:
        return self.days.setdefault(d.isoformat(), [])

    def _set(self, d: date, sessions: list[dict]) -> None:
        self.days[d.isoformat()] = sessions
        self.changed.add(d.isoformat())

    def _sailing(self, d: date) -> bool:
        return any(s["sport"] == "sail" for s in self._get(d))

    def _key(self, d: date, ignore: str | None = None) -> bool:
        return any(s.get("key") and s["sport"] == "run" and s["id"] != ignore for s in self._get(d))

    def _target(self, day: date, s: dict) -> date | None:
        """Nearest later day of the same week that can take ``s``."""
        sunday = monday_of(day) + timedelta(days=6)
        start = max(day + timedelta(days=1), self.today)
        days = [start + timedelta(days=i) for i in range((sunday - start).days + 1)]
        days = [d for d in days if not self._sailing(d)]
        days.sort(key=lambda d: (d.weekday() == 0, (d - day).days))  # Monday stays rest day if possible
        if s.get("key") and s["sport"] == "run":
            strict = [d for d in days if not any(self._key(d + timedelta(days=k), s["id"]) for k in (-1, 0, 1))]
            loose = [d for d in days if not self._key(d, s["id"])]
            return (strict or loose or [None])[0]
        free = [d for d in days if not any(x["sport"] == s["sport"] for x in self._get(d))]
        return (free or [None])[0]

    def _move(self, day: date, s: dict, why: str) -> str:
        target = self._target(day, s)
        self._set(day, [x for x in self._get(day) if x["id"] != s["id"]])
        if not target:
            return f"{s['title']} entfällt diese Woche"
        moved = dict(s, date=target.isoformat(), id=s["id"].replace(day.isoformat(), target.isoformat()),
                     adjusted=f"Von {WEEKDAYS_LONG[day.weekday()]} verschoben – {why}")
        keep = self._get(target)
        if s["sport"] == "run":
            keep = [x for x in keep if x["sport"] != "run" or x.get("key")]  # moved run replaces an easy run
        self._set(target, keep + [moved])
        return f"{s['title']} → {WEEKDAYS_LONG[target.weekday()]}"

    def _find(self, day: date, session_id: str | None) -> dict | None:
        return next((s for s in self._get(day) if s["id"] == session_id), None)

    # -- commands -----------------------------------------------------------
    def skip(self, day: date, session_id: str, mode: str) -> str:
        s = self._find(day, session_id)
        if not s:
            return "Einheit nicht gefunden"
        if mode == "drop":
            self._set(day, [x for x in self._get(day) if x["id"] != session_id])
            return f"{s['title']} gestrichen"
        return self._move(day, s, "du hattest keine Zeit")

    def day_off(self, day: date) -> str:
        movable = [s for s in self._get(day) if s["sport"] != "sail"]
        movable.sort(key=lambda s: (not s.get("key"), PRIORITY.get(s["sport"], 4)))
        results = [self._move(day, s, "Tag fiel aus") for s in movable]
        return "; ".join(results) or "Nichts zu verschieben"

    def limit(self, day: date, minutes: int) -> str:
        sessions = self._get(day)
        fixed = [s for s in sessions if s["sport"] == "sail"]
        rest = sorted((s for s in sessions if s["sport"] != "sail"),
                      key=lambda s: (not s.get("key"), PRIORITY.get(s["sport"], 4)))
        left, kept, notes = minutes, [], []
        for s in rest:
            if s["duration_min"] <= left:
                kept.append(s)
                left -= s["duration_min"]
            elif s["sport"] == "run" and left >= 20 and left >= s["duration_min"] * 0.5:
                f = left / s["duration_min"]
                s2 = dict(s, duration_min=left, adjusted=f"Auf {left}' gekürzt – nur {minutes}' Zeit")
                if s2.get("distance_km"):
                    s2["distance_km"] = round(s["distance_km"] * f, 1)
                kept.append(s2)
                notes.append(f"{s['title']} auf {left}' gekürzt")
                left = 0
            elif s.get("key") and s["sport"] == "run":
                notes.append(self._move(day, s, f"nur {minutes}' Zeit"))
                if left >= 20:
                    easy = dict(s, id=f"{day.isoformat()}-run-easy-short", key=False, profile="easy",
                                title="Lockerer Lauf", detail=f"{left}' locker", duration_min=left,
                                adjusted="Ersatz für die verschobene Schlüsseleinheit")
                    if s.get("distance_km"):
                        easy["distance_km"] = round(left / 5.8, 1)
                    kept.append(easy)
                    left = 0
            else:
                notes.append(f"{s['title']} entfällt")
        self._set(day, fixed + kept)
        return "; ".join(notes) or f"Passt in {minutes}'"

    def feel_bad(self, day: date) -> str:
        status = {"score": 30, "level": "red", "reasons": ["Selbstauskunft: fühle mich nicht gut"]}
        overrides = adapt_day(day, self.days, status)
        for iso, ov in overrides.items():
            self._set(date.fromisoformat(iso), ov["sessions"])
        return (overrides.get(day.isoformat()) or {}).get("note") or "Heute nur locker"

    def apply(self, cmd: dict) -> str | None:
        try:
            day = date.fromisoformat(cmd["date"])
        except (KeyError, ValueError):
            return None
        if day < self.today:
            return None
        kind = cmd["type"]
        if kind == "skip":
            text = self.skip(day, cmd.get("session_id"), cmd.get("mode", "move"))
        elif kind == "day_off":
            text = self.day_off(day)
        elif kind == "limit":
            text = self.limit(day, max(10, int(cmd.get("minutes", 30))))
        elif kind == "feel_bad":
            text = self.feel_bad(day)
        else:
            return None
        label = "Heute" if day == self.today else WEEKDAYS_LONG[day.weekday()]
        line = f"{label}: {text}"
        if cmd.get("note"):
            line += f" („{str(cmd['note'])[:80]}“)"
        self.notes.append(line)
        return line
