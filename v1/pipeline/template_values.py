"""Stand-in building values for the visualisation template (milestone M3, while the census allocation M2 is paused).

Every number here is a placeholder estimate proportional to floor area. None of it comes from the census. The column names
(`res_pop`, `work_pop`) are the ones the census allocation will produce, so it can replace this module without touching the web app.
"""


def template_values(use_class, floor_area_m2, model, weights):
    """(res_pop, work_pop) for one building from its class and floor area.

    Residential floor area houses residents. Other classes employ workers in proportion to the class's use weight. Mixed and
    unknown buildings split their floor area between the two by `mixed_use_residential_share`.
    """
    template = model["template_values"]
    residents_per_m2, workers_per_m2 = template["residents_per_m2"], template["workers_per_m2"]
    if use_class == "residential":
        res_area, work_area = floor_area_m2, floor_area_m2  # the class weight keeps home-based work small
    elif use_class in ("mixed", "unknown"):
        share = model["mixed_use_residential_share"]
        res_area, work_area = floor_area_m2 * share, floor_area_m2 * (1.0 - share)
    else:
        res_area, work_area = 0.0, floor_area_m2
    return res_area * residents_per_m2, work_area * workers_per_m2 * weights[use_class]
