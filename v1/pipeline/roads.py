"""OpenStreetMap ways to the compact directed road graph the car simulation reads (web/public/data/roads.json).

The class filter, speed and lane parsing, splitting at junctions, keeping the largest strongly connected part and snapping
traffic signals. Reads Overpass JSON ('out geom'); the output is the layout the car engine reads.
"""

import re
from collections import Counter
from math import asin, cos, radians, sin, sqrt

MPH = 0.44704
# Parking aisles and drive-throughs are not through roads; emergency access forbids private cars.
EXCLUDED_SERVICE = {"parking_aisle", "drive-through", "emergency_access"}
FORBIDDING = {"no", "private", "agricultural", "forestry", "delivery", "customers", "destination_only_permit"}
ONEWAY_CLASSES = {"motorway", "motorway_link"}
ZONE_NAMES = ["core", "ring", "outer"]  # zone index 0, 1, 2: the most detailed road network first


def exclusion(tags, classes):
    """None for roads cars may use in this build, else the reason it is left out."""
    highway = tags.get("highway")
    if highway not in classes:
        return f"class {highway} not included"
    if tags.get("area") == "yes":
        return "area"
    if highway == "service" and tags.get("service") in EXCLUDED_SERVICE:
        return f"service={tags.get('service')}"
    for key in ("motorcar", "motor_vehicle", "vehicle", "access"):  # most specific first
        if key in tags:
            if tags[key] in FORBIDDING:
                return f"{key}={tags[key]}"
            if tags[key] in ("yes", "designated", "permissive"):
                break
    return None


def speed_limit(tags, defaults_mph):
    """(m/s, inferred?) from maxspeed, else the configured class default."""
    match = re.match(r"\s*(\d+(?:\.\d+)?)\s*(mph|km/h|kmh)?", tags.get("maxspeed", ""))
    if match:
        value = float(match.group(1))
        return round(value * (MPH if match.group(2) == "mph" else 1 / 3.6), 2), False
    return round(defaults_mph[tags["highway"]] * MPH, 2), True


def lanes_per_direction(tags, oneway):
    def number(key):
        match = re.match(r"\s*(\d+)", tags.get(key, ""))
        return int(match.group(1)) if match else None

    total = number("lanes")
    if oneway:
        return min(4, total or 1), 0
    forward, backward = number("lanes:forward"), number("lanes:backward")
    half = max(1, (total or 2) // 2)
    return min(4, forward or half), min(4, backward or half)


def zone_boxes(pilot_bng, core_buffer_m, ring_buffer_m):
    """[core, ring] as EPSG:27700 boxes (min_e, min_n, max_e, max_n): the pilot box grown by each buffer. Everything else is the outer zone."""
    west, south, east, north = pilot_bng
    return [(west - b, south - b, east + b, north + b) for b in (core_buffer_m, ring_buffer_m)]


def bng_box_to_wgs84(box):
    """WGS84 (south, west, north, east) of the smallest box holding an EPSG:27700 box, for Overpass."""
    from pyproj import Transformer

    to_wgs84 = Transformer.from_crs(27700, 4326, always_xy=True)
    corners = [to_wgs84.transform(x, y) for x in (box[0], box[2]) for y in (box[1], box[3])]
    return min(c[1] for c in corners), min(c[0] for c in corners), max(c[1] for c in corners), max(c[0] for c in corners)


def zone_function(boxes):
    """zone(lon, lat) -> 0 inside the first box, 1 inside the second, else 2. Boxes are EPSG:27700 and nested."""
    from pyproj import Transformer

    to_bng = Transformer.from_crs(4326, 27700, always_xy=True)

    def zone(lon, lat):
        easting, northing = to_bng.transform(lon, lat)
        for index, (west, south, east, north) in enumerate(boxes):
            if west <= easting <= east and south <= northing <= north:
                return index
        return len(boxes)

    return zone


def zone_queries(classes, zone_classes):
    """[(zone, classes)] to fetch: each zone asks only for the classes no wider zone already returns. The outer query covers the whole
    area, the ring query its box, the core query the core box, so the three together hold every class in every zone."""
    ring, outer = (set(zone_classes[k]) for k in ("ring", "outer"))
    wanted = [("outer", sorted(outer)), ("ring", sorted(ring - outer)), ("core", sorted(set(classes) - ring))]
    return [(zone, names) for zone, names in wanted if names]


def haversine(lon1, lat1, lon2, lat2):
    a = sin(radians(lat2 - lat1) / 2) ** 2 + cos(radians(lat1)) * cos(radians(lat2)) * sin(radians(lon2 - lon1) / 2) ** 2
    return 2 * 6371008.8 * asin(sqrt(a))


def strongly_connected(successors):
    """Iterative Tarjan over the edge graph; returns the largest component."""
    index, low, on_stack, stack, best = {}, {}, set(), [], set()
    counter = 0
    for root in successors:
        if root in index:
            continue
        work = [(root, iter(successors[root]))]
        index[root] = low[root] = counter
        counter += 1
        stack.append(root)
        on_stack.add(root)
        while work:
            node, children = work[-1]
            advanced = False
            for child in children:
                if child not in index:
                    index[child] = low[child] = counter
                    counter += 1
                    stack.append(child)
                    on_stack.add(child)
                    work.append((child, iter(successors.get(child, ()))))
                    advanced = True
                    break
                if child in on_stack:
                    low[node] = min(low[node], index[child])
            if advanced:
                continue
            work.pop()
            if work:
                low[work[-1][0]] = min(low[work[-1][0]], low[node])
            if low[node] == index[node]:
                component = set()
                while True:
                    member = stack.pop()
                    on_stack.discard(member)
                    component.add(member)
                    if member == node:
                        break
                if len(component) > len(best):
                    best = component
    return best


def snap_signals(points, edges, node_ids, metres=25):
    """Junction node indices with a signal within `metres`. Junctions join 3+ other nodes, so a lone pedestrian signal on a plain
    stretch of road matches nothing and is dropped."""
    neighbours, position = {}, {}
    for e in edges:
        neighbours.setdefault(e[0], set()).add(e[1])
        neighbours.setdefault(e[1], set()).add(e[0])
        position[e[0]] = e[7][:2]
        position[e[1]] = e[7][-2:]
    cell = 0.0005  # ~35 m in latitude, ~55 m in longitude: a 3x3 search covers 25 m
    grid = {}
    for ref, others in neighbours.items():
        if len(others) >= 3:
            lon, lat = position[ref]
            grid.setdefault((int(lon // cell), int(lat // cell)), []).append(ref)
    snapped = set()
    for lon, lat in points:
        best, best_distance = None, metres
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for ref in grid.get((int(lon // cell) + dx, int(lat // cell) + dy), ()):
                    distance = haversine(lon, lat, *position[ref])
                    if distance <= best_distance:
                        best, best_distance = ref, distance
        if best is not None:
            snapped.add(node_ids[best])
    return sorted(snapped)


def edge_midpoint(coords):
    """Mean of an edge's first and last vertex (lon, lat); the point that decides which zone an edge belongs to."""
    return (coords[0] + coords[-2]) / 2, (coords[1] + coords[-1]) / 2


def build_graph(elements, bbox, classes, defaults_mph, snap_metres=25, zoning=None):
    """(roads, stats) from Overpass elements: ways with 'nodes', 'geometry' and 'tags', plus traffic_signals nodes.

    Each edge is [from, to, class index, lanes, speed m/s, speed inferred 0/1, two-way 0/1, length m, [lon, lat, ...], OSM way id,
    name index]. The two directions of a two-way road share the way id.

    `zoning` is None (every edge kept, as the pilot does) or (zone_of, zone_classes): zone_of(lon, lat) -> 0, 1 or 2 and zone_classes the
    class set each zone keeps. An edge belongs to the zone of its midpoint and is dropped if its class is not kept there. The result then
    has a "zones" list (one entry per edge) and a "zoneNames" list.
    """
    west, south, east, north = bbox

    def inside(lon, lat):
        return west <= lon <= east and south <= lat <= north

    excluded, ways, signal_points = Counter(), [], []
    for element in elements:
        tags = element.get("tags", {})
        if element["type"] == "node":
            if tags.get("highway") == "traffic_signals" and inside(element["lon"], element["lat"]):
                signal_points.append((element["lon"], element["lat"]))
            continue
        if element["type"] != "way" or "highway" not in tags:
            continue
        reason = exclusion(tags, classes)
        if reason:
            excluded[reason] += 1
            continue
        refs, geometry = element.get("nodes", []), element.get("geometry", [])
        nodes = [(ref, round(g["lon"], 6), round(g["lat"], 6)) for ref, g in zip(refs, geometry, strict=False) if g]
        if len(nodes) < 2 or not any(inside(lon, lat) for _, lon, lat in nodes):
            continue
        ways.append((element["id"], tags, nodes))

    # Split ways into edges at junctions: nodes shared by several ways, or way ends.
    uses = Counter(ref for _, _, nodes in ways for ref, *_ in nodes)
    edges = []  # [from_node, to_node, class, lanes, speed, inferred, two_way, coords, way_id, name, lanes inferred]
    for way_id, tags, nodes in ways:
        name = tags.get("name") or tags.get("ref") or ""
        oneway = (
            tags.get("oneway") in ("yes", "true", "1", "-1")
            or tags.get("junction") in ("roundabout", "circular")
            or tags["highway"] in ONEWAY_CLASSES
        )
        if tags.get("oneway") == "-1":
            nodes = nodes[::-1]
        forward, backward = lanes_per_direction(tags, oneway)
        lanes_inferred = int(not any(key in tags for key in ("lanes", "lanes:forward", "lanes:backward")))
        speed, inferred = speed_limit(tags, defaults_mph)
        piece = [nodes[0]]
        for node in nodes[1:]:
            piece.append(node)
            if uses[node[0]] > 1 or node is nodes[-1]:
                coords = [value for _, lon, lat in piece for value in (lon, lat)]
                edges.append(
                    [
                        piece[0][0],
                        piece[-1][0],
                        tags["highway"],
                        forward,
                        speed,
                        inferred,
                        not oneway,
                        coords,
                        way_id,
                        name,
                        lanes_inferred,
                    ]
                )
                if not oneway:
                    back = [value for _, lon, lat in piece[::-1] for value in (lon, lat)]
                    edges.append(
                        [
                            piece[-1][0],
                            piece[0][0],
                            tags["highway"],
                            backward,
                            speed,
                            inferred,
                            True,
                            back,
                            way_id,
                            name,
                            lanes_inferred,
                        ]
                    )
                piece = [node]

    edge_zone = None
    if zoning:
        zone_of, zone_classes = zoning
        edge_zone = [zone_of(*edge_midpoint(edge[7])) for edge in edges]
        allowed = [i for i, edge in enumerate(edges) if edge[2] in zone_classes[edge_zone[i]]]
        edges, edge_zone = [edges[i] for i in allowed], [edge_zone[i] for i in allowed]

    # Keep only the largest strongly connected part so no car can reach a dead end.
    leaving = {}
    for i, edge in enumerate(edges):
        leaving.setdefault(edge[0], []).append(i)
    keep = strongly_connected({i: leaving.get(edge[1], []) for i, edge in enumerate(edges)})
    kept = [edge for i, edge in enumerate(edges) if i in keep]
    if edge_zone is not None:
        edge_zone = [z for i, z in enumerate(edge_zone) if i in keep]
    node_ids = {ref: n for n, ref in enumerate(sorted({ref for edge in kept for ref in edge[:2]}))}
    class_names = sorted({edge[2] for edge in kept})
    names = sorted({edge[9] for edge in kept})
    name_index = {name: k for k, name in enumerate(names)}
    lengths = [sum(haversine(*edge[7][k : k + 4]) for k in range(0, len(edge[7]) - 2, 2)) for edge in kept]
    signals = snap_signals(signal_points, kept, node_ids, snap_metres)
    roads = {
        "bbox": list(bbox),
        "classes": class_names,
        "nodes": len(node_ids),
        "names": names,
        "signals": signals,
        "edges": [
            [
                node_ids[e[0]], node_ids[e[1]], class_names.index(e[2]), e[3], e[4], int(e[5]), int(e[6]), round(length, 1), e[7], e[8],
                name_index[e[9]],
            ]
            for e, length in zip(kept, lengths, strict=True)
        ],
    }  # fmt: skip
    if edge_zone is not None:
        roads["zoneNames"] = ZONE_NAMES
        roads["zones"] = edge_zone
    by_class = Counter(class_names[e[2]] for e in roads["edges"])
    stats = {
        "edges": len(kept),
        "droppedDisconnected": len(edges) - len(kept),
        "nodes": len(node_ids),
        "laneKm": round(sum(e[3] * e[7] for e in roads["edges"]) / 1000, 1),
        "roadKm": round(sum(lengths) / 1000, 1),
        "inferredSpeedShare": round(sum(e[5] for e in roads["edges"]) / max(1, len(kept)), 3),
        "inferredLanesShare": round(sum(e[10] for e in kept) / max(1, len(kept)), 3),
        "signals": {"osmNodes": len(signal_points), "junctions": len(signals)},
        "byClass": dict(by_class.most_common()),
        **({"byZone": zone_stats(roads, [e[10] for e in kept])} if edge_zone is not None else {}),
        "excludedWays": dict(excluded.most_common(12)),
    }
    return roads, stats


def zone_stats(roads, lanes_inferred):
    """Per zone: edges, directed km, lane-km, the shares of edges on a defaulted speed and lane count, and the size of its edge list as JSON."""
    import json

    stats = {}
    for index, name in enumerate(roads["zoneNames"]):
        picked = [(e, d) for e, z, d in zip(roads["edges"], roads["zones"], lanes_inferred, strict=True) if z == index]
        members = [e for e, _ in picked]
        stats[name] = {
            "edges": len(members),
            "km": round(sum(e[7] for e in members) / 1000, 1),
            "laneKm": round(sum(e[3] * e[7] for e in members) / 1000, 1),
            "inferredSpeedShare": round(sum(e[5] for e in members) / max(1, len(members)), 3),
            "inferredLanesShare": round(sum(d for _, d in picked) / max(1, len(members)), 3),
            "edgeListKB": round(len(json.dumps(members, separators=(",", ":"))) / 1024),
        }
    return stats
