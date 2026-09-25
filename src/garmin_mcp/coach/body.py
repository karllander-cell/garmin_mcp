"""Body-weight goal: morning weigh-ins, target curve and daily nutrition targets."""

from datetime import date, timedelta


def target_kg(body: dict, d: date) -> float:
    start = date.fromisoformat(body["start_date"])
    weeks = max(0, (d - start).days) / 7
    return round(min(body["target_kg"], body["start_kg"] + body["rate_kg_week"] * weeks), 2)


def rolling_avg(weights: dict[str, float], d: date, days: int = 7) -> float | None:
    vals = [weights[(d - timedelta(days=i)).isoformat()] for i in range(days) if (d - timedelta(days=i)).isoformat() in weights]
    return round(sum(vals) / len(vals), 2) if vals else None


def record(state: dict, iso: str, kg) -> bool:
    try:
        kg = round(float(kg), 1)
    except (TypeError, ValueError):
        return False
    if not 35 <= kg <= 160:
        return False
    state.setdefault("weights", {})[iso] = kg
    return True


def view(body: dict, weights: dict[str, float], wellness: dict[str, dict], today: date) -> dict:
    start = date.fromisoformat(body["start_date"])
    first = min([start] + [date.fromisoformat(d) for d in weights])
    span_start = max(first, today - timedelta(days=120))
    series = []
    d = span_start
    while d <= today:
        iso = d.isoformat()
        series.append({"date": iso, "kg": weights.get(iso), "avg7": rolling_avg(weights, d), "target": target_kg(body, d)})
        d += timedelta(days=1)
    current = rolling_avg(weights, today) or (weights[max(weights)] if weights else body["start_kg"])
    week_ago = rolling_avg(weights, today - timedelta(days=7))
    kcal = [w["kcal_total"] for k, w in sorted(wellness.items()) if k < today.isoformat() and w.get("kcal_total")][-7:]
    tdee = round(sum(kcal) / len(kcal)) if kcal else None
    weeks_needed = (body["target_kg"] - body["start_kg"]) / body["rate_kg_week"] if body["rate_kg_week"] else 0
    goal_date = start + timedelta(weeks=weeks_needed)
    target_now = target_kg(body, today)
    gap = round(current - target_now, 1)
    return {
        "start_kg": body["start_kg"],
        "target_kg": body["target_kg"],
        "rate_kg_week": body["rate_kg_week"],
        "goal_date": goal_date.isoformat(),
        "today_kg": weights.get(today.isoformat()),
        "current_kg": current,
        "target_today": target_now,
        "gap_kg": gap,
        "status": "on_track" if abs(gap) <= 0.7 else "behind" if gap < 0 else "ahead",
        "week_change": round(current - week_ago, 2) if week_ago else None,
        "tdee": tdee,
        "kcal_target": round((tdee + body["surplus_kcal"]) / 10) * 10 if tdee else None,
        "surplus_kcal": body["surplus_kcal"],
        "protein_g": round(current * body["protein_g_per_kg"]),
        "carbs_g": [round(current * 5), round(current * 7)],
        "fat_g": round(current * 1.0),
        "series": series,
        "entries": len(weights),
    }
