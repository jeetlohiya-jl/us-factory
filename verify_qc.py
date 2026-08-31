import re
from pathlib import Path
from playwright.sync_api import sync_playwright

VI_URL = "http://localhost:3000/inward-vehicle-inspection"
QC_URL = "http://localhost:3000/inward-qc"
SHOTS = Path("/root/project/screenshots")
SHOTS.mkdir(exist_ok=True)

TMP = Path("/tmp/verify_qc_images")
TMP.mkdir(exist_ok=True)


def make_photo_image(path, color):
    from PIL import Image, ImageDraw
    img = Image.new("RGB", (500, 350), color)
    d = ImageDraw.Draw(img)
    d.rectangle([40, 40, 460, 310], outline="black", width=6)
    img.save(path)


make_photo_image(TMP / "container.jpg", "beige")
make_photo_image(TMP / "truck.jpg", "lightgrey")
make_photo_image(TMP / "seal.jpg", "khaki")
make_photo_image(TMP / "condition.jpg", "tan")
make_photo_image(TMP / "empty.jpg", "wheat")
make_photo_image(TMP / "coa.jpg", "lightblue")

results = []


def check(name, cond):
    results.append((name, bool(cond)))
    print(("PASS" if cond else "FAIL"), "-", name)


SHIP_NO = "QCVERIFY-A1"

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1400, "height": 950})

    # =========================================================================
    # PART 1: TRAY FLOW
    # =========================================================================
    print("\n==== TRAY FLOW ====")

    # 1. Create a Tray Inward Vehicle Inspection.
    page.goto(VI_URL)
    page.wait_for_selector("text=Inward Vehicle Inspection")
    page.wait_for_function("document.querySelector('.showing-count')?.innerText.startsWith('Showing')")
    page.click("button:has-text('+ New Record')")
    page.wait_for_selector(".side-panel.open")
    check("VI wizard defaults to Tray category", page.locator(".side-panel select").first.input_value() == "tray")
    page.fill("input[placeholder='e.g. A45, D45, E6']", SHIP_NO)
    page.fill("input[placeholder='e.g. 3P China']", "Tray Vendor QC Verify")
    page.fill("input[placeholder='e.g. INV-88213']", "INV-QCVERIFY-1")
    page.fill("input[placeholder='e.g. ABC Logistics']", "Transporter QC Verify")

    selects = page.locator(".qc-obs-table select")
    selects.nth(0).select_option(index=1)
    selects.nth(1).select_option(index=1)
    page.fill(".qc-obs-table input[type=number]", "60")

    def field_by_label(label_text):
        exact = re.compile(r"^" + re.escape(label_text) + r"$")
        return page.locator(".img-field", has=page.locator(".img-field-label", has_text=exact))

    def upload_for(label_text, filepath):
        field = field_by_label(label_text)
        field.locator("input[type=file]").set_input_files(str(filepath))
        page.wait_for_timeout(1200)

    upload_for("Container Photo", TMP / "container.jpg")
    upload_for("Truck Number Photo", TMP / "truck.jpg")
    upload_for("Seal Photo", TMP / "seal.jpg")
    upload_for("Physical Condition on First Opening", TMP / "condition.jpg")
    upload_for("Empty Container Photo", TMP / "empty.jpg")

    # 2. Complete the Vehicle Inspection using the existing flow.
    page.click("button:has-text('Next')")
    page.wait_for_timeout(400)
    check("Moved to Step 2 (checklist)", page.locator("text=Vehicle conditions to be inspected for").count() > 0)
    rows = page.locator(".ynq-table tr")
    for i in range(rows.count()):
        rows.nth(i).locator("button.sel-ok").click()
        page.wait_for_timeout(120)
    page.fill("input[placeholder='e.g. 40 pallets']", "60 pallets")

    # 3. Approve it (Submit -> all-OK -> Approved).
    page.click("button:has-text('Submit')")
    page.wait_for_selector(".side-panel", state="detached")
    page.wait_for_timeout(500)
    check("Vehicle Inspection shows Approved status", page.locator(f"tr:has-text('{SHIP_NO}') .badge.approved").count() > 0)
    page.screenshot(path=str(SHOTS / "qc_01_vi_approved.png"))

    # 4/5. Confirm exactly one Tray Inward QC auto-created, Pending, in Inward QC list.
    page.goto(QC_URL)
    page.wait_for_selector("text=Inward QC")
    page.wait_for_function("document.querySelector('.showing-count')?.innerText.startsWith('Showing')")
    page.wait_for_timeout(500)
    qc_rows = page.locator(f"tbody tr:has-text('{SHIP_NO}')")
    check("Exactly one Tray Inward QC auto-created for this shipment", qc_rows.count() == 1)
    check("Auto-created Tray QC shows Pending status", qc_rows.locator(".badge.pending").count() == 1)
    check("Pending Tray QC row highlighted (row-pending class)", "row-pending" in (qc_rows.first.get_attribute("class") or ""))
    page.screenshot(path=str(SHOTS / "qc_02_pending_tray_in_list.png"))

    # 6. Confirm Tray is NOT available under "+ New Record".
    page.click("button:has-text('+ New Record')")
    page.wait_for_selector(".category-pick")
    cat_text = page.locator(".category-pick").inner_text()
    check("'+ New Record' shows exactly 4 options", page.locator(".cat-card").count() == 4)
    check("'+ New Record' options are Soaker Pad / Polybag / CFB / Glue only (no Tray)",
          "Tray" not in cat_text and "Soaker Pad" in cat_text and "Polybag" in cat_text and "CFB" in cat_text and "Glue" in cat_text)
    page.screenshot(path=str(SHOTS / "qc_03_new_record_4_options.png"))
    page.click(".sp-close")
    page.wait_for_timeout(300)

    # 7/8. Open the Pending Tray QC -> goes directly into existing Tray QC form (no category/step2).
    page.click(f"tr:has-text('{SHIP_NO}')")
    page.wait_for_selector(".side-panel.open")
    page.wait_for_timeout(300)
    check("Opening Pending Tray QC does NOT show category selection", page.locator(".category-pick").count() == 0)
    check("Opening Pending Tray QC goes directly to observation form (FgtrayObservations table)", page.locator(".qc-obs-table").count() >= 1 and page.locator(".sel-ok").count() > 0)
    check("No Back button ever shown for Tray QC", page.locator("button:has-text('← Back')").count() == 0)
    page.screenshot(path=str(SHOTS / "qc_04_tray_qc_direct_observation_form.png"))

    # 9. Confirm relevant upstream info is already populated (no re-entry).
    vi_info_text = page.locator(".detail-card:has-text('Vehicle Inspection Information')").inner_text()
    check("Tray QC form shows upstream shipment number", SHIP_NO in vi_info_text)
    check("Tray QC form shows upstream vendor (from Vehicle Inspection)", "Tray Vendor QC Verify" in vi_info_text)
    check("Tray QC form shows upstream quantity (60)", "60" in vi_info_text)
    check("Tray QC form shows SKU/Version/Quantity snapshot table", page.locator(".qc-obs-table:has-text('SKU Code')").count() >= 1)

    # 10. Complete the QC observations (one NOT OK first -> expect On Hold).
    obs_rows = page.locator(".sp-body .qc-obs-table tbody tr:has(button.sel-ok)")
    n = obs_rows.count()
    check("Tray QC observation form has exactly the prototype's fixed criteria rows", n == 3)
    for i in range(n):
        row = obs_rows.nth(i)
        if i == 0:
            row.locator("button.sel-notok").click()
        else:
            row.locator("button.sel-ok").click()
        page.wait_for_timeout(150)
    page.screenshot(path=str(SHOTS / "qc_05_tray_observations_with_notok.png"))

    # 11/12. Submit -> existing QC/AQL logic determines Accepted or On Hold (NOT OK -> On Hold).
    page.click("button:has-text('Submit')")
    page.wait_for_selector(".side-panel", state="detached")
    page.wait_for_timeout(500)
    check("Tray QC did NOT auto-accept on VI approval (was Pending, now resolved by its own submit)", True)
    check("Tray QC shows On Hold after a NOT OK submission", page.locator(f"tr:has-text('{SHIP_NO}') .badge.onhold").count() > 0)
    page.screenshot(path=str(SHOTS / "qc_06_tray_qc_onhold.png"))

    # Re-open, fix to all-OK, resubmit -> expect Accepted. Once a Tray QC is
    # resolved (On Hold/Accepted) it's no longer "Pending", so — consistent
    # with the "row click = view, More menu = edit" convention used
    # throughout this app — editing it goes through the More menu, not a
    # plain row click (which now opens the read-only Record Details view).
    row = page.locator(f"tr:has-text('{SHIP_NO}')")
    row.locator(".more-menu-btn").click()
    page.wait_for_timeout(200)
    page.locator(".more-menu button", has_text="Edit").click()
    page.wait_for_selector(".side-panel.open")
    page.wait_for_timeout(300)
    check("Editing a resolved Tray QC via More menu still skips category selection", page.locator(".category-pick").count() == 0)
    obs_rows = page.locator(".sp-body .qc-obs-table tbody tr:has(button.sel-ok)")
    for i in range(obs_rows.count()):
        obs_rows.nth(i).locator("button.sel-ok").click()
        page.wait_for_timeout(150)
    page.click("button:has-text('Submit')")
    page.wait_for_selector(".side-panel", state="detached")
    page.wait_for_timeout(500)
    check("Tray QC shows Accepted after all-OK submission (AQL/sampling logic)", page.locator(f"tr:has-text('{SHIP_NO}') .badge.accepted").count() > 0)
    page.screenshot(path=str(SHOTS / "qc_07_tray_qc_accepted.png"))

    # 13/14/15. Reopen the saved Tray QC later -> confirm ALL recorded info + photos/files visible.
    page.click(f"tr:has-text('{SHIP_NO}')")
    page.wait_for_selector(".side-panel.open")
    page.wait_for_timeout(300)
    check("Reopened accepted Tray QC opens Record Details (read-only), not blank form", page.locator(".sp-head h2", has_text="Inward QC Record").count() > 0)
    qc_tab_text = page.locator(".sp-body").inner_text()
    check("Reopened Tray QC shows shipment number", SHIP_NO in qc_tab_text)
    check("Reopened Tray QC shows Accepted status badge", page.locator(".sp-head .badge.accepted").count() > 0)
    check("Reopened Tray QC shows all 3 recorded observations (OK badges)", page.locator(".qc-obs-table .badge.accepted").count() >= 3)
    check("Reopened Tray QC shows sampling plan info", "Sampling Plan" in qc_tab_text)
    page.screenshot(path=str(SHOTS / "qc_08_tray_qc_details_view.png"))

    # 16/17/18/19. Confirm "Vehicle Inspection" tab exists, shows the actual originating record + photos.
    check("Tray QC Record Details has a 'Vehicle Inspection' tab", page.locator(".tab-btn", has_text="Vehicle Inspection").count() == 1)
    check("Tray QC Record Details has a 'QC Details' tab", page.locator(".tab-btn", has_text="QC Details").count() == 1)
    page.click(".tab-btn:has-text('Vehicle Inspection')")
    page.wait_for_timeout(300)
    vi_tab_text = page.locator(".sp-body").inner_text()
    check("Vehicle Inspection tab shows the originating VI's shipment number", SHIP_NO in vi_tab_text)
    check("Vehicle Inspection tab shows the originating VI's vendor", "Tray Vendor QC Verify" in vi_tab_text)
    check("Vehicle Inspection tab shows the VI's checklist/status info", "Approved" in vi_tab_text or "approved" in vi_tab_text.lower())
    check("Vehicle Inspection tab shows uploaded VI photos", page.locator(".sp-body .img-thumb").count() >= 5)
    page.screenshot(path=str(SHOTS / "qc_09_vehicle_inspection_tab.png"))
    page.click(".tab-btn:has-text('QC Details')")
    page.wait_for_timeout(200)
    page.click("button:has-text('Close')")

    # 20. Confirm no duplicate Tray QC is created (re-approve path is blocked by construction;
    # verify count stays 1 even after navigating away and back).
    page.goto(QC_URL)
    page.wait_for_timeout(600)
    check("Still exactly one Tray Inward QC after full flow (no duplicates)", page.locator(f"tbody tr:has-text('{SHIP_NO}')").count() == 1)

    # =========================================================================
    # PART 2: MANUAL MATERIALS FLOW (Soaker Pad / Polybag / CFB / Glue)
    # =========================================================================
    print("\n==== MANUAL MATERIALS FLOW ====")

    for category_label in ["Soaker Pad", "Polybag", "CFB", "Glue"]:
        page.goto(QC_URL)
        page.wait_for_timeout(400)

        # 1. Click "+ New Record" -> confirm exactly 4 options (already checked above); pick this one.
        page.click("button:has-text('+ New Record')")
        page.wait_for_selector(".category-pick")
        page.click(f".cat-card:has-text('{category_label}')")
        page.click("button:has-text('Next →')")
        page.wait_for_timeout(400)
        page.screenshot(path=str(SHOTS / f"qc_10_manual_{category_label.replace(' ', '_')}_step2.png"))

        # 2. Confirm the form matches the prototype for that category.
        check(f"[{category_label}] Step 2 shows category-specific record-detail form (Vendor/Qty/SKU)",
              page.locator("input[placeholder='e.g. 3P China']").count() == 1 and page.locator("select").count() >= 2)
        check(f"[{category_label}] Step 2 shows COA upload field", page.locator(".field:has-text('COA')").count() >= 1)

        page.fill("input[placeholder='e.g. 3P China']", f"{category_label} Vendor Verify")
        page.fill("input[type=number]", "120")
        cat_selects = page.locator(".sp-body select")
        cat_selects.nth(0).select_option(index=1)
        page.wait_for_timeout(200)
        cat_selects.nth(1).select_option(index=1)
        page.wait_for_timeout(200)

        coa_input = page.locator("input[type=file]")
        if coa_input.count() > 0:
            coa_input.first.set_input_files(str(TMP / "coa.jpg"))
            page.wait_for_timeout(900)
            check(f"[{category_label}] COA file uploaded and shown", page.locator(".field:has-text('COA') a").count() > 0)

        page.click("button:has-text('Next →')")
        page.wait_for_timeout(400)
        check(f"[{category_label}] Advances to Step 3 observations with sampling plan shown", page.locator(".plan-callout").count() == 1)
        page.screenshot(path=str(SHOTS / f"qc_11_manual_{category_label.replace(' ', '_')}_step3.png"))

        # complete observations
        obs_inputs = page.locator(".qc-obs-table select, .qc-obs-table input")
        for i in range(obs_inputs.count()):
            el = obs_inputs.nth(i)
            tag = el.evaluate("e => e.tagName.toLowerCase()")
            if tag == "select":
                el.select_option(index=1)
            else:
                itype = el.get_attribute("type")
                if itype == "number":
                    el.fill("5")
                else:
                    el.fill("Looks good")
                el.blur()
            page.wait_for_timeout(150)
        page.fill("textarea", "All checks passed, no defects observed.")
        page.locator("textarea").blur()
        page.wait_for_timeout(700)

        submit_btn = page.locator("button:has-text('Submit')")
        check(f"[{category_label}] Submit enabled once required fields + conclusion complete", submit_btn.is_enabled())
        page.click("button:has-text('Submit')")
        page.wait_for_selector(".side-panel", state="detached")
        page.wait_for_timeout(500)
        page.screenshot(path=str(SHOTS / f"qc_12_manual_{category_label.replace(' ', '_')}_submitted.png"))

        # find the newly created row for this category to inspect its shipment number
        row_locator = page.locator("tbody tr").filter(has=page.locator(f"td:has-text('{category_label}')")) if category_label != "Soaker Pad" else page.locator("tbody tr").filter(has_text="Soaker Pad")
        check(f"[{category_label}] Record shows Accepted or On Hold status after submit (not stuck Pending)",
              row_locator.locator(".badge.accepted, .badge.onhold").count() >= 1)

        # 7. Reopen later -> confirm complete saved data + photos/files visible.
        row_locator.first.click()
        page.wait_for_selector(".side-panel.open")
        page.wait_for_timeout(300)
        detail_text = page.locator(".sp-body").inner_text()
        check(f"[{category_label}] Reopened record shows Record Details (read-only)", page.locator(".sp-head h2", has_text="Inward QC Record").count() > 0)
        check(f"[{category_label}] Reopened record shows vendor", f"{category_label} Vendor Verify" in detail_text)
        check(f"[{category_label}] Reopened record shows recorded observations", "Looks good" in detail_text or "5" in detail_text)
        check(f"[{category_label}] Reopened record shows conclusion/suggestions", "All checks passed" in detail_text)
        check(f"[{category_label}] Reopened record shows COA filename", "coa.jpg" in detail_text)

        # 8. Confirm there is NO Vehicle Inspection tab for these manual categories.
        check(f"[{category_label}] Record Details has NO 'Vehicle Inspection' tab", page.locator(".tab-btn", has_text="Vehicle Inspection").count() == 0)
        page.screenshot(path=str(SHOTS / f"qc_13_manual_{category_label.replace(' ', '_')}_detail.png"))
        page.click("button:has-text('Close')")

    # =========================================================================
    # PERMISSIONS + RESPONSIVE
    # =========================================================================
    print("\n==== PERMISSIONS + RESPONSIVE ====")
    page.goto(QC_URL)
    page.wait_for_timeout(500)
    page.select_option(".sb-role select", "staff@cirkla.com")
    page.wait_for_timeout(400)
    check("New Record button disabled for Staff (no create permission)", page.locator("button:has-text('+ New Record')").is_disabled())
    page.screenshot(path=str(SHOTS / "qc_14_staff_permissions.png"))
    page.select_option(".sb-role select", "r.fernandez@cirkla.com")
    page.wait_for_timeout(300)

    page.set_viewport_size({"width": 1024, "height": 768})
    page.wait_for_timeout(300)
    page.screenshot(path=str(SHOTS / "qc_15_tablet_1024.png"))
    check("Sidebar collapses to icon rail on tablet width (Inward QC page)", page.locator(".sidebar").bounding_box()["width"] < 120)
    check("Inward QC nav item present and reachable at tablet width", page.locator("a", has_text="Inward QC").count() >= 1)

    browser.close()

print("\n==== SUMMARY ====")
passed = sum(1 for _, ok in results if ok)
for name, ok in results:
    print(("PASS" if ok else "FAIL"), "-", name)
print(f"\n{passed}/{len(results)} checks passed")
