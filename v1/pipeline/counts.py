"""Traffic counts to road-graph edges: which DfT count points to trust and which directed edges each one measures.

Pure functions over plain dicts and the roads.json layout (an edge is [from, to, class, lanes, speed, inferred, two_way, length,
[lon, lat, ...], way id, name]); pipeline/stage14_counts.py reads the files and writes web/public/data/flows.json.

A DfT AADF is the annual average daily flow of *both* directions of a link, so it is shared between the directions matched (one for a
one-way road, two for a two-way road, or the two carriageways of a dual carriageway). It is a daily figure, not an hourly one.
"""

import re
from math import cos, hypot, radians
from statistics import median

M_PER_DEG = 111195.0  # metres per degree of latitude on the sphere haversine() in pipeline/roads.py uses


def select_counts(rows, config):
    """One count per count point: the latest year that passes the config filters. Each is a dict with the fields matching needs."""
    chosen = {}
    for row in rows:
        year = row["year"]
        if year < config["first_year"] or year in config["excluded_years"]:
            continue
        if config["counted_only"] and row["estimation_method"] != "Counted":
            continue
        point = row["count_point_id"]
        if point not in chosen or year > chosen[point]["year"]:
            chosen[point] = {
                "id": point,
                "year": year,
                "road": row["road_name"],
                "category": row["road_category"],
                "lon": float(row["longitude"]),
                "lat": float(row["latitude"]),
                "aadf": row["all_motor_vehicles"],
                "linkKm": None if row.get("link_length_km") is None else float(row["link_length_km"]),
            }
    return [chosen[k] for k in sorted(chosen)]


def to_metres(lon, lat, lon0, lat0):
    return (lon - lon0) * cos(radians(lat0)) * M_PER_DEG, (lat - lat0) * M_PER_DEG


def distance_to_polyline(lon, lat, coords):
    """Metres from a point to the nearest part of a polyline given as [lon, lat, lon, lat, ...] (flat-earth, fine at city scale)."""
    best = float("inf")
    ax, ay = to_metres(coords[0], coords[1], lon, lat)
    for k in range(2, len(coords), 2):
        bx, by = to_metres(coords[k], coords[k + 1], lon, lat)
        dx, dy = bx - ax, by - ay
        length_squared = dx * dx + dy * dy
        t = 0.0 if length_squared == 0 else max(0.0, min(1.0, -(ax * dx + ay * dy) / length_squared))
        best = min(best, hypot(ax + t * dx, ay + t * dy))
        ax, ay = bx, by
    return best


def heading(coords):
    """Unit vector (east, north) from an edge's first to its last vertex, or None for a loop."""
    dx, dy = to_metres(coords[-2], coords[-1], coords[0], coords[1])
    length = hypot(dx, dy)
    return None if length == 0 else (dx / length, dy / length)


def opposite(a, b):
    """True when two headings point broadly against each other (carriageways of a dual carriageway)."""
    return a is not None and b is not None and a[0] * b[0] + a[1] * b[1] < -0.5


def match_point(point, edges, class_names, categories, max_metres, bounds):
    """(edge indices, distance in metres) or (None, reason). `bounds` are per-edge (min lon, min lat, max lon, max lat) boxes.

    The nearest edge of a compatible class within `max_metres` is the match, with its reverse edge if the road is two-way. A one-way
    edge has no reverse, so a parallel one-way edge of the same class running the other way within twice that distance is taken as the
    other carriageway; the count then covers both.
    """
    allowed = set(categories.get(point["category"], ()))
    pad = 2 * max_metres / M_PER_DEG * 1.5
    lon, lat = point["lon"], point["lat"]
    near = []
    for i, e in enumerate(edges):
        x0, y0, x1, y1 = bounds[i]
        if x0 - pad <= lon <= x1 + pad and y0 - pad <= lat <= y1 + pad:
            near.append((distance_to_polyline(lon, lat, e[8]), i))
    if not near:
        return None, "no road within range"
    compatible = [(d, i) for d, i in near if class_names[edges[i][2]] in allowed]
    within = [(d, i) for d, i in compatible if d <= max_metres]
    if not within:
        if any(d <= max_metres for d, _ in near):
            return None, "no road of a compatible class within range"
        return None, "no road within range"
    distance, best = min(within)
    edge = edges[best]
    chosen = [best]
    reverse = [i for d, i in compatible if edges[i][0] == edge[1] and edges[i][1] == edge[0] and edges[i][9] == edge[9]]
    if reverse:
        chosen.append(min(reverse))
    elif not edge[6]:  # one-way: look for the other carriageway
        mine = heading(edge[8])
        others = [
            (d, i) for d, i in compatible
            if d <= 2 * max_metres and edges[i][2] == edge[2] and edges[i][9] != edge[9] and opposite(mine, heading(edges[i][8]))
        ]  # fmt: skip
        if others:
            chosen.append(min(others)[1])
    return chosen, round(distance, 1)


def edge_bounds(edges):
    return [(min(e[8][0::2]), min(e[8][1::2]), max(e[8][0::2]), max(e[8][1::2])) for e in edges]


def match_counts(points, roads, categories, max_metres):
    """(matches, unmatched). A match is [edge index, daily flow on that edge, directions sharing the count, distance m, count point id,
    year]; the daily flow is the count's AADF divided by the directions."""
    edges, class_names = roads["edges"], roads["classes"]
    bounds = edge_bounds(edges)
    matches, unmatched = [], []
    for point in points:
        chosen, outcome = match_point(point, edges, class_names, categories, max_metres, bounds)
        if chosen is None:
            unmatched.append([point["id"], point["road"], outcome])
            continue
        for i in chosen:
            matches.append([i, round(point["aadf"] / len(chosen)), len(chosen), outcome, point["id"], point["year"]])
    return matches, unmatched


def class_medians(matches, roads):
    """{class: (count points matched, median daily flow per matched directed edge)}; the per-class figure placement can fall back on."""
    per_class = {}
    for i, flow, *_ in matches:
        per_class.setdefault(roads["classes"][roads["edges"][i][2]], []).append(flow)
    points = {}
    for i, _, _, _, point, _ in matches:
        points.setdefault(roads["classes"][roads["edges"][i][2]], set()).add(point)
    return {c: (len(points[c]), median(v)) for c, v in sorted(per_class.items())}


def parse_popularity(source):
    """The engine's guessed class weights, read from the POPULARITY table in web/src/engine/car-sim.mjs."""
    body = re.search(r"const POPULARITY = \{(.*?)\};", source, re.DOTALL).group(1)
    return {name: float(value) for name, value in re.findall(r"(\w+):\s*([\d.]+)", body)}


def spearman(xs, ys):
    """Rank correlation of two equal-length lists (average ranks for ties); None if either has no spread."""

    def ranks(values):
        order = sorted(range(len(values)), key=lambda i: values[i])
        out, k = [0.0] * len(values), 0
        while k < len(order):
            j = k
            while j + 1 < len(order) and values[order[j + 1]] == values[order[k]]:
                j += 1
            for m in range(k, j + 1):
                out[order[m]] = (k + j) / 2 + 1
            k = j + 1
        return out

    if len(xs) < 3 or len(set(xs)) < 2 or len(set(ys)) < 2:
        return None
    rx, ry = ranks(xs), ranks(ys)
    mx, my = sum(rx) / len(rx), sum(ry) / len(ry)
    cov = sum((a - mx) * (b - my) for a, b in zip(rx, ry, strict=True))
    return cov / (sum((a - mx) ** 2 for a in rx) * sum((b - my) ** 2 for b in ry)) ** 0.5
