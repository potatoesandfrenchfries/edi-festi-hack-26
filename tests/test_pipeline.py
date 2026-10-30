"""End-to-end test on synthetic CSVs that mimic the real headers.

No real data is used. The fixtures are random values under the real column names, in the
same encodings as the real files (EIF latin-1, Fringe UTF-8 with BOM).
"""
from __future__ import annotations

import csv
import random

import duckdb
import numpy as np
import pandas as pd
import pytest

from pipeline import analyze, build
from pipeline import config as C

N = 600
EMAILS = {f"person{i}@example.org" for i in range(50)}


def write_csv(path, header, rows, encoding="utf-8"):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", newline="", encoding=encoding) as f:
        w = csv.writer(f)
        w.writerow(header)
        w.writerows(rows)


def make_eif(root, year, rng, n=N):
    header = ["Owner Id", "Date Created", "Date Confirmed", "Event Name", "Event Date/Time",
              "Venue Name", "Instance: Category", "Instance: Band A Base Price ",
              "Price", "Sales Channel", "Postcode Sector", "Dotdigital Sync Tags:CULTUREBUFF",
              f"Booking History:{year} Booker"]
    rows = []
    for i in range(n):
        band = rng.choice([30, 60, 90])
        d = rng.randint(1, 27)
        rows.append([f"OWN{rng.randint(1, 120)}", f"{year}-03-{d:02d} 10:{i % 60:02d}:00",
                     f"{year}-03-{d:02d} 10:{(i + 3) % 60:02d}:00", rng.choice(["Café Show", "Gala"]),
                     f"{year}-08-{rng.randint(1, 27):02d} 19:30:00", rng.choice(["Hall A", "Hall B"]),
                     rng.choice(["Music", "Opera"]), band if rng.random() < 0.5 else "",
                     band + rng.gauss(0, 3), rng.choice(["Web", "Phone"]), f"EH{rng.randint(1, 9)} 1",
                     "Y" if rng.random() < 0.3 else "", "Y" if rng.random() < 0.5 else ""])
    write_csv(root / "EIF 2026" / f"Ticket - {year} full set.csv", header, rows, "latin-1")


def make_fringe(root, rng, n=N):
    header = ["item_id", "Transaction_ID", "Transaction_Date", "print_option", "Transaction_User_Code",
              "Customer_ID", "Customer_Number", "Customer_Email", "sales_channel", "Venue_ID",
              "Subvenue_ID", "Event_ID", "Event_Code", "Event_Name", "Performance_ID",
              "Performance_Date", "type", "Ticket_Face_Value", "status", "Sale_Date", "Sale_Time",
              "Performance_Day", "Tickets", "Revenue", "Is_2for1", "Is_PA", "Is_Free"]
    emails = sorted(EMAILS)
    rows = []
    for i in range(n):
        face, tickets = rng.choice([8, 12, 15]), rng.randint(1, 4)
        cust = rng.randint(1, 80)
        rows.append([i, f"T{rng.randint(1, 400)}", "05/08/2026", "print", f"U{rng.randint(1, 5)}",
                     f"C{cust}", 1000 + cust, emails[cust % len(emails)], rng.choice(["web", "box"]),
                     rng.randint(1, 30), 1, rng.randint(1, 50), "E1", "Some Show", rng.randint(1, 200),
                     f"{rng.randint(10, 25)}/08/2026", rng.choice(["Full", "Concession"]), face,
                     "sold", f"{rng.randint(1, 9):02d}/08/2026", f"{rng.randint(8, 22)}:30:00", "Mon",
                     tickets, tickets * face + rng.gauss(0, 1), rng.choice([0, 1]),
                     rng.choice([0, 1]), 0])
    write_csv(root / "Fringe 2026" / "Fringe2026AllTicketsSold_Clean.csv", header, rows, "utf-8-sig")


def make_tattoo(root, rng, n=N):
    lines_h = ["order_ref", "customer_ref", "order_date", "performance_date", "performance_time",
               "show_name", "season", "event_name", "event_locale", "seat_category", "ticket_type",
               "package_name", "sales_channel", "is_comp", "price_per_ticket_gross", "tickets",
               "postcode_outward", "postcode_area", "country"]
    lines = []
    for i in range(n):
        lines.append([f"O{i // 2}", f"CU{rng.randint(1, 100)}", f"2026-0{rng.randint(1, 6)}-10",
                      f"2026-08-{rng.randint(1, 25):02d}", "21:00", "Tattoo", rng.choice(["ET26", "ET25"]),
                      "Evening", "Esplanade", rng.choice(["A", "B"]), "Adult", "", rng.choice(["web", "phone"]),
                      "false", rng.choice([40.0, 60.0, 80.0]), rng.randint(1, 4), "EH1", "EH", "UK"])
    write_csv(root / "Tattoo 2026" / "ticket_lines.csv", lines_h, lines)
    cust_h = ["customer_ref", "postcode_outward", "postcode_area", "country", "first_order_date",
              "last_order_date", "seasons_attended", "season_count", "attended_et25", "attended_et26",
              "attended_et27", "orders", "tickets", "performances", "bought_hospitality"]
    cust = [[f"CU{i}", "EH1", "EH", "UK", "2025-01-05", f"2026-0{rng.randint(1, 6)}-10", "ET25;ET26", 2,
             rng.choice([0, 1]), 1, 0, rng.randint(1, 5), rng.randint(1, 9), 1, rng.choice(["true", "false"])]
            for i in range(1, 101)]
    write_csv(root / "Tattoo 2026" / "customers.csv", cust_h, cust)


@pytest.fixture(scope="module")
def built(tmp_path_factory):
    root = tmp_path_factory.mktemp("dataset")
    rng = random.Random(7)
    make_eif(root, 2025, rng)
    make_eif(root, 2026, rng)
    # a stray duplicate that must NOT be picked up by the EIF pattern
    make_eif(root, 2026, rng, n=5)
    (root / "EIF 2026" / "Ticket - 2026 full set.csv").rename(root / "EIF 2026" / "Ticket - 2026 full set - Copy.csv")
    make_eif(root, 2026, rng)
    make_fringe(root, rng)
    make_tattoo(root, rng)

    saved = (C.DATASET_DIR, C.PROCESSED_DIR, C.REPORTS_DIR)
    C.DATASET_DIR, C.PROCESSED_DIR = root, root / "_processed"
    C.REPORTS_DIR = tmp_path_factory.mktemp("reports")
    import os
    os.environ["PIPELINE_SALT"] = "test-salt"
    try:
        tables = build.run()
        analyze.run()
        yield tables
    finally:
        C.DATASET_DIR, C.PROCESSED_DIR, C.REPORTS_DIR = saved


def read(name):
    return duckdb.connect().execute(f"SELECT * FROM read_parquet('{C.PROCESSED_DIR}/{name}.parquet')").df()


def test_all_tables_built(built):
    assert set(built) == set(C.TABLES)


def test_copy_file_excluded_and_years_stacked(built):
    eif = read("eif")
    assert len(eif) == 2 * N
    assert set(eif["season_year"]) == {2025, 2026}


def test_latin1_text_survives(built):
    assert "Café Show" in set(read("eif")["event_name"])


def test_email_dropped_and_ids_hashed(built):
    fr = read("fringe")
    assert "customer_email" not in fr.columns
    for col in ("customer_id", "customer_number", "transaction_id", "transaction_user_code"):
        assert fr[col].str.fullmatch(r"[0-9a-f]{16}").all(), col
    assert read("eif")["owner_id"].str.fullmatch(r"[0-9a-f]{16}").all()
    assert read("tattoo_lines")["customer_ref"].str.fullmatch(r"[0-9a-f]{16}").all()


def test_types_inferred(built):
    fr = read("fringe")
    assert pd.api.types.is_numeric_dtype(fr["revenue"])
    assert str(fr["sale_date"].dtype).startswith("datetime64")
    assert fr["sale_time"].between(0, 1439).all()          # minutes since midnight
    assert fr["lead_days"].between(0, 40).all()            # d/m/Y parsed day-first
    assert pd.api.types.is_string_dtype(fr["venue_id"])    # numeric-looking id kept as text
    eif = read("eif")
    assert set(eif["dotdigital_sync_tags_culturebuff"].dropna()) <= {0, 1}  # presence flag
    assert read("tattoo_customers")["bought_hospitality"].dropna().isin([0, 1]).all()


def test_customer_rollups(built):
    eif_c = read("eif_customers")
    assert eif_c["owner_id"].is_unique
    assert eif_c["tickets"].sum() == 2 * N
    tc = read("tattoo_customers")
    assert tc["customer_ref"].is_unique and "lines_spend" in tc.columns   # join worked


def test_hashes_join_across_tables(built):
    assert set(read("tattoo_customers")["customer_ref"]) & set(read("tattoo_lines")["customer_ref"])


def test_covariance_outputs(built):
    d = C.REPORTS_DIR / "fringe"
    cor = pd.read_csv(d / "correlation.csv", index_col=0)
    cov = pd.read_csv(d / "covariance.csv", index_col=0)
    assert np.allclose(cor.fillna(0), cor.fillna(0).T)
    assert np.allclose(cov.fillna(0), cov.fillna(0).T)
    assert cor.loc["revenue", "tickets"] > 0.7             # planted: revenue = tickets * face value
    assert cor.loc["tickets", "tickets"] == 1
    assert (d / "REPORT.md").exists() and (d / "correlation.png").exists()
    pairs = pd.read_csv(d / "pairs.csv")
    assert pairs["corr"].abs().is_monotonic_decreasing


def test_reports_leak_nothing(built):
    blob = "".join(p.read_text(errors="ignore") for p in C.REPORTS_DIR.rglob("*") if p.suffix in {".csv", ".md"})
    assert not any(e in blob for e in EMAILS)
    assert "OWN1" not in blob and "@" not in blob


def test_small_groups_suppressed(built):
    for p in C.REPORTS_DIR.rglob("segments_*.csv"):
        assert (pd.read_csv(p)["rows"] >= C.MIN_CELL).all()
    lv = pd.read_csv(C.REPORTS_DIR / "fringe" / "category_levels.csv")
    assert (lv["n"] >= C.MIN_CELL).all()
