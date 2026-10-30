"""Dataset registry.

Everything here is derived from the CSV *headers* only (see dataset/README.md).
Column names are the normalised form: lower case, runs of non-alphanumerics
collapsed to "_" (so "Instance: Band E Base Price " -> instance_band_e_base_price).
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATASET_DIR = Path(os.environ.get("DATASET_DIR", ROOT / "dataset"))
PROCESSED_DIR = DATASET_DIR / "_processed"  # inside dataset/, so git-ignored
REPORTS_DIR = Path(os.environ.get("REPORTS_DIR", ROOT / "reports"))  # git-ignored

# Nothing smaller than this is ever written to a report: category counts,
# segment sizes and pairwise-complete sample sizes below it are suppressed.
MIN_CELL = 10


@dataclass(frozen=True)
class Feature:
    """A derived column. Skipped (with a warning) if any `requires` column is missing."""

    name: str
    sql: str
    requires: tuple[str, ...] = ()


@dataclass(frozen=True)
class Source:
    """One CSV (or a glob of same-shaped CSVs) loaded as a single table."""

    name: str
    pattern: str  # glob relative to DATASET_DIR
    drop: tuple[str, ...] = ()  # removed before anything else is read (direct PII)
    hash: tuple[str, ...] = ()  # replaced by a salted hash (pseudonymised keys)
    ids: tuple[str, ...] = ()  # numeric-looking identifiers: always kept as text
    dates: tuple[str, ...] = ()  # parsed to TIMESTAMP
    times: tuple[str, ...] = ()  # parsed to minutes since midnight
    presence: str = r"$^"  # regex: single-valued columns matching this are 0/1 flags
    encoding: str = "utf-8"  # DuckDB read_csv encoding: utf-8, utf-16 or latin-1
    derived: tuple[Feature, ...] = ()


@dataclass(frozen=True)
class Rollup:
    """A view built on another table: one row per `key` (group=True), or the
    base table plus other rollups joined on `key` (group=False)."""

    name: str
    base: str
    key: str
    features: tuple[Feature, ...] = ()
    group: bool = True
    flags_max: bool = False  # also carry every 0/1 flag column of `base` via max()
    join: tuple[str, ...] = ()


@dataclass(frozen=True)
class Analysis:
    """Optional segment breakdowns for the report."""

    table: str
    segment_by: tuple[str, ...] = ()
    segment_metrics: tuple[str, ...] = ()


EIF = Source(
    name="eif",
    # the "- Copy" file is excluded on purpose: this pattern requires "full set.csv"
    pattern="EIF 2026/*20?? full set.csv",
    encoding="latin-1",  # the EIF exports are not valid UTF-8 (checked with iconv, no content read)
    hash=("owner_id",),
    dates=("date_created", "date_confirmed", "event_date_time"),
    presence=r"booker|dotdigital",
    derived=(
        Feature("season_year", r"try_cast(regexp_extract(source_file, '(\d{4}) full set', 1) AS INTEGER)"),
        Feature("lead_days", "(epoch(event_date_time) - epoch(date_created)) / 86400.0",
                ("event_date_time", "date_created")),
        Feature("confirm_delay_minutes", "(epoch(date_confirmed) - epoch(date_created)) / 60.0",
                ("date_confirmed", "date_created")),
        Feature("booked_hour", "hour(date_created)", ("date_created",)),
        Feature("booked_dow", "dayofweek(date_created)", ("date_created",)),
        Feature("event_hour", "hour(event_date_time)", ("event_date_time",)),
        Feature("event_dow", "dayofweek(event_date_time)", ("event_date_time",)),
    ),
)

EIF_CUSTOMERS = Rollup(
    name="eif_customers",
    base="eif",
    key="owner_id",
    flags_max=True,  # booking-history / dotdigital columns are customer-level attributes
    features=(
        Feature("tickets", "count(*)"),
        Feature("spend", "sum(price)", ("price",)),
        Feature("mean_price", "avg(price)", ("price",)),
        Feature("n_events", "count(DISTINCT event_name)", ("event_name",)),
        Feature("n_venues", "count(DISTINCT venue_name)", ("venue_name",)),
        Feature("n_seasons", "count(DISTINCT season_year)", ("season_year",)),
        Feature("mean_lead_days", "avg(lead_days)", ("lead_days",)),
    ),
)

FRINGE = Source(
    name="fringe",
    pattern="Fringe 2026/Fringe2026AllTicketsSold_Clean.csv",
    drop=("customer_email",),
    hash=("transaction_id", "customer_id", "customer_number", "transaction_user_code"),
    ids=("item_id", "venue_id", "subvenue_id", "event_id", "event_code", "performance_id"),
    dates=("transaction_date", "performance_date", "sale_date"),
    times=("sale_time",),
    derived=(
        Feature("lead_days", "(epoch(performance_date) - epoch(sale_date)) / 86400.0",
                ("performance_date", "sale_date")),
        Feature("sale_hour", "sale_time // 60", ("sale_time",)),
        Feature("revenue_per_ticket", "revenue / nullif(tickets, 0)", ("revenue", "tickets")),
        Feature("face_value_ratio", "(revenue / nullif(tickets, 0)) / nullif(ticket_face_value, 0)",
                ("revenue", "tickets", "ticket_face_value")),
    ),
)

FRINGE_CUSTOMERS = Rollup(
    name="fringe_customers",
    base="fringe",
    key="customer_id",
    features=(
        Feature("tickets_total", "sum(tickets)", ("tickets",)),
        Feature("revenue_total", "sum(revenue)", ("revenue",)),
        Feature("n_transactions", "count(DISTINCT transaction_id)", ("transaction_id",)),
        Feature("n_events", "count(DISTINCT event_id)", ("event_id",)),
        Feature("n_venues", "count(DISTINCT venue_id)", ("venue_id",)),
        Feature("mean_lead_days", "avg(lead_days)", ("lead_days",)),
        Feature("share_free", "avg(is_free)", ("is_free",)),
        Feature("share_2for1", "avg(is_2for1)", ("is_2for1",)),
        Feature("share_pa", "avg(is_pa)", ("is_pa",)),
    ),
)

TATTOO_LINES = Source(
    name="tattoo_lines",
    pattern="Tattoo 2026/ticket_lines.csv",
    hash=("order_ref", "customer_ref"),
    dates=("order_date", "performance_date"),
    times=("performance_time",),
    derived=(
        Feature("lead_days", "(epoch(performance_date) - epoch(order_date)) / 86400.0",
                ("performance_date", "order_date")),
        Feature("performance_hour", "performance_time // 60", ("performance_time",)),
        Feature("performance_dow", "dayofweek(performance_date)", ("performance_date",)),
        Feature("line_value", "price_per_ticket_gross * tickets", ("price_per_ticket_gross", "tickets")),
    ),
)

TATTOO_LINES_BY_CUSTOMER = Rollup(
    name="tattoo_lines_by_customer",
    base="tattoo_lines",
    key="customer_ref",
    features=(
        Feature("lines_tickets", "sum(tickets)", ("tickets",)),
        Feature("lines_spend", "sum(line_value)", ("line_value",)),
        Feature("lines_orders", "count(DISTINCT order_ref)", ("order_ref",)),
        Feature("lines_mean_price", "avg(price_per_ticket_gross)", ("price_per_ticket_gross",)),
        Feature("lines_mean_lead_days", "avg(lead_days)", ("lead_days",)),
        Feature("lines_share_comp", "avg(is_comp)", ("is_comp",)),
        Feature("lines_n_shows", "count(DISTINCT show_name)", ("show_name",)),
        Feature("lines_n_seasons", "count(DISTINCT season)", ("season",)),
    ),
)

TATTOO_CUSTOMER_FILE = Source(
    name="tattoo_customer_file",
    pattern="Tattoo 2026/customers.csv",
    hash=("customer_ref",),
    dates=("first_order_date", "last_order_date"),
    derived=(
        Feature("tenure_days", "(epoch(last_order_date) - epoch(first_order_date)) / 86400.0",
                ("last_order_date", "first_order_date")),
    ),
)

# customers.csv enriched with per-customer aggregates of ticket_lines.csv
TATTOO_CUSTOMERS = Rollup(
    name="tattoo_customers",
    base="tattoo_customer_file",
    key="customer_ref",
    group=False,
    join=("tattoo_lines_by_customer",),
)

SOURCES = (EIF, FRINGE, TATTOO_LINES, TATTOO_CUSTOMER_FILE)
# order matters: a rollup may only depend on sources and earlier rollups
ROLLUPS = (EIF_CUSTOMERS, FRINGE_CUSTOMERS, TATTOO_LINES_BY_CUSTOMER, TATTOO_CUSTOMERS)

# tables that are materialised to parquet and analysed
TABLES = (
    "eif", "eif_customers",
    "fringe", "fringe_customers",
    "tattoo_lines", "tattoo_customers",
)

ANALYSIS = (
    Analysis("eif", ("season_year", "sales_channel", "instance_category"), ("price", "lead_days")),
    Analysis("fringe", ("sales_channel", "type", "status"), ("revenue", "tickets", "lead_days")),
    Analysis("tattoo_lines", ("season", "sales_channel", "seat_category"), ("line_value", "lead_days")),
)
