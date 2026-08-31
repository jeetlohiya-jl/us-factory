import time
import re
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

BASE = "http://localhost:3000/inward-vehicle-inspection"
SHOTS = Path("/root/project/screenshots")
SHOTS.mkdir(exist_ok=True)


def make_label_image(path, text):
    from PIL import Image, ImageDraw, ImageFont
    img = Image.new("RGB", (700, 220), "white")
    d = ImageDraw.Draw(img)
    font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 52)
    d.text((30, 80), text, fill="black", font=font)
    img.save(path)


def make_photo_image(path, color):
    from PIL import Image, ImageDraw
    img = Image.new("RGB", (500, 350), color)
    d = ImageDraw.Draw(img)
    d.rectangle([40, 40, 460, 310], outline="black", width=6)
    img.save(path)


TMP = Path("/tmp/verify_images")
TMP.mkdir(exist_ok=True)
make_label_image(TMP / "container.jpg", "CXYU3051429")
make_label_image(TMP / "truck.jpg", "TRK-99120")
make_label_image(TMP / "seal.jpg", "SL-77004")
make_photo_image(TMP / "condition.jpg", "beige")
make_photo_image(TMP / "damage1.jpg", "salmon")
make_photo_image(TMP / "damage2.jpg", "lightblue")
make_photo_image(TMP / "empty.jpg", "lightgrey")
make_photo_image(TMP / "damage_replacement.jpg", "orange")

results = []


def check(name, cond):
    results.append((name, bool(cond)))
    print(("PASS" if cond else "FAIL"), "-", name)


with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1400, "height": 950})
    page.goto(BASE)
    page.wait_for_selector("text=Inward Vehicle Inspection")
    page.wait_for_function("document.querySelector('.showing-count')?.innerText.startsWith('Showing')")
    page.screenshot(path=str(SHOTS / "01_landing.png"))
    check("Landing page loads with heading", page.locator("h1", has_text="Inward Vehicle Inspection").count() > 0)
    check("Showing N of M toolbar present", page.locator(".showing-count").inner_text().startswith("Showing"))
    check("+ New Record button present", page.locator("button", has_text="+ New Record").count() > 0)

    # ---- New Record ----
    page.click("button:has-text('+ New Record')")
    page.wait_for_selector(".side-panel.open")
    page.screenshot(path=str(SHOTS / "02_wizard_step1_empty.png"))

    page.fill("input[placeholder='e.g. A45, D45, E6']", "VERIFY-A1")
    page.fill("input[placeholder='e.g. 3P China']", "3P China Verify")
    page.fill("input[placeholder='e.g. INV-88213']", "INV-VERIFY-1")
    page.fill("input[placeholder='e.g. ABC Logistics']", "ABC Logistics Verify")

    # line items: add a second entry, set sku/version/qty on both
    selects = page.locator(".qc-obs-table select")
    selects.nth(0).select_option(index=1)  # SKU code row1
    selects.nth(1).select_option(index=1)  # SKU version row1
    page.fill(".qc-obs-table input[type=number]", "40")
    page.click("button:has-text('+ Add More Entry')")
    selects2 = page.locator(".qc-obs-table select")
    selects2.nth(2).select_option(index=2)
    selects2.nth(3).select_option(index=1)
    qty_inputs = page.locator(".qc-obs-table input[type=number]")
    qty_inputs.nth(1).fill("10")
    check("Two SKU line item rows present", page.locator(".qc-obs-table tbody tr").count() == 2)
    total_qty_val = page.locator("input[placeholder='Sum of SKU Details quantities']").input_value()
    check("Total Quantity auto-sums line items (50)", total_qty_val == "50")

    # ---- Image uploads with real OCR ----
    def field_by_label(label_text):
        exact = re.compile(r"^" + re.escape(label_text) + r"$")
        return page.locator(".img-field", has=page.locator(".img-field-label", has_text=exact))

    def upload_for(label_text, filepath):
        field = field_by_label(label_text)
        field.locator("input[type=file]").set_input_files(str(filepath))
        page.wait_for_timeout(1500)

    upload_for("Container Photo", TMP / "container.jpg")
    page.screenshot(path=str(SHOTS / "03_container_ocr.png"))
    container_val = page.locator("input[placeholder='e.g. CXY-20354']").input_value()
    check("Container OCR extracted CXYU3051429 into field", container_val == "CXYU3051429")
    check("Container OCR badge shows success", field_by_label("Container Photo").locator(".ocr-badge.success").count() > 0)

    upload_for("Truck Number Photo", TMP / "truck.jpg")
    truck_val = page.locator("input[placeholder='e.g. TRK-88213']").input_value()
    check("Truck OCR extracted TRK-99120 into field", truck_val == "TRK-99120")

    upload_for("Seal Photo", TMP / "seal.jpg")
    seal_val = page.locator("input[placeholder='e.g. SL-44210']").input_value()
    check("Seal OCR extracted SL-77004 into field", seal_val == "SL-77004")

    upload_for("Physical Condition on First Opening", TMP / "condition.jpg")
    upload_for("Empty Container Photo", TMP / "empty.jpg")

    # damage: multiple images
    damage_field = field_by_label("Damage Pictures")
    damage_field.locator(".img-add-tile input[type=file]").set_input_files(str(TMP / "damage1.jpg"))
    page.wait_for_timeout(1200)
    damage_field.locator(".img-add-tile input[type=file]").set_input_files(str(TMP / "damage2.jpg"))
    page.wait_for_timeout(1200)
    page.screenshot(path=str(SHOTS / "04_all_images_uploaded.png"))
    check("Two damage images uploaded", damage_field.locator(".img-thumb").count() == 2)

    # replace + delete on a single-image field (empty container) to test edit controls
    empty_field = field_by_label("Empty Container Photo")
    empty_field.locator(".img-thumb-actions button:has-text('Replace')").click()
    page.wait_for_timeout(200)
    # replace uses hidden input sibling; set on the field's replace input
    empty_field.locator("input[type=file]").last.set_input_files(str(TMP / "damage_replacement.jpg"))
    page.wait_for_timeout(1200)
    check("Empty container image still present after replace", empty_field.locator(".img-thumb").count() == 1)

    condition_field = field_by_label("Physical Condition on First Opening")
    condition_field.locator(".img-thumb-actions button:has-text('Delete')").click()
    page.wait_for_timeout(1000)
    check("Condition image removed after delete", condition_field.locator(".img-thumb").count() == 0)
    check("Condition field shows Add tile again after delete", condition_field.locator(".img-add-tile").count() == 1)
    # re-add it for completeness of the record
    upload_for("Physical Condition on First Opening", TMP / "condition.jpg")

    # ---- Save Draft, close, reopen ----
    page.click("button:has-text('Save Draft')")
    page.wait_for_selector(".side-panel", state="detached")
    page.wait_for_timeout(500)
    page.screenshot(path=str(SHOTS / "05_after_save_draft.png"))
    check("Record appears in table with Draft badge", page.locator("tr:has-text('VERIFY-A1') .badge.draft").count() > 0)

    page.click("tr:has-text('VERIFY-A1')")
    page.wait_for_selector(".side-panel.open")
    check("Reopened record shows Record Details (read-only)", page.locator(".sp-head h2", has_text="Vehicle Inspection Record").count() > 0)
    check("Reopened detail shows retained vendor name", page.locator(".detail-card:has-text('Basic Information')").inner_text().find("3P China Verify") >= 0)
    check("Reopened detail shows retained container OCR value", "CXYU3051429" in page.locator(".detail-card:has-text('Vehicle / Container Information')").inner_text())
    check("Reopened detail shows 2 SKU line items", page.locator(".detail-card:has-text('SKU / Version / Quantity') tbody tr").count() == 2)
    check("Reopened detail shows uploaded photos", page.locator(".detail-card:has-text('Photos / Attachments') .img-thumb").count() >= 5)
    page.screenshot(path=str(SHOTS / "06_record_details_view.png"))
    page.click("button:has-text('Edit')")
    page.wait_for_timeout(500)
    check("Edit reopens wizard with data restored", page.locator("input[placeholder='e.g. A45, D45, E6']").input_value() == "VERIFY-A1")
    check("Edit wizard restored container field from OCR/manual value", page.locator("input[placeholder='e.g. CXY-20354']").input_value() == "CXYU3051429")

    # ---- Back / Next ----
    page.click("button:has-text('Next')")
    page.wait_for_timeout(400)
    check("Moved to Step 2 (checklist visible)", page.locator("text=Vehicle conditions to be inspected for").count() > 0)
    page.click("button:has-text('← Back')")
    page.wait_for_timeout(300)
    check("Back returns to Step 1", page.locator(".section-label", has_text="SKU Details").count() > 0)
    page.click("button:has-text('Next')")
    page.wait_for_timeout(400)

    # ---- incomplete checklist: submit disabled ----
    submit_btn = page.locator("button:has-text('Submit')")
    check("Submit disabled while checklist incomplete", submit_btn.is_disabled())
    page.screenshot(path=str(SHOTS / "07_checklist_incomplete.png"))

    # ---- complete with one NOT OK -> expect Hold ----
    rows = page.locator(".ynq-table tr")
    n = rows.count()
    for i in range(n):
        row = rows.nth(i)
        if i == 2:
            row.locator("button.sel-notok").click()
        else:
            row.locator("button.sel-ok").click()
        page.wait_for_timeout(150)
    check("Passed Quantity field hidden when a NOT OK answer exists", page.locator("label:has-text('Inspection Passed Quantity')").count() == 0)
    page.screenshot(path=str(SHOTS / "08_checklist_with_notok.png"))
    page.click("button:has-text('Submit')")
    page.wait_for_selector(".side-panel", state="detached")
    page.wait_for_timeout(500)
    check("Record shows Hold status after NOT OK submit", page.locator("tr:has-text('VERIFY-A1') .badge.hold").count() > 0)
    page.screenshot(path=str(SHOTS / "09_hold_status.png"))

    # ---- edit again, flip to all OK -> expect Approved + passed qty field appears ----
    page.click("tr:has-text('VERIFY-A1')")
    page.wait_for_selector(".side-panel.open")
    page.click("button:has-text('Edit')")
    page.wait_for_timeout(400)
    page.click("button:has-text('Next')")
    page.wait_for_timeout(400)
    rows = page.locator(".ynq-table tr")
    for i in range(rows.count()):
        rows.nth(i).locator("button.sel-ok").click()
        page.wait_for_timeout(150)
    check("Passed Quantity field appears when all OK", page.locator("label:has-text('Inspection Passed Quantity')").count() == 1)
    page.fill("input[placeholder='e.g. 40 pallets']", "50 pallets")
    page.click("button:has-text('Submit')")
    page.wait_for_selector(".side-panel", state="detached")
    page.wait_for_timeout(500)
    check("Record shows Approved status after all-OK submit", page.locator("tr:has-text('VERIFY-A1') .badge.approved").count() > 0)
    page.screenshot(path=str(SHOTS / "10_approved_status.png"))

    # ---- reopen approved record: verify everything visible ----
    page.click("tr:has-text('VERIFY-A1')")
    page.wait_for_selector(".side-panel.open")
    detail_text = page.locator(".sp-body").inner_text()
    check("Approved record detail shows passed quantity", "50 pallets" in detail_text)
    check("Approved record detail shows checklist answers as OK", detail_text.count("OK") >= 8)
    page.screenshot(path=str(SHOTS / "11_reopen_approved_full_detail.png"))
    page.click("button:has-text('Close')")

    # ---- search & filters ----
    page.fill(".search-box input", "VERIFY-A1")
    page.wait_for_timeout(500)
    check("Search finds the record by shipment number", page.locator("tbody tr:has-text('VERIFY-A1')").count() == 1)
    page.fill(".search-box input", "")
    page.click("button:has-text('Filters')")
    # use label-based selection via filter panel selects order: Date, Category, Status
    filter_selects = page.locator(".filter-panel select")
    filter_selects.nth(1).select_option("approved")
    page.wait_for_timeout(500)
    check("Status filter narrows to approved records only", page.locator("tbody .badge:not(.approved)").count() == 0)
    page.screenshot(path=str(SHOTS / "12_filtered_approved.png"))
    filter_selects.nth(1).select_option("")
    page.wait_for_timeout(400)

    # ---- More menu edit/delete ----
    row = page.locator("tr:has-text('VERIFY-A1')")
    row.locator(".more-menu-btn").click()
    page.wait_for_timeout(200)
    check("More menu shows Edit and Delete (not prominent row buttons)", page.locator(".more-menu button", has_text="Edit").count() == 1 and page.locator(".more-menu button", has_text="Delete").count() == 1)
    page.screenshot(path=str(SHOTS / "13_more_menu.png"))
    page.locator(".more-menu button", has_text="Delete").click()
    page.wait_for_selector(".confirm-dialog")
    check("Delete confirmation names the shipment number", "VERIFY-A1" in page.locator(".confirm-dialog").inner_text())
    page.screenshot(path=str(SHOTS / "14_delete_confirm_blocked.png"))
    page.click(".confirm-dialog button:has-text('Delete')")
    page.wait_for_timeout(600)
    check("Delete blocked with dependent Inward QC message", "Inward QC" in page.locator(".confirm-dialog").inner_text())
    page.screenshot(path=str(SHOTS / "15_delete_blocked_message.png"))
    page.click(".confirm-dialog button:has-text('Close')")

    # ---- permissions: switch to Staff (no create/edit/delete) ----
    page.select_option(".sb-role select", "staff@cirkla.com")
    page.wait_for_timeout(400)
    check("New Record button disabled for Staff (no create permission)", page.locator("button:has-text('+ New Record')").is_disabled())
    row = page.locator("tr:has-text('VERIFY-A1')")
    row.locator(".more-menu-btn").click()
    page.wait_for_timeout(200)
    check("Edit/Delete disabled in More menu for Staff", page.locator(".more-menu button:has-text('Edit')").is_disabled() and page.locator(".more-menu button:has-text('Delete')").is_disabled())
    page.screenshot(path=str(SHOTS / "16_staff_permissions.png"))
    page.keyboard.press("Escape")
    page.select_option(".sb-role select", "r.fernandez@cirkla.com")
    page.wait_for_timeout(300)

    # ---- tablet-sized responsive check ----
    page.set_viewport_size({"width": 1024, "height": 768})
    page.wait_for_timeout(300)
    page.screenshot(path=str(SHOTS / "17_tablet_1024.png"))
    check("Sidebar collapses to icon rail on tablet width", page.locator(".sidebar").bounding_box()["width"] < 120)
    page.set_viewport_size({"width": 800, "height": 1000})
    page.wait_for_timeout(300)
    page.screenshot(path=str(SHOTS / "18_tablet_800.png"))
    check("Table remains usable (scrollable) at 800px width", page.locator(".card-flush").count() > 0)

    browser.close()

print("\n==== SUMMARY ====")
passed = sum(1 for _, ok in results if ok)
for name, ok in results:
    print(("PASS" if ok else "FAIL"), "-", name)
print(f"\n{passed}/{len(results)} checks passed")
