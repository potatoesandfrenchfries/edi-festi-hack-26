"""Use class from OSM and Overture tags (design section 6). Pure functions; stage 03 will build on these in M2.

The template build (milestone M3) calls `classify` so the map has a class to draw hourly curves for. Tags that say nothing
(`building=yes`) fall through to the next source, and a building no source describes is `unknown`.
"""

# OSM `building=*` and Overture `class` share one vocabulary of building words.
BY_BUILDING_WORD = {
    "residential": ["apartments", "house", "residential", "terrace", "detached", "semidetached_house", "mews", "flats", "bungalow",
                    "dormitory", "semi", "townhouse", "student_accommodation"],
    "retail": ["retail", "supermarket", "kiosk", "shop", "shops", "mall", "department_store"],
    "office": ["office", "commercial", "bank"],
    "hospitality": ["hotel", "restaurant", "pub", "hostel", "guest_house", "cafe", "bar"],
    "education": ["university", "school", "college", "kindergarten", "education"],
    "civic": ["civic", "public", "government", "hospital", "church", "cathedral", "chapel", "religious", "theatre", "museum",
              "train_station", "station", "library", "fire_station", "police", "clinic", "synagogue", "mosque"],
    "industrial": ["industrial", "warehouse", "garage", "garages", "service", "shed", "carport", "outbuilding", "storage_tank",
                   "factory", "hangar"],
}  # fmt: skip
BY_AMENITY = {
    "hospitality": ["pub", "bar", "restaurant", "cafe", "fast_food", "nightclub", "biergarten"],
    "education": ["school", "university", "college", "kindergarten"],
    "civic": ["place_of_worship", "theatre", "library", "community_centre", "arts_centre", "townhall", "hospital", "clinic",
              "courthouse", "cinema", "police", "fire_station"],
    "residential": ["student_accommodation"],  # communal establishments count as residential (C22)
    "office": ["bank"],
}  # fmt: skip
BY_TOURISM = {"hospitality": ["hotel", "guest_house", "hostel", "motel"], "civic": ["museum", "gallery", "attraction"]}
BY_OVERTURE_SUBTYPE = {
    "residential": "residential", "commercial": "office", "education": "education", "religious": "civic",
    "entertainment": "civic", "outbuilding": "industrial", "service": "industrial", "civic": "civic",
    "transportation": "civic", "medical": "civic", "industrial": "industrial",
}  # fmt: skip


def _invert(table):
    return {word: use_class for use_class, words in table.items() for word in words}


_BUILDING_WORD, _AMENITY, _TOURISM = _invert(BY_BUILDING_WORD), _invert(BY_AMENITY), _invert(BY_TOURISM)


def classify(*, osm_building=None, osm_amenity=None, osm_shop=None, osm_office=None, osm_tourism=None, overture_subtype=None,
             overture_class=None):  # fmt: skip
    """(use_class, use_src) for one building. Specific OSM tags beat the generic building word, which beats Overture."""
    if osm_shop:
        return "retail", "osm"
    if osm_office:
        return "office", "osm"
    for table, value in ((_AMENITY, osm_amenity), (_TOURISM, osm_tourism), (_BUILDING_WORD, osm_building)):
        if value in table:
            return table[value], "osm"
    if overture_class in _BUILDING_WORD:
        return _BUILDING_WORD[overture_class], "overture"
    if overture_subtype in BY_OVERTURE_SUBTYPE:
        return BY_OVERTURE_SUBTYPE[overture_subtype], "overture"
    return "unknown", None
