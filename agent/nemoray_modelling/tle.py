"""Load Starlink TLEs: live CelesTrak fetch -> disk cache -> bundled snapshot."""

from __future__ import annotations

import logging
import tempfile
import time
import urllib.request
from pathlib import Path

from skyfield.api import EarthSatellite, load

logger = logging.getLogger(__name__)

CELESTRAK_URL = (
    "https://celestrak.org/NORAD/elements/gp.php?GROUP=starlink&FORMAT=tle"
)
_DATA_DIR = Path(__file__).parent / "data"
BUNDLED_SNAPSHOT = _DATA_DIR / "starlink_tle.txt"
CACHE_PATH = Path(tempfile.gettempdir()) / "nemoray_starlink_tle.txt"


def parse_tles(text: str, ts) -> list[EarthSatellite]:
    """Parse 3-line-element text into Skyfield EarthSatellite objects."""
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    sats: list[EarthSatellite] = []
    i = 0
    # A truncated triple at the end of the input is discarded.
    while i + 2 < len(lines):
        name, line1, line2 = lines[i], lines[i + 1], lines[i + 2]
        if line1.startswith("1 ") and line2.startswith("2 "):
            try:
                sats.append(EarthSatellite(line1, line2, name, ts))
            except (ValueError, IndexError) as exc:
                logger.warning("Skipping malformed TLE %r: %s", name, exc)
            i += 3
        else:
            i += 1
    return sats


# CelesTrak returns HTTP 403 to the default urllib User-Agent, so send a
# browser-like one.
_USER_AGENT = "Mozilla/5.0 (compatible; NeMo-Ray/0.1; +https://github.com/)"


def _fetch_live(url: str = CELESTRAK_URL, timeout: int = 30) -> str:
    request = urllib.request.Request(url, headers={"User-Agent": _USER_AGENT})
    with urllib.request.urlopen(request, timeout=timeout) as resp:  # noqa: S310
        return resp.read().decode("utf-8")


def _read_cache() -> str | None:
    if CACHE_PATH.exists():
        return CACHE_PATH.read_text(encoding="utf-8")
    return None


def _cache_age_hours() -> float | None:
    if not CACHE_PATH.exists():
        return None
    return (time.time() - CACHE_PATH.stat().st_mtime) / 3600.0


def load_starlink_tles(
    *,
    force_refresh: bool = False,
    max_cache_age_hours: float = 24.0,
    ts=None,
) -> list[EarthSatellite]:
    """Resolve Starlink TLEs from the freshest available source."""
    ts = ts or load.timescale()

    age = _cache_age_hours()
    if not force_refresh and age is not None and age <= max_cache_age_hours:
        cached = _read_cache()
        if cached:
            logger.info("Using cached Starlink TLEs (%.1f h old)", age)
            return parse_tles(cached, ts)

    try:
        text = _fetch_live()
        sats = parse_tles(text, ts)
        if sats:
            CACHE_PATH.write_text(text, encoding="utf-8")
            logger.info("Fetched live Starlink TLEs from CelesTrak (%d sats)", len(sats))
            return sats
        logger.warning("Live TLE fetch returned no satellites; falling back")
    except Exception as exc:  # noqa: BLE001 - any failure should fall back
        logger.warning("Live TLE fetch failed (%s); falling back", exc)

    cached = _read_cache()
    if cached:
        logger.info("Using cached Starlink TLEs as fallback")
        return parse_tles(cached, ts)

    if BUNDLED_SNAPSHOT.exists():
        logger.info("Using bundled Starlink TLE snapshot")
        return parse_tles(BUNDLED_SNAPSHOT.read_text(encoding="utf-8"), ts)

    raise RuntimeError(
        "Could not load Starlink TLEs from live fetch, cache, or bundled snapshot"
    )
