"""Passage time estimates for a sailing boat."""

from .units import nm_to_km


def speed_over_ground(boat_speed_knots: float, current_knots: float) -> float:
    """Speed over the ground in knots.

    `current_knots` is positive when the tide flows with you (a fair tide)
    and negative when it flows against you (a foul tide).
    """
    return boat_speed_knots - current_knots


def eta_hours(distance_nm: float, boat_speed_knots: float, current_knots: float = 0.0) -> float:
    """Hours needed to cover `distance_nm` at the given boat speed and current."""
    sog = speed_over_ground(boat_speed_knots, current_knots)
    if sog <= 0:
        raise ValueError("the boat makes no headway against this current")
    return distance_nm / sog


def describe(distance_nm: float, boat_speed_knots: float, current_knots: float = 0.0) -> str:
    """A one-line passage summary, e.g. '15 nm (27.8 km) in about 2 h 00 min'."""
    total_minutes = round(eta_hours(distance_nm, boat_speed_knots, current_knots) * 60)
    hours, minutes = divmod(total_minutes, 60)
    return f"{distance_nm:g} nm ({nm_to_km(distance_nm):.1f} km) in about {hours} h {minutes:02d} min"
