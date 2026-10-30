"""Unit conversions for coastal passage planning."""

# Distances at sea are measured in nautical miles; speeds in knots (nautical miles per hour).
KM_PER_MILE = 1.609


def nm_to_km(nm: float) -> float:
    """Convert nautical miles to kilometres."""
    return nm * KM_PER_MILE


def knots_to_kmh(knots: float) -> float:
    """Convert a speed in knots to kilometres per hour."""
    return knots * KM_PER_MILE
