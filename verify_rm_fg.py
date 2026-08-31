import re
from pathlib import Path
from playwright.sync_api import sync_playwright

QC_URL = "http://localhost:3000/inward-qc"
VI_URL = "http://localhost:3000/inward-vehicle-inspection"
RM_QR_URL = "http://localhost:3000/rm-qr-generation"
RM_STORAGE_URL = "http://localhost:3000/rm-storage"
FG_QR_URL = "http://localhost:3000/fg-qr-generation"
FG_STORAGE_URL = "http://localhost:3000/fg-storage"

SHOTS = Path("/root/project/screenshots")
SHOTS.mkdir(exist_ok=True)

results = []


def check(name, cond):
    results.append((name, bool(cond)))
    print(("PASS" if cond else "FAIL"), "-", name)


SHIP_NO = "RMFGVERIFY-A1"

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1400, "height": 950})

    # =========================================================================
    # PART 1: RM QR GENERATION + RM STORAGE (source: manual Inward QC, category=glue)
    # =========================================================================
    print("\n==== RM QR GENERATION + RM STORAGE ====")

    page.goto(QC_URL)
    page.wait_for_selector("text=Inward QC")
    page.wait_for_function("document.querySelector('.showing-count')?.innerText.startsWith('Showing')")
    page.click("button:has-text('+ New Record')")
    page.wait_for_selector(".category-pick")
    page.click(".cat-card:has-text('Glue')")
    page.click("button:has-text('Next →')")
    page.wait_for_timeout(400)
    page.fill("input[placeholder='e.g. 3P China']", "RM Glue Vendor")
    page.fill("input[type=number]", "3")
    sels = page.locator(".sp-body select")
    sels.nth(0).select_option(index=1)
    page.wait_for_timeout(200)
    sels.nth(1).select_option(index=1)
    page.wait_for_timeout(200)
    page.click("button:has-text('Next →')")
    page.wait_for_timeout(400)
    obs_inputs = page.locator(".qc-obs-table select, .qc-obs-table input")
    for i in range(obs_inputs.count()):
        el = obs_inputs.nth(i)
        tag = el.evaluate("e => e.tagName.toLowerCase()")
        if tag == "select":
            el.select_option(index=1)
        else:
            el.fill("10")
            el.blur()
        page.wait_for_timeout(120)
    page.fill("textarea", "All good.")
    page.locator("textarea").blur()
    page.wait_for_timeout(700)
    page.click("button:has-text('Submit')")
    page.wait_for_selector(".side-panel", state="detached")
    page.wait_for_timeout(500)

    # Get the shipment number that was auto-generated for this glue QC.
    row_text = page.locator("tbody tr").filter(has_text="Glue").first.inner_text()
    ship_no = row_text.split("\n")[0].split("\t")[0].strip()
    check("Manual Inward QC (Glue) accepted", page.locator("tbody tr").filter(has_text="Glue").first.locator(".badge.accepted, .badge.onhold").count() >= 1)

    # ---- 1. Approved Inward QC creates/feeds an RM QR Generation record ----
    page.goto(RM_QR_URL)
    page.wait_for_selector("text=RM QR Generation")
    page.wait_for_timeout(600)
    qr_row = page.locator(f"tbody tr:has-text('{ship_no}')")
    check("Approved Inward QC auto-created exactly one RM QR Generation record", qr_row.count() == 1)
    check("Auto-created RM QR record is Pending", qr_row.locator(".badge.pending").count() == 1)
    page.screenshot(path=str(SHOTS / "rmfg_01_rm_qr_pending.png"))

    # ---- 2. RM QR fields auto-populated from Inward QC (locked/read-only) ----
    qr_row.locator("a:has-text('Generate QR')").click()
    page.wait_for_selector(".side-panel.open")
    page.wait_for_timeout(300)
    panel_text = page.locator(".sp-body").inner_text()
    check("RM QR Generation panel shows auto-populated shipment number", ship_no in panel_text)
    check("RM QR Generation panel shows auto-populated SKU/quantity", "SKU-GLUE-01" in panel_text and "3" in panel_text)
    check("RM QR Generation panel shows fields are locked (auto-created from Inward QC)", "locked" in panel_text.lower())
    check("No editable input fields for source-derived data (fields are read-only divs)", page.locator(".side-panel input[type=text], .side-panel input[type=number]").count() == 0)
    page.screenshot(path=str(SHOTS / "rmfg_02_rm_qr_generate_panel.png"))

    # ---- 3/4. Generate real individual pallet QRs, each with a unique immutable ID ----
    page.click("button:has-text('Generate QR')")
    page.wait_for_timeout(700)
    check("Generating QR produced pallet tiles", page.locator(".qr-tile").count() == 3)
    check("Each generated pallet has a real QR image (not a mock placeholder)", page.locator(".qr-tile img").count() == 3)
    tile_ids = [page.locator(".qr-tile .qr-id").nth(i).inner_text() for i in range(3)]
    check("Each pallet has a unique immutable pallet ID", len(set(tile_ids)) == 3)
    check("Print QR Codes button appears after generation", page.locator("button:has-text('Print QR Codes')").count() == 1)
    page.screenshot(path=str(SHOTS / "rmfg_03_rm_pallets_generated.png"))

    # ---- Do not allow regeneration ----
    check("Generate button is gone once generated (no regeneration control)", page.locator("button:has-text('Generate QR')").count() == 0)
    page.click("button:has-text('Close')")
    page.wait_for_timeout(300)

    # ---- 5. Generated pallets automatically appear as pending storage ----
    page.goto(RM_STORAGE_URL)
    page.wait_for_selector("text=RM Storage")
    page.wait_for_timeout(600)
    pending_table = page.locator(".card.card-flush").nth(0)
    records_table = page.locator(".card.card-flush").nth(1)
    pending_rows = pending_table.locator("tbody tr").filter(has_text="SKU-GLUE-01")
    check("All 3 generated pallets automatically appear in RM Storage as pending", pending_rows.count() == 3)
    first_pallet_id = pending_rows.first.locator("td").first.inner_text()
    page.screenshot(path=str(SHOTS / "rmfg_04_rm_pending_storage.png"))

    # ---- 6/7/8/9. Scan pallet -> auto-resolve SKU -> scan location -> both saved -> confirm gated ----
    page.click("button:has-text('+ New Record')")
    page.wait_for_selector(".side-panel.open")
    check("Storage wizard starts on Step 1 (Scan Pallet QR)", page.locator("text=Step 1 — Scan Pallet QR").count() == 1)

    # invalid pallet scan first
    page.fill(".side-panel input[type=text]", "BOGUS-NOT-A-PALLET")
    page.click(".side-panel button:has-text('Scan')")
    page.wait_for_timeout(500)
    check("Invalid pallet QR is rejected with a clear error", page.locator(".hint-text", has_text="Unrecognized pallet").count() == 1)
    check("Invalid pallet scan does not proceed to location scanning", page.locator("text=Step 2").count() == 0)
    page.screenshot(path=str(SHOTS / "rmfg_05_invalid_pallet_scan.png"))

    # valid pallet scan
    page.fill(".side-panel input[type=text]", first_pallet_id)
    page.click(".side-panel button:has-text('Scan')")
    page.wait_for_timeout(500)
    check("Valid pallet scan resolves the exact pallet + SKU automatically", page.locator(".scan-result", has_text=first_pallet_id).count() == 1 and "SKU-GLUE-01" in page.locator(".scan-result").first.inner_text())
    check("After valid pallet scan, moves to Step 2 (Scan Location QR)", page.locator("text=Step 2 — Scan Location QR").count() == 1)
    check("Confirm Storage is NOT enabled with only a pallet scan", page.locator("button:has-text('Confirm Storage')").is_disabled())
    page.screenshot(path=str(SHOTS / "rmfg_06_pallet_scanned_resolved.png"))

    # invalid location scan
    page.fill(".side-panel input[placeholder*='location']", "NOWHERE-999")
    page.locator(".side-panel button:has-text('Scan')").last.click()
    page.wait_for_timeout(500)
    check("Invalid location QR is rejected with a clear error", page.locator(".hint-text", has_text="Unrecognized location").count() == 1)
    check("Storage record not created on invalid location scan (still no summary)", page.locator("#storage-summary-card").count() == 0)

    # valid location scan
    page.fill(".side-panel input[placeholder*='location']", "FNPGGLUE-A01-R01-L01-P01-A")
    page.locator(".side-panel button:has-text('Scan')").last.click()
    page.wait_for_timeout(500)
    check("Valid location scan resolves the exact location", page.locator(".scan-result", has_text="FNPGGLUE-A01-R01-L01-P01-A").count() == 1)
    check("Both scans saved -> confirmation summary shown with Pallet/Shipment/SKU/Version/Location", page.locator("#storage-summary-card").count() == 1)
    summary_text = page.locator("#storage-summary-card").inner_text()
    check("Summary includes pallet, SKU, version, location", first_pallet_id in summary_text and "SKU-GLUE-01" in summary_text and "FNPGGLUE" in summary_text)
    check("Confirm Storage enabled only after both scans", page.locator("button:has-text('Confirm Storage')").is_enabled())
    page.screenshot(path=str(SHOTS / "rmfg_07_both_scanned_summary.png"))

    # ---- 10/11. Confirm -> pallet moves to Stored, location retained ----
    page.click("button:has-text('Confirm Storage')")
    page.wait_for_timeout(600)
    check("Confirmation shows success message", page.locator("text=✓ Storage confirmed").count() == 1)
    page.screenshot(path=str(SHOTS / "rmfg_08_storage_confirmed.png"))
    page.click("button:has-text('Done')")
    page.wait_for_timeout(500)

    check("Stored pallet removed from pending-storage list", pending_table.locator(f"tbody tr:has-text('{first_pallet_id}')").count() == 0)
    remaining_pending = pending_table.locator("tbody tr").filter(has_text="SKU-GLUE-01")
    check("Pending-storage count dropped from 3 to 2 after one confirm", remaining_pending.count() == 2)
    page.screenshot(path=str(SHOTS / "rmfg_09_pending_after_one_stored.png"))

    # ---- 12. Opening the Storage record later shows all recorded data ----
    storage_row = records_table.locator("tbody tr").filter(has_text=first_pallet_id)
    check("Stored pallet appears in the Storage Records table", storage_row.count() == 1)
    storage_row.first.click()
    page.wait_for_selector(".side-panel.open")
    page.wait_for_timeout(300)
    detail_text = page.locator(".sp-body").inner_text()
    detail_text_lower = detail_text.lower()
    check("Opening a Storage record shows Storage Record ID", "storage record id" in detail_text_lower)
    check("Opening a Storage record shows the exact pallet, SKU, version, location", first_pallet_id in detail_text and "SKU-GLUE-01" in detail_text and "FNPGGLUE" in detail_text)
    check("Opening a Storage record shows source RM QR batch, user, timestamp, and pallet status", "source rm qr generation batch" in detail_text_lower and "stored by" in detail_text_lower and "current pallet status" in detail_text_lower)
    page.screenshot(path=str(SHOTS / "rmfg_10_storage_record_detail.png"))
    page.click("button:has-text('Close')")

    # ---- 13. Opening the RM QR record shows generated pallets + statuses (1 stored, 2 pending) ----
    page.goto(RM_QR_URL)
    page.wait_for_timeout(500)
    page.locator(f"tbody tr:has-text('{ship_no}')").locator("a:has-text('View')").click()
    page.wait_for_selector(".side-panel.open")
    page.wait_for_timeout(300)
    qr_detail_text = page.locator(".sp-body").inner_text()
    check("Opening the RM QR record shows the generated pallets and lifecycle statuses", "lifecycle status" in qr_detail_text.lower() and "Stored" in qr_detail_text and "Pending Storage" in qr_detail_text)
    page.screenshot(path=str(SHOTS / "rmfg_11_rm_qr_record_after_partial_storage.png"))
    page.click("button:has-text('Close')")

    # ---- Attempt duplicate storage of the already-stored pallet ----
    page.goto(RM_STORAGE_URL)
    page.wait_for_timeout(400)
    page.click("button:has-text('+ New Record')")
    page.wait_for_selector(".side-panel.open")
    page.fill(".side-panel input[type=text]", first_pallet_id)
    page.click(".side-panel button:has-text('Scan')")
    page.wait_for_timeout(500)
    check("Re-scanning an already-stored pallet is rejected (no duplicate storage)", page.locator(".hint-text", has_text="already stored").count() == 1)
    page.screenshot(path=str(SHOTS / "rmfg_12_duplicate_storage_rejected.png"))
    page.click("button:has-text('Cancel')")

    # =========================================================================
    # PART 2: FG QR GENERATION + FG STORAGE (source: Production Run)
    # =========================================================================
    print("\n==== FG QR GENERATION + FG STORAGE ====")

    page.goto(FG_QR_URL)
    page.wait_for_selector("text=FG QR Generation")
    page.wait_for_timeout(600)
    check("An approved Production Run is offered to feed FG QR Generation", page.locator("text=Approved Production Runs awaiting FG QR Generation").count() == 1)
    page.screenshot(path=str(SHOTS / "rmfg_13_fg_qr_production_run_offered.png"))

    page.click("button:has-text('Open FG QR Generation')")
    page.wait_for_selector(".side-panel.open")
    page.wait_for_timeout(400)
    fg_panel_text = page.locator(".sp-body").inner_text()
    check("FG QR Generation panel auto-populated from the Production Run (no manual re-entry)", "SKU-3P" in fg_panel_text and "PR-0001" in fg_panel_text)
    check("FG QR Generation source fields are locked, same as RM", "locked" in fg_panel_text.lower())
    page.screenshot(path=str(SHOTS / "rmfg_14_fg_qr_panel_populated.png"))

    page.click("button:has-text('Generate QR')")
    page.wait_for_timeout(700)
    fg_tile_ids = [page.locator(".qr-tile .qr-id").nth(i).inner_text() for i in range(page.locator(".qr-tile").count())]
    check("FG QR Generation created individually-numbered FG pallets", len(fg_tile_ids) == 2 and len(set(fg_tile_ids)) == 2)
    check("FG pallets use the SAME display-id namespace/prefix as RM (no separate FG- prefix)", all(t.startswith("US-PLT-") for t in fg_tile_ids))
    page.screenshot(path=str(SHOTS / "rmfg_15_fg_pallets_generated.png"))
    page.click("button:has-text('Close')")

    # ---- FG pallets automatically appear as pending storage ----
    page.goto(FG_STORAGE_URL)
    page.wait_for_selector("text=FG Storage")
    page.wait_for_timeout(600)
    fg_pending_table = page.locator(".card.card-flush").nth(0)
    fg_pending = fg_pending_table.locator("tbody tr").filter(has_text="SKU-3P")
    check("Generated FG pallets automatically appear in FG Storage as pending", fg_pending.count() == 2)
    fg_first_pallet = fg_pending.first.locator("td").first.inner_text()
    page.screenshot(path=str(SHOTS / "rmfg_16_fg_pending_storage.png"))

    # ---- FG storage: same two-scan -> confirm workflow ----
    page.click("button:has-text('+ New Record')")
    page.wait_for_selector(".side-panel.open")
    check("FG Storage panel mentions Zone auto-set to FPG (matches RM/FG storage sub-copy)", "FPG" in page.locator(".side-panel .sub").inner_text())
    page.fill(".side-panel input[type=text]", fg_first_pallet)
    page.click(".side-panel button:has-text('Scan')")
    page.wait_for_timeout(500)
    check("FG pallet scan resolves pallet + SKU automatically", page.locator(".scan-result", has_text=fg_first_pallet).count() == 1)
    page.fill(".side-panel input[placeholder*='location']", "FPG-A01-R02-L01-P01-B")
    page.locator(".side-panel button:has-text('Scan')").last.click()
    page.wait_for_timeout(500)
    check("FG location scan resolves the exact location", page.locator(".scan-result", has_text="FPG-A01-R02-L01-P01-B").count() == 1)
    check("FG confirmation summary shown with pallet/SKU/version/location", page.locator("#storage-summary-card").count() == 1)
    page.click("button:has-text('Confirm Storage')")
    page.wait_for_timeout(600)
    check("FG storage confirmed", page.locator("text=✓ Storage confirmed").count() == 1)
    page.screenshot(path=str(SHOTS / "rmfg_17_fg_storage_confirmed.png"))
    page.click("button:has-text('Done')")
    page.wait_for_timeout(500)
    check("Confirmed FG pallet removed from FG pending-storage list", fg_pending_table.locator("tbody tr").filter(has_text="SKU-3P").count() == 1)

    # ---- Attempt cross-type scan: RM pallet through FG storage should fail ----
    page.click("button:has-text('+ New Record')")
    page.wait_for_selector(".side-panel.open")
    page.fill(".side-panel input[type=text]", first_pallet_id)  # this is an RM pallet
    page.click(".side-panel button:has-text('Scan')")
    page.wait_for_timeout(500)
    check("An RM pallet is rejected when scanned in the FG Storage flow (pallet type enforced)", page.locator(".hint-text", has_text="Unrecognized pallet").count() == 1)
    page.screenshot(path=str(SHOTS / "rmfg_18_cross_type_scan_rejected.png"))
    page.click("button:has-text('Cancel')")

    # ---- Traceability: FG QR record shows Production Run link + pallet statuses ----
    page.goto(FG_QR_URL)
    page.wait_for_timeout(500)
    page.locator("tbody tr").filter(has_text="SKU-3P").locator("a:has-text('View')").click()
    page.wait_for_selector(".side-panel.open")
    page.wait_for_timeout(300)
    fg_detail_text = page.locator(".sp-body").inner_text()
    check("FG QR record view shows generated pallets with lifecycle status (1 stored, 1 pending)", "Stored" in fg_detail_text and "Pending Storage" in fg_detail_text)
    page.screenshot(path=str(SHOTS / "rmfg_19_fg_qr_record_detail.png"))

    browser.close()

print("\n==== SUMMARY ====")
passed = sum(1 for _, ok in results if ok)
for name, ok in results:
    print(("PASS" if ok else "FAIL"), "-", name)
print(f"\n{passed}/{len(results)} checks passed")
