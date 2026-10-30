# Datasets

Ticketing extracts from three Edinburgh festivals, supplied for the 2026 hackathon.
**The data files are personal/commercial data: they are git-ignored and must stay local.**
This README is the only tracked file in this folder and contains column names only.

| Folder | Source | Files |
|---|---|---|
| `EIF 2026/` | Edinburgh International Festival: ticket sales, 2022-2026 | one CSV per year, plus a challenge slide deck (`.pptx`) |
| `Fringe 2026/` | Edinburgh Festival Fringe 2026: all tickets sold | one CSV |
| `Tattoo 2026/` | Royal Edinburgh Military Tattoo | `ticket_lines.csv`, `customers.csv`, two `.pptx` decks, plus a `README.md` and `DATA_DICTIONARY.md` supplied with the data |

The column listing below was produced by reading **only the first line** of each CSV
(`uv run python -m pipeline.headers`). Nothing else in the files has been inspected to write this.
The Tattoo `README.md` / `DATA_DICTIONARY.md` were not read either; check them for the meaning of the columns.

## Sensitive columns (by name)

| Dataset | Columns | Handling in the pipeline |
|---|---|---|
| Fringe | `Customer_Email` | **dropped** on load, never written anywhere |
| Fringe | `Customer_ID`, `Customer_Number`, `Transaction_ID`, `Transaction_User_Code` | replaced by a salted hash |
| EIF | `Owner Id` | replaced by a salted hash |
| Tattoo | `customer_ref`, `order_ref` | replaced by a salted hash |
| EIF, Tattoo | postcode columns (`Postcode Sector/District/Area`, `postcode_outward`, `postcode_area`) | kept for analysis; fine-grained postcodes are quasi-identifiers, so reports suppress any group smaller than 10 |
| EIF | `Dotdigital Sync Tags:*`, `Booking History:*` | customer-level marketing segments / booking history; used only in aggregate |

## Processing

```
uv sync
cp .env.example .env            # set PIPELINE_SALT to any long random string
uv run python -m pipeline.run   # build (typed, pseudonymised parquet) then analyze
```

* `dataset/_processed/*.parquet`: cleaned tables (no email, hashed keys); git-ignored.
* `reports/<table>/`: profile, covariance/correlation matrices, strongest pairs, segment
  tables and a `REPORT.md` per table; git-ignored. Only aggregates; groups under 10 are suppressed.
* `reports/schema_inference.csv`: the type the pipeline decided for each column and the
  evidence (sample counts). Review it first: types are inferred, not read from a data dictionary.

Notes from the headers alone:

* `EIF 2026/... 2026 full set - Copy.csv` has the same name and size as the main 2026 file; it is excluded.
* The 2022 EIF file carries extra `Booking History:2022 Booker*` columns and a different column order.
* The Fringe CSV starts with a UTF-8 byte-order mark; the loader strips it.
* `Instance: Band * Base Price` columns look like per-event price lists (one column per price band), so
  expect them to be mostly empty on any given row.

## Columns

<!-- headers:start -->

### EIF (Edinburgh International Festival), one file per year

69 columns in `TicketSalesAnalysisForYearOnYearComparison - 2023 full set.csv`, `TicketSalesAnalysisForYearOnYearComparison - 2024 full set.csv`, `TicketSalesAnalysisForYearOnYearComparison - 2025 full set.csv`, `TicketSalesAnalysisForYearOnYearComparison - 2026 full set.csv`:

1. `Owner Id`
2. `Date Created`
3. `Date Confirmed`
4. `Event Name`
5. `Event Date/Time`
6. `Venue Name`
7. `Instance: Festival`
8. `Instance: Category`
9. `Instance: Genre`
10. `Instance: Series`
11. `Instance: Analysis`
12. `Instance: Band A Base Price`
13. `Instance: Band B Base Price`
14. `Instance: Band C Base Price`
15. `Instance: Band D Base Price`
16. `Instance: Band E Base Price`
17. `Instance: Band F Base Price`
18. `Instance: Commission per ticket`
19. `Instance: Band A plus Base Price`
20. `Instance: Band R Base Price`
21. `Instance: Band G Base Price`
22. `Instance: Band H Base Price`
23. `Instance: Band I Base Price`
24. `Instance: Band J Base Price`
25. `Instance: Band K Base Price`
26. `Instance: Band L Base Price`
27. `Instance: Band M Base Price`
28. `Instance: Band N Base Price`
29. `Instance: Band O Base Price`
30. `Instance: Band P Base Price`
31. `Instance: Band Q Base Price`
32. `Instance: Band Stalls GA Base Price`
33. `Instance: Band Stalls Access Base Price`
34. `Instance: ticketsforgoodinstance`
35. `Instance: Staff Standby`
36. `Instance: Band S Base Price`
37. `Instance: Band T Base Price`
38. `Instance: Band U Base Price`
39. `Instance: Band V Base Price`
40. `Instance: Band W Base Price`
41. `Instance: Band X Base Price`
42. `Instance: Band Y Base Price`
43. `Instance: Band Z Base Price`
44. `Ticket Type`
45. `Band`
46. `Price`
47. `Offer Name`
48. `Sales Channel`
49. `User Confirmed`
50. `First Instance`
51. `Item Delivery Method`
52. `Ticket Subscription Pricing Set`
53. `Postcode Area`
54. `Postcode District`
55. `Postcode Sector`
56. `Dotdigital Sync Tags:METROCULTURAL`
57. `Dotdigital Sync Tags:EXPERIENCESEEKER`
58. `Dotdigital Sync Tags:CULTUREBUFF`
59. `Booking History:2023 Booker (new)`
60. `Booking History:2023 Booker (repeat)`
61. `Booking History:2023 Booker`
62. `Booking History:2024 Booker`
63. `Booking History:2024 Booker (new)`
64. `Booking History:2024 Booker (repeat)`
65. `Booking History:2025 Booker`
66. `Booking History:2025 Booker (new)`
67. `Booking History:2025 Booker (repeat)`
68. `Booking History:2026 Booker (new)`
69. `Booking History:2026 Booker`

`TicketSalesAnalysisForYearOnYearComparison - 2022 full set.csv` has 72 columns: adds ['Booking History:2022 Booker', 'Booking History:2022 Booker (repeat)', 'Booking History:2022 Booker (new)'], lacks nothing.

### Fringe 2026

`Fringe2026AllTicketsSold_Clean.csv`: 27 columns:

1. `item_id`
2. `Transaction_ID`
3. `Transaction_Date`
4. `print_option`
5. `Transaction_User_Code`
6. `Customer_ID`
7. `Customer_Number`
8. `Customer_Email`
9. `sales_channel`
10. `Venue_ID`
11. `Subvenue_ID`
12. `Event_ID`
13. `Event_Code`
14. `Event_Name`
15. `Performance_ID`
16. `Performance_Date`
17. `type`
18. `Ticket_Face_Value`
19. `status`
20. `Sale_Date`
21. `Sale_Time`
22. `Performance_Day`
23. `Tickets`
24. `Revenue`
25. `Is_2for1`
26. `Is_PA`
27. `Is_Free`

### Tattoo 2026 (Royal Edinburgh Military Tattoo)

`customers.csv`: 15 columns:

1. `customer_ref`
2. `postcode_outward`
3. `postcode_area`
4. `country`
5. `first_order_date`
6. `last_order_date`
7. `seasons_attended`
8. `season_count`
9. `attended_et25`
10. `attended_et26`
11. `attended_et27`
12. `orders`
13. `tickets`
14. `performances`
15. `bought_hospitality`

`ticket_lines.csv`: 19 columns:

1. `order_ref`
2. `customer_ref`
3. `order_date`
4. `performance_date`
5. `performance_time`
6. `show_name`
7. `season`
8. `event_name`
9. `event_locale`
10. `seat_category`
11. `ticket_type`
12. `package_name`
13. `sales_channel`
14. `is_comp`
15. `price_per_ticket_gross`
16. `tickets`
17. `postcode_outward`
18. `postcode_area`
19. `country`

<!-- headers:end -->
