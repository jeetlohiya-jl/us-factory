import uuid
from datetime import datetime

from sqlalchemy import (
    Column, String, Text, Boolean, Numeric, DateTime, ForeignKey, Integer, UniqueConstraint
)
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import relationship

from app.db.session import Base


def gen_uuid():
    return uuid.uuid4()


class AppUser(Base):
    __tablename__ = "app_users"
    id = Column(UUID(as_uuid=True), primary_key=True, default=gen_uuid)
    auth_user_id = Column(UUID(as_uuid=True), nullable=True)
    email = Column(Text, nullable=False, unique=True)
    full_name = Column(Text, nullable=False)
    is_active = Column(Boolean, nullable=False, default=True)
    is_admin = Column(Boolean, nullable=False, default=False)
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow)

    permissions = relationship("ModulePermission", back_populates="user")


class ModulePermission(Base):
    __tablename__ = "module_permissions"
    id = Column(UUID(as_uuid=True), primary_key=True, default=gen_uuid)
    user_id = Column(UUID(as_uuid=True), ForeignKey("app_users.id", ondelete="CASCADE"), nullable=False)
    module = Column(Text, nullable=False)
    can_view = Column(Boolean, nullable=False, default=True)
    can_create = Column(Boolean, nullable=False, default=False)
    can_edit = Column(Boolean, nullable=False, default=False)
    can_delete = Column(Boolean, nullable=False, default=False)
    can_approve = Column(Boolean, nullable=False, default=False)
    can_fill_section = Column(Boolean, nullable=False, default=False)

    user = relationship("AppUser", back_populates="permissions")

    __table_args__ = (UniqueConstraint("user_id", "module"),)


class DisplayIdCounter(Base):
    """Backing store for app.domain.id_counters.next_seq -- one row per
    distinct sequence this app hands out (see that module's docstring for
    the counter_key convention). Not read directly anywhere else; every
    caller goes through next_seq()'s atomic UPSERT."""
    __tablename__ = "display_id_counters"
    counter_key = Column(Text, primary_key=True)
    next_value = Column(Integer, nullable=False, default=1)


class SkuCode(Base):
    __tablename__ = "sku_codes"
    id = Column(UUID(as_uuid=True), primary_key=True, default=gen_uuid)
    code = Column(Text, nullable=False, unique=True)
    category = Column(Text, nullable=False)
    description = Column(Text, nullable=True)
    is_active = Column(Boolean, nullable=False, default=True)
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow)

    # cascade="all, delete-orphan" so deleting a SkuCode via the ORM (see
    # app/api/skus.py delete_sku) issues real DELETEs for its versions
    # instead of SQLAlchemy's default of trying to null out each version's
    # NOT NULL sku_code_id -- which would raise an IntegrityError and make
    # deleting an otherwise-unreferenced SKU fail every time it has any
    # versions at all.
    versions = relationship("SkuVersion", back_populates="sku_code", cascade="all, delete-orphan")


class SkuVersion(Base):
    __tablename__ = "sku_versions"
    id = Column(UUID(as_uuid=True), primary_key=True, default=gen_uuid)
    sku_code_id = Column(UUID(as_uuid=True), ForeignKey("sku_codes.id", ondelete="CASCADE"), nullable=False)
    version = Column(Text, nullable=False)
    is_active = Column(Boolean, nullable=False, default=True)
    # Production Details reference attributes (migration 0013) -- entered
    # once per SKU Version via the SKU Names admin screen, then read
    # (never re-entered) by every Production record that uses this
    # version, matching the prototype's SKU_PRODUCTION_DETAILS lookup.
    # Written exclusively via direct Supabase (Phase 1), same as every
    # other SkuVersion column -- not read or written anywhere in FastAPI.
    prod_weight = Column(Text, nullable=True)
    prod_pcs_per_sleeve = Column(Text, nullable=True)
    prod_sleeve_per_case = Column(Text, nullable=True)
    prod_total_pcs_per_pallet = Column(Integer, nullable=True)
    prod_total_pallets = Column(Integer, nullable=True)
    prod_target_shots = Column(Text, nullable=True)
    prod_pad_type = Column(Text, nullable=True)
    prod_pad_color = Column(Text, nullable=True)
    prod_case_type = Column(Text, nullable=True)
    # Completes the prototype's SKU_PRODUCTION_DETAILS lookup (migration
    # 0015) -- these two weren't needed by Production but IPQC's
    # autopopulation (Dimensions of Pad, Absorption Rate) reads them from
    # the exact same per-SKU-Version reference data.
    prod_dimensions = Column(Text, nullable=True)
    prod_absorption_rate = Column(Text, nullable=True)

    sku_code = relationship("SkuCode", back_populates="versions")

    __table_args__ = (UniqueConstraint("sku_code_id", "version"),)


class Vendor(Base):
    """Vendor master data for the Inward Vehicle Inspection "Vendor Name"
    field, scoped per category (tray/pad/polybag/cfb/glue) since a vendor
    that supplies Padding material may be irrelevant to Glue, etc. Managed
    from a dedicated Vendors admin screen rather than typed freehand on
    every inspection, so the list stays clean and consistent."""
    __tablename__ = "vendors"
    id = Column(UUID(as_uuid=True), primary_key=True, default=gen_uuid)
    category = Column(Text, nullable=False)
    name = Column(Text, nullable=False)
    # 2-letter country code (e.g. "CN", "US") -- the country this vendor
    # ships/packs from. Drives the country prefix on RM pallet display_ids
    # generated from this vendor's Inward QC (see qr_generation_service).
    country = Column(Text, nullable=True)
    is_active = Column(Boolean, nullable=False, default=True)
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow)

    __table_args__ = (UniqueConstraint("category", "name"),)


class Machine(Base):
    """Machine master data for Material Consumption / Production, following
    the exact same admin-managed-list pattern as Vendor (see Vendor above)
    rather than the prototype's hardcoded MACHINES array duplicated in
    several places in its markup."""
    __tablename__ = "machines"
    id = Column(UUID(as_uuid=True), primary_key=True, default=gen_uuid)
    code = Column(Text, nullable=False, unique=True)
    is_active = Column(Boolean, nullable=False, default=True)
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow)


class InwardVehicleInspection(Base):
    __tablename__ = "inward_vehicle_inspections"
    id = Column(UUID(as_uuid=True), primary_key=True, default=gen_uuid)
    shipment_number = Column(Text, nullable=False)
    is_auto_shipment_number = Column(Boolean, nullable=False, default=False)
    category = Column(Text, nullable=False)
    truck_number = Column(Text, nullable=True)
    container_number = Column(Text, nullable=True)
    vendor_name = Column(Text, nullable=True)
    # Nullable FK alongside vendor_name (see migration 0010): vendor_name
    # stays the permanent display snapshot; vendor_id is the real
    # relationship, resolved at write time from the same vendors dropdown
    # the UI already sources vendor_name from, so downstream lookups (RM
    # pallet country resolution) don't have to re-match text at read time.
    vendor_id = Column(UUID(as_uuid=True), ForeignKey("vendors.id"), nullable=True)
    invoice_number = Column(Text, nullable=True)
    transporter_name = Column(Text, nullable=True)
    seal_number = Column(Text, nullable=True)
    total_quantity = Column(Numeric, nullable=True)
    inspection_passed_quantity = Column(Text, nullable=True)
    remarks = Column(Text, nullable=True)
    status = Column(Text, nullable=False, default="draft")
    created_by = Column(UUID(as_uuid=True), ForeignKey("app_users.id"), nullable=True)
    updated_by = Column(UUID(as_uuid=True), ForeignKey("app_users.id"), nullable=True)
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow)
    updated_at = Column(DateTime(timezone=True), default=datetime.utcnow, onupdate=datetime.utcnow)

    vendor = relationship("Vendor", foreign_keys=[vendor_id])
    line_items = relationship(
        "InwardVehicleInspectionLineItem", back_populates="inspection",
        cascade="all, delete-orphan", order_by="InwardVehicleInspectionLineItem.sort_order",
    )
    images = relationship(
        "InwardVehicleInspectionImage", back_populates="inspection",
        cascade="all, delete-orphan", order_by="InwardVehicleInspectionImage.sort_order",
    )
    checklist_answers = relationship(
        "InwardVehicleInspectionChecklistAnswer", back_populates="inspection",
        cascade="all, delete-orphan",
    )


class InwardVehicleInspectionLineItem(Base):
    __tablename__ = "inward_vehicle_inspection_line_items"
    id = Column(UUID(as_uuid=True), primary_key=True, default=gen_uuid)
    inspection_id = Column(UUID(as_uuid=True), ForeignKey("inward_vehicle_inspections.id", ondelete="CASCADE"), nullable=False)
    sku_code_id = Column(UUID(as_uuid=True), ForeignKey("sku_codes.id"), nullable=True)
    sku_version_id = Column(UUID(as_uuid=True), ForeignKey("sku_versions.id"), nullable=True)
    quantity = Column(Numeric, nullable=False, default=0)
    sort_order = Column(Integer, nullable=False, default=0)

    inspection = relationship("InwardVehicleInspection", back_populates="line_items")
    sku_code = relationship("SkuCode")
    sku_version = relationship("SkuVersion")


class InwardVehicleInspectionImage(Base):
    __tablename__ = "inward_vehicle_inspection_images"
    id = Column(UUID(as_uuid=True), primary_key=True, default=gen_uuid)
    inspection_id = Column(UUID(as_uuid=True), ForeignKey("inward_vehicle_inspections.id", ondelete="CASCADE"), nullable=False)
    image_type = Column(Text, nullable=False)
    storage_path = Column(Text, nullable=False)
    public_url = Column(Text, nullable=True)
    ocr_extracted_value = Column(Text, nullable=True)
    ocr_confidence = Column(Numeric, nullable=True)
    ocr_status = Column(Text, nullable=True)
    sort_order = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow)

    inspection = relationship("InwardVehicleInspection", back_populates="images")


class ChecklistItem(Base):
    __tablename__ = "inward_vehicle_inspection_checklist_items"
    id = Column(UUID(as_uuid=True), primary_key=True, default=gen_uuid)
    label = Column(Text, nullable=False)
    sort_order = Column(Integer, nullable=False, default=0)
    is_active = Column(Boolean, nullable=False, default=True)
    # False only for "Vehicle arrived within scheduled time window"
    # (migration 0022) -- an informational-only question whose answer must
    # never affect Approved/Hold status or block submission. True for every
    # other item, which keep behaving exactly as before.
    affects_status = Column(Boolean, nullable=False, default=True)


class InwardVehicleInspectionChecklistAnswer(Base):
    __tablename__ = "inward_vehicle_inspection_checklist_answers"
    id = Column(UUID(as_uuid=True), primary_key=True, default=gen_uuid)
    inspection_id = Column(UUID(as_uuid=True), ForeignKey("inward_vehicle_inspections.id", ondelete="CASCADE"), nullable=False)
    checklist_item_id = Column(UUID(as_uuid=True), ForeignKey("inward_vehicle_inspection_checklist_items.id"), nullable=False)
    answer = Column(Text, nullable=True)

    inspection = relationship("InwardVehicleInspection", back_populates="checklist_answers")
    checklist_item = relationship("ChecklistItem")

    __table_args__ = (UniqueConstraint("inspection_id", "checklist_item_id"),)


class InwardQcRecord(Base):
    __tablename__ = "inward_qc_records"
    id = Column(UUID(as_uuid=True), primary_key=True, default=gen_uuid)
    shipment_number = Column(Text, nullable=False)
    is_auto_shipment_number = Column(Boolean, nullable=False, default=False)
    category = Column(Text, nullable=False)
    status = Column(Text, nullable=False, default="pending")
    linked_vehicle_inspection_id = Column(UUID(as_uuid=True), ForeignKey("inward_vehicle_inspections.id"), nullable=True)
    vendor_name = Column(Text, nullable=True)
    vendor_id = Column(UUID(as_uuid=True), ForeignKey("vendors.id"), nullable=True)
    quantity = Column(Numeric, nullable=True)
    quantity_label = Column(Text, nullable=True)
    sku_code_id = Column(UUID(as_uuid=True), ForeignKey("sku_codes.id"), nullable=True)
    sku_version_id = Column(UUID(as_uuid=True), ForeignKey("sku_versions.id"), nullable=True)
    sku_code_snapshot = Column(Text, nullable=True)
    sku_version_snapshot = Column(Text, nullable=True)
    coa_storage_path = Column(Text, nullable=True)
    coa_filename = Column(Text, nullable=True)
    conclusion_or_suggestions = Column(Text, nullable=True)
    sampling_sample_size = Column(Text, nullable=True)
    sampling_upper_limit = Column(Text, nullable=True)
    sampling_note = Column(Text, nullable=True)
    created_by = Column(UUID(as_uuid=True), ForeignKey("app_users.id"), nullable=True)
    updated_by = Column(UUID(as_uuid=True), ForeignKey("app_users.id"), nullable=True)
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow)
    updated_at = Column(DateTime(timezone=True), default=datetime.utcnow, onupdate=datetime.utcnow)
    submitted_at = Column(DateTime(timezone=True), nullable=True)

    vehicle_inspection = relationship("InwardVehicleInspection")
    vendor = relationship("Vendor", foreign_keys=[vendor_id])
    sku_code = relationship("SkuCode")
    sku_version = relationship("SkuVersion")
    fgtray_answers = relationship(
        "InwardQcFgtrayCriteriaAnswer", back_populates="inward_qc", cascade="all, delete-orphan",
    )
    attribute_values = relationship(
        "InwardQcAttributeValue", back_populates="inward_qc", cascade="all, delete-orphan",
    )
    line_item_snapshots = relationship(
        "InwardQcLineItemSnapshot", back_populates="inward_qc",
        cascade="all, delete-orphan", order_by="InwardQcLineItemSnapshot.sort_order",
    )


class InwardQcFgtrayCriterion(Base):
    __tablename__ = "inward_qc_fgtray_criteria"
    id = Column(UUID(as_uuid=True), primary_key=True, default=gen_uuid)
    label = Column(Text, nullable=False)
    sort_order = Column(Integer, nullable=False, default=0)
    is_active = Column(Boolean, nullable=False, default=True)


class InwardQcFgtrayCriteriaAnswer(Base):
    __tablename__ = "inward_qc_fgtray_criteria_answers"
    id = Column(UUID(as_uuid=True), primary_key=True, default=gen_uuid)
    inward_qc_id = Column(UUID(as_uuid=True), ForeignKey("inward_qc_records.id", ondelete="CASCADE"), nullable=False)
    criteria_id = Column(UUID(as_uuid=True), ForeignKey("inward_qc_fgtray_criteria.id"), nullable=False)
    answer = Column(Text, nullable=True)
    remarks = Column(Text, nullable=True)

    inward_qc = relationship("InwardQcRecord", back_populates="fgtray_answers")
    criteria = relationship("InwardQcFgtrayCriterion")

    __table_args__ = (UniqueConstraint("inward_qc_id", "criteria_id"),)


class InwardQcAttributeDefinition(Base):
    __tablename__ = "inward_qc_attribute_definitions"
    id = Column(UUID(as_uuid=True), primary_key=True, default=gen_uuid)
    category = Column(Text, nullable=False)
    label = Column(Text, nullable=False)
    field_type = Column(Text, nullable=False)
    options_json = Column(JSONB, nullable=True)
    is_required = Column(Boolean, nullable=False, default=False)
    sort_order = Column(Integer, nullable=False, default=0)
    is_active = Column(Boolean, nullable=False, default=True)


class InwardQcAttributeValue(Base):
    __tablename__ = "inward_qc_attribute_values"
    id = Column(UUID(as_uuid=True), primary_key=True, default=gen_uuid)
    inward_qc_id = Column(UUID(as_uuid=True), ForeignKey("inward_qc_records.id", ondelete="CASCADE"), nullable=False)
    attribute_definition_id = Column(UUID(as_uuid=True), ForeignKey("inward_qc_attribute_definitions.id"), nullable=False)
    value = Column(Text, nullable=True)

    inward_qc = relationship("InwardQcRecord", back_populates="attribute_values")
    attribute_definition = relationship("InwardQcAttributeDefinition")

    __table_args__ = (UniqueConstraint("inward_qc_id", "attribute_definition_id"),)


class InwardQcSamplingPlanTier(Base):
    __tablename__ = "inward_qc_sampling_plan_tiers"
    id = Column(UUID(as_uuid=True), primary_key=True, default=gen_uuid)
    category = Column(Text, nullable=False)
    qty_label = Column(Text, nullable=False)
    min_qty = Column(Numeric, nullable=False, default=0)
    max_qty = Column(Numeric, nullable=True)
    sample_size = Column(Integer, nullable=False)
    upper_limit = Column(Integer, nullable=True)
    note = Column(Text, nullable=True)
    sort_order = Column(Integer, nullable=False, default=0)


class InwardQcLineItemSnapshot(Base):
    __tablename__ = "inward_qc_line_item_snapshots"
    id = Column(UUID(as_uuid=True), primary_key=True, default=gen_uuid)
    inward_qc_id = Column(UUID(as_uuid=True), ForeignKey("inward_qc_records.id", ondelete="CASCADE"), nullable=False)
    sku_code_id = Column(UUID(as_uuid=True), ForeignKey("sku_codes.id"), nullable=True)
    sku_version_id = Column(UUID(as_uuid=True), ForeignKey("sku_versions.id"), nullable=True)
    sku_code_snapshot = Column(Text, nullable=True)
    sku_version_snapshot = Column(Text, nullable=True)
    quantity = Column(Numeric, nullable=False, default=0)
    sort_order = Column(Integer, nullable=False, default=0)

    inward_qc = relationship("InwardQcRecord", back_populates="line_item_snapshots")
    sku_code = relationship("SkuCode")
    sku_version = relationship("SkuVersion")


class ProductionRun(Base):
    """
    Minimal Production Run entity — added strictly to give FG QR Generation a
    real upstream source relationship, mirroring the prototype's PROD_RECORDS
    shape. The full Production/IPQC/Material Allocation modules were not
    requested and are intentionally not built here.
    """
    __tablename__ = "production_runs"
    id = Column(UUID(as_uuid=True), primary_key=True, default=gen_uuid)
    run_number = Column(Text, nullable=False, unique=True)
    shipment_number = Column(Text, nullable=True)
    sku_code_id = Column(UUID(as_uuid=True), ForeignKey("sku_codes.id"), nullable=True)
    sku_version_id = Column(UUID(as_uuid=True), ForeignKey("sku_versions.id"), nullable=True)
    category = Column(Text, nullable=False, default="fgtray")
    total_fg_pallets = Column(Integer, nullable=False, default=0)
    shift = Column(Text, nullable=True)
    # Added for Material Consumption: a run is found-or-created by
    # (production_date, shift) -- NOT machine -- so multiple Material
    # Consumption records on different machines for the same date/shift
    # attach to the one run (see ProductionRunMachine below).
    production_date = Column(Text, nullable=True)
    status = Column(Text, nullable=False, default="approved")
    created_by = Column(UUID(as_uuid=True), ForeignKey("app_users.id"), nullable=True)
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow)
    # Rejection Classification (migration 0013) -- editable Production-
    # specific data, matches prodCollectRecord's rc.* / PROD_RECORDS'
    # rejectionClassification exactly. Saved atomically together with
    # total_fg_pallets and the wastage list by production.py's save route.
    rejection_damage = Column(Numeric, nullable=False, default=0)
    rejection_misplaced_glue = Column(Numeric, nullable=False, default=0)
    rejection_misplaced_pad = Column(Numeric, nullable=False, default=0)
    rejection_glue_on_pad = Column(Numeric, nullable=False, default=0)
    rejection_pad_placement_direction = Column(Numeric, nullable=False, default=0)
    rejection_adhesion_issue = Column(Numeric, nullable=False, default=0)
    # Who actually filled in and saved the editable fields above (migration
    # 0014) -- distinct from created_by, which is whoever's Material
    # Consumption save auto-created this run. A run can sit Pending for a
    # while before a (possibly different) user opens and completes it.
    completed_by = Column(UUID(as_uuid=True), ForeignKey("app_users.id"), nullable=True)
    completed_at = Column(DateTime(timezone=True), nullable=True)

    sku_code = relationship("SkuCode")
    sku_version = relationship("SkuVersion")
    machines = relationship("ProductionRunMachine", back_populates="production_run", cascade="all, delete-orphan")
    material_consumptions = relationship("MaterialConsumption", back_populates="production_run")
    ipqc_record = relationship("IpqcRecord", back_populates="production_run", uselist=False)
    rqc_record = relationship("RqcRecord", back_populates="production_run", uselist=False)
    wastage_entries = relationship(
        "ProductionWastageEntry", back_populates="production_run",
        cascade="all, delete-orphan", order_by="ProductionWastageEntry.sort_order",
    )
    completed_by_user = relationship("AppUser", foreign_keys=[completed_by])


class ProductionRunMachine(Base):
    """Join table: a Production Run can span multiple machines (each
    contributed by a different Material Consumption record on the same
    date+shift); a machine can appear on many runs over time."""
    __tablename__ = "production_run_machines"
    id = Column(UUID(as_uuid=True), primary_key=True, default=gen_uuid)
    production_run_id = Column(UUID(as_uuid=True), ForeignKey("production_runs.id", ondelete="CASCADE"), nullable=False)
    machine_id = Column(UUID(as_uuid=True), ForeignKey("machines.id"), nullable=False)

    production_run = relationship("ProductionRun", back_populates="machines")
    machine = relationship("Machine")

    __table_args__ = (UniqueConstraint("production_run_id", "machine_id"),)


class ProductionWastageEntry(Base):
    """Repeatable Wastage entry (Trays, Machine, Reason) tied to one
    Production Run, matching the prototype's prodWastageEntries list.
    Writes go exclusively through FastAPI's production save endpoint;
    reads go direct-to-Supabase (migration 0013)."""
    __tablename__ = "production_wastage_entries"
    id = Column(UUID(as_uuid=True), primary_key=True, default=gen_uuid)
    production_run_id = Column(UUID(as_uuid=True), ForeignKey("production_runs.id", ondelete="CASCADE"), nullable=False)
    machine_id = Column(UUID(as_uuid=True), ForeignKey("machines.id"), nullable=True)
    trays = Column(Numeric, nullable=True)
    reason = Column(Text, nullable=True)
    sort_order = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow)

    production_run = relationship("ProductionRun", back_populates="wastage_entries")
    machine = relationship("Machine")


class IpqcRecord(Base):
    """
    IPQC (In-Process Quality Control) -- auto-created (never duplicated) the
    moment its Production Run's first Material Consumption record is
    finalized (see material_consumption_service.find_or_create_ipqc),
    exactly mirroring the prototype's maFindOrCreateIpqc / linkId dedup.

    One IPQC record per Production Run (unique constraint on
    production_run_id) is the dedup mechanism: since a Production Run is
    itself found-or-created by (date, shift) and never duplicated, keying
    IPQC 1:1 off the run automatically prevents a second Material
    Consumption record on the same date+shift from ever creating a second
    IPQC record for that shift.

    Fields below split the same way as Production's editable-fields work:
    shipment_number/batch_code/manufacturer/pad_color/weight/dimensions/
    absorption_rate are autopopulated at creation from the source Material
    Consumption + SKU Version and never re-entered (locked in the
    prototype's IPQC_LOCKABLE_IDS); shift_incharge and the check blocks
    (ipqc_check_blocks) are genuinely user-entered, saved atomically via
    FastAPI's PUT /api/v1/ipqc-records/{id}.
    """
    __tablename__ = "ipqc_records"
    id = Column(UUID(as_uuid=True), primary_key=True, default=gen_uuid)
    production_run_id = Column(UUID(as_uuid=True), ForeignKey("production_runs.id", ondelete="CASCADE"), nullable=False, unique=True)
    sku_code_id = Column(UUID(as_uuid=True), ForeignKey("sku_codes.id"), nullable=True)
    sku_version_id = Column(UUID(as_uuid=True), ForeignKey("sku_versions.id"), nullable=True)
    sku_code_snapshot = Column(Text, nullable=True)
    sku_version_snapshot = Column(Text, nullable=True)
    shift = Column(Text, nullable=True)
    production_date = Column(Text, nullable=True)
    status = Column(Text, nullable=False, default="pending")
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow)
    # Autopopulated from Material Consumption / SKU Version at creation --
    # locked/read-only in the UI, matching IPQC_LOCKABLE_IDS in the prototype.
    shipment_number = Column(Text, nullable=True)
    batch_code = Column(Text, nullable=True)
    manufacturer = Column(Text, nullable=True)
    pad_color = Column(Text, nullable=True)
    weight = Column(Text, nullable=True)
    dimensions = Column(Text, nullable=True)
    absorption_rate = Column(Text, nullable=True)
    # User-entered, editable regardless of source (not in IPQC_LOCKABLE_IDS).
    shift_incharge = Column(Text, nullable=True)

    production_run = relationship("ProductionRun", back_populates="ipqc_record")
    check_blocks = relationship(
        "IpqcCheckBlock", back_populates="ipqc_record",
        cascade="all, delete-orphan", order_by="IpqcCheckBlock.sort_order",
    )


class IpqcCheckBlock(Base):
    """One IPQC inspection block ("Check Time: HH:MM" card in the
    prototype) -- a record can have several, added via '+ Add Another
    Record'. check_time is stamped once at creation (server time), never
    user-edited afterward, matching the prototype (no oninput handler on
    block.time). overall_result is a free-text field the user types,
    exactly like the prototype's #ipqc-*-overall input -- never computed."""
    __tablename__ = "ipqc_check_blocks"
    id = Column(UUID(as_uuid=True), primary_key=True, default=gen_uuid)
    ipqc_record_id = Column(UUID(as_uuid=True), ForeignKey("ipqc_records.id", ondelete="CASCADE"), nullable=False)
    check_time = Column(Text, nullable=True)
    overall_result = Column(Text, nullable=True)
    sort_order = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow)

    ipqc_record = relationship("IpqcRecord", back_populates="check_blocks")
    defects = relationship(
        "IpqcBlockDefect", back_populates="block",
        cascade="all, delete-orphan", order_by="IpqcBlockDefect.defect_sr",
    )


class IpqcBlockDefect(Base):
    """One defect row's Failure count + Reason within one check block.
    defect_sr matches the prototype's fixed IPQC_DEFECTS list (sr 1, 2, 3,
    6, 7, 8, 9, 10 -- the type/classification/method text is static
    reference data, not stored per record, same as Production's Rejection
    Classification labels). Result (OK / NOT OK) is never stored -- it's
    computed from failure (0 = OK, >=1 = NOT OK), matching
    ipqcRecalcResult exactly."""
    __tablename__ = "ipqc_block_defects"
    id = Column(UUID(as_uuid=True), primary_key=True, default=gen_uuid)
    block_id = Column(UUID(as_uuid=True), ForeignKey("ipqc_check_blocks.id", ondelete="CASCADE"), nullable=False)
    defect_sr = Column(Integer, nullable=False)
    failure = Column(Numeric, nullable=True)
    reason = Column(Text, nullable=True)

    block = relationship("IpqcCheckBlock", back_populates="defects")

    __table_args__ = (UniqueConstraint("block_id", "defect_sr"),)


class RqcRecord(Base):
    """
    RQC (Final Quality Control) -- created MANUALLY only, via "+ New Record"
    (see app/api/rqc.py's POST route / rqc_service.create_rqc). Shipment
    Number is the user-entered business key (unique at the DB level --
    rqc_records_shipment_number_key below) that links this record to
    Production and IPQC: at creation, rqc_service.create_rqc looks up the
    IPQC record already carrying this same shipment_number (IPQC's own
    shipment_number is itself a locked-in snapshot from Material
    Consumption) and, when one exists, reuses its real UUID relationships
    (production_run_id, ipqc_record_id) and SKU snapshot -- never creating a
    duplicate Production/IPQC record, and never required to find a match
    (a shipment number entered before its IPQC record exists is still a
    valid, linkable-later RQC record).

    production_run_id is therefore nullable and no longer unique -- RQC is
    no longer "one record per Production Run" auto-derived from it; it is
    "one record per Shipment Number", manually created.

    The quality gate between IPQC and FG QR Generation: only once *this*
    record's own status is 'approved' -- via its own save route, after its
    own inspection requirements are completed -- does the existing FG QR
    Generation record get created for the run (only possible when a
    Production Run was actually linked).

    sku_code/version are autopopulated at creation from the matched IPQC
    record when one exists, and never re-entered. Manufacturer has no
    upstream source in this app (same as the HTML prototype's own
    plain-text field) so it's seeded with a placeholder and left genuinely
    user-editable. The FG pallet count shown alongside this record is read
    live from production_runs.total_fg_pallets via the FK -- never
    duplicated onto this table, so there is exactly one source of truth for
    "how many FG pallets this run produced."
    """
    __tablename__ = "rqc_records"
    id = Column(UUID(as_uuid=True), primary_key=True, default=gen_uuid)
    production_run_id = Column(UUID(as_uuid=True), ForeignKey("production_runs.id", ondelete="SET NULL"), nullable=True)
    ipqc_record_id = Column(UUID(as_uuid=True), ForeignKey("ipqc_records.id"), nullable=True)
    sku_code_id = Column(UUID(as_uuid=True), ForeignKey("sku_codes.id"), nullable=True)
    sku_version_id = Column(UUID(as_uuid=True), ForeignKey("sku_versions.id"), nullable=True)
    sku_code_snapshot = Column(Text, nullable=True)
    sku_version_snapshot = Column(Text, nullable=True)
    shipment_number = Column(Text, nullable=False)
    manufacturer = Column(Text, nullable=True)
    # Free-text summary field, genuinely user-entered -- never computed,
    # matching the prototype's #rqc-f-overall-result exactly (separate from
    # `status`, which IS computed from the defect grid below).
    overall_result = Column(Text, nullable=True)
    status = Column(Text, nullable=False, default="pending")
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow)

    production_run = relationship("ProductionRun", back_populates="rqc_record")
    ipqc_record = relationship("IpqcRecord")
    sku_code = relationship("SkuCode")
    sku_version = relationship("SkuVersion")
    defect_results = relationship(
        "RqcDefectResult", back_populates="rqc_record",
        cascade="all, delete-orphan", order_by="RqcDefectResult.defect_sr",
    )
    coa_observations = relationship(
        "RqcCoaObservation", back_populates="rqc_record",
        cascade="all, delete-orphan",
    )


class RqcDefectResult(Base):
    """One defect row's Defects Found + Remarks. defect_sr matches RQC's
    own fixed 15-item defect list (RQC_DEFECT_GROUPS in rqc_service.py /
    frontend types.ts) -- 4 classification groups (Unacceptable/Critical/
    Major/Minor), each with its own AQL accept/reject numbers. The
    type/classification/sample-size/accept/reject text is static reference
    data, not stored per record, same as IPQC_DEFECTS. Result (OK / NOT OK)
    is never stored -- it's computed from found vs. the defect's group
    reject threshold, matching rqcRecalcResult exactly."""
    __tablename__ = "rqc_defect_results"
    id = Column(UUID(as_uuid=True), primary_key=True, default=gen_uuid)
    rqc_record_id = Column(UUID(as_uuid=True), ForeignKey("rqc_records.id", ondelete="CASCADE"), nullable=False)
    defect_sr = Column(Integer, nullable=False)
    found = Column(Numeric, nullable=True)
    remarks = Column(Text, nullable=True)

    rqc_record = relationship("RqcRecord", back_populates="defect_results")

    __table_args__ = (UniqueConstraint("rqc_record_id", "defect_sr"),)


class RqcCoaObservation(Base):
    """One Observation value for one COA parameter row, within one of the
    four fixed COA tables (coa_group: 'base' | 'functional' | 'packing' |
    'printing' -- RQC_COA_BASE/FUNCTIONAL/PACKING/PRINTING in
    rqc_service.py / frontend types.ts). Parameter/Specification text is
    static reference data, not stored per record, same as the defect
    grid's type/classification text."""
    __tablename__ = "rqc_coa_observations"
    id = Column(UUID(as_uuid=True), primary_key=True, default=gen_uuid)
    rqc_record_id = Column(UUID(as_uuid=True), ForeignKey("rqc_records.id", ondelete="CASCADE"), nullable=False)
    coa_group = Column(Text, nullable=False)
    sr = Column(Integer, nullable=False)
    observation = Column(Text, nullable=True)

    rqc_record = relationship("RqcRecord", back_populates="coa_observations")

    __table_args__ = (UniqueConstraint("rqc_record_id", "coa_group", "sr"),)


class Location(Base):
    __tablename__ = "locations"
    id = Column(UUID(as_uuid=True), primary_key=True, default=gen_uuid)
    display_id = Column(Text, nullable=False, unique=True)
    zone = Column(Text, nullable=False)
    qr_storage_path = Column(Text, nullable=True)
    qr_public_url = Column(Text, nullable=True)
    qr_payload = Column(Text, nullable=True)
    is_active = Column(Boolean, nullable=False, default=True)
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow)


class QrGenerationRecord(Base):
    __tablename__ = "qr_generation_records"
    id = Column(UUID(as_uuid=True), primary_key=True, default=gen_uuid)
    batch_display_id = Column(Text, nullable=False, unique=True)
    qr_type = Column(Text, nullable=False)  # 'rm' | 'fg'
    category = Column(Text, nullable=True)
    source_inward_qc_id = Column(UUID(as_uuid=True), ForeignKey("inward_qc_records.id"), nullable=True)
    source_production_run_id = Column(UUID(as_uuid=True), ForeignKey("production_runs.id"), nullable=True)
    shipment_number = Column(Text, nullable=True)
    sku_code_id = Column(UUID(as_uuid=True), ForeignKey("sku_codes.id"), nullable=True)
    sku_version_id = Column(UUID(as_uuid=True), ForeignKey("sku_versions.id"), nullable=True)
    sku_code_snapshot = Column(Text, nullable=True)
    sku_version_snapshot = Column(Text, nullable=True)
    # Snapshotted at batch-creation time (see qr_generation_service), same
    # reasoning as sku_code_snapshot: the country that determines this
    # batch's pallet-number prefix must never drift if the vendor's own
    # country is edited later. Always "US" for FG batches -- finished goods
    # are packed at this US factory regardless of any RM vendor upstream.
    country_code = Column(Text, nullable=True)
    quantity = Column(Integer, nullable=False, default=0)
    status = Column(Text, nullable=False, default="pending")  # 'pending' | 'generated'
    created_by = Column(UUID(as_uuid=True), ForeignKey("app_users.id"), nullable=True)
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow)
    generated_at = Column(DateTime(timezone=True), nullable=True)

    source_inward_qc = relationship("InwardQcRecord")
    source_production_run = relationship("ProductionRun")
    sku_code = relationship("SkuCode")
    sku_version = relationship("SkuVersion")
    pallets = relationship("Pallet", back_populates="source_qr_generation", order_by="Pallet.created_at")


class Pallet(Base):
    __tablename__ = "pallets"
    id = Column(UUID(as_uuid=True), primary_key=True, default=gen_uuid)
    display_id = Column(Text, nullable=False, unique=True)
    pallet_type = Column(Text, nullable=False)  # 'rm' | 'fg'
    category = Column(Text, nullable=True)
    sku_code_id = Column(UUID(as_uuid=True), ForeignKey("sku_codes.id"), nullable=True)
    sku_version_id = Column(UUID(as_uuid=True), ForeignKey("sku_versions.id"), nullable=True)
    sku_code_snapshot = Column(Text, nullable=True)
    sku_version_snapshot = Column(Text, nullable=True)
    shipment_number = Column(Text, nullable=True)
    source_qr_generation_id = Column(UUID(as_uuid=True), ForeignKey("qr_generation_records.id"), nullable=False)
    source_inward_qc_id = Column(UUID(as_uuid=True), ForeignKey("inward_qc_records.id"), nullable=True)
    source_production_run_id = Column(UUID(as_uuid=True), ForeignKey("production_runs.id"), nullable=True)
    lifecycle_status = Column(Text, nullable=False, default="generated")
    current_location_id = Column(UUID(as_uuid=True), ForeignKey("locations.id"), nullable=True)
    qr_storage_path = Column(Text, nullable=True)
    qr_public_url = Column(Text, nullable=True)
    qr_payload = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow)
    updated_at = Column(DateTime(timezone=True), default=datetime.utcnow, onupdate=datetime.utcnow)

    sku_code = relationship("SkuCode")
    sku_version = relationship("SkuVersion")
    source_qr_generation = relationship("QrGenerationRecord", back_populates="pallets")
    source_inward_qc = relationship("InwardQcRecord")
    source_production_run = relationship("ProductionRun")
    current_location = relationship("Location")
    lifecycle_events = relationship(
        "PalletLifecycleEvent", back_populates="pallet",
        cascade="all, delete-orphan", order_by="PalletLifecycleEvent.occurred_at",
    )
    storage_record = relationship("StorageRecord", back_populates="pallet", uselist=False)


class PalletLifecycleEvent(Base):
    __tablename__ = "pallet_lifecycle_events"
    id = Column(UUID(as_uuid=True), primary_key=True, default=gen_uuid)
    pallet_id = Column(UUID(as_uuid=True), ForeignKey("pallets.id", ondelete="CASCADE"), nullable=False)
    stage = Column(Text, nullable=False)
    event_metadata = Column("metadata", JSONB, nullable=True)
    actor_user_id = Column(UUID(as_uuid=True), ForeignKey("app_users.id"), nullable=True)
    occurred_at = Column(DateTime(timezone=True), default=datetime.utcnow)

    pallet = relationship("Pallet", back_populates="lifecycle_events")


class StorageRecord(Base):
    __tablename__ = "storage_records"
    id = Column(UUID(as_uuid=True), primary_key=True, default=gen_uuid)
    storage_type = Column(Text, nullable=False)  # 'rm' | 'fg'
    pallet_id = Column(UUID(as_uuid=True), ForeignKey("pallets.id"), nullable=False, unique=True)
    location_id = Column(UUID(as_uuid=True), ForeignKey("locations.id"), nullable=False)
    source_qr_generation_id = Column(UUID(as_uuid=True), ForeignKey("qr_generation_records.id"), nullable=False)
    source_inward_qc_id = Column(UUID(as_uuid=True), ForeignKey("inward_qc_records.id"), nullable=True)
    source_production_run_id = Column(UUID(as_uuid=True), ForeignKey("production_runs.id"), nullable=True)
    stored_by = Column(UUID(as_uuid=True), ForeignKey("app_users.id"), nullable=True)
    stored_at = Column(DateTime(timezone=True), default=datetime.utcnow)

    pallet = relationship("Pallet", back_populates="storage_record")
    location = relationship("Location")
    source_qr_generation = relationship("QrGenerationRecord")
    source_inward_qc = relationship("InwardQcRecord")
    source_production_run = relationship("ProductionRun")
    stored_by_user = relationship("AppUser")


class MaterialConsumption(Base):
    """
    One record = one Shift, spanning one or more MACHINES -- each machine
    tracked as its own MaterialConsumptionMachineEntry (own pallet set, own
    Category/SKU/SKU Version, own start_time/end_time). Before the
    multi-machine redesign a record was pinned to exactly one machine with
    these same fields living directly on this row; those columns are left
    in place (see migration 0008) purely as a non-destructive backfill
    target for pre-existing rows -- application code no longer reads or
    writes them, machine_entries is the source of truth going forward.
    """
    __tablename__ = "material_consumptions"
    id = Column(UUID(as_uuid=True), primary_key=True, default=gen_uuid)
    consumption_date = Column(Text, nullable=False)
    # --- Legacy pre-multi-machine columns (see class docstring) ---
    category = Column(Text, nullable=True)
    sku_code_id = Column(UUID(as_uuid=True), ForeignKey("sku_codes.id"), nullable=True)
    sku_version_id = Column(UUID(as_uuid=True), ForeignKey("sku_versions.id"), nullable=True)
    sku_code_snapshot = Column(Text, nullable=True)
    sku_version_snapshot = Column(Text, nullable=True)
    machine_id = Column(UUID(as_uuid=True), ForeignKey("machines.id"), nullable=True)
    start_time = Column(Text, nullable=True)
    end_time = Column(Text, nullable=True)
    # --- Still-active columns ---
    shift = Column(Text, nullable=True)
    status = Column(Text, nullable=False, default="draft")  # 'draft' | 'saved'
    production_run_id = Column(UUID(as_uuid=True), ForeignKey("production_runs.id"), nullable=True)
    created_by = Column(UUID(as_uuid=True), ForeignKey("app_users.id"), nullable=True)
    updated_by = Column(UUID(as_uuid=True), ForeignKey("app_users.id"), nullable=True)
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow)
    updated_at = Column(DateTime(timezone=True), default=datetime.utcnow, onupdate=datetime.utcnow)

    production_run = relationship("ProductionRun", back_populates="material_consumptions")
    machine_entries = relationship(
        "MaterialConsumptionMachineEntry", back_populates="material_consumption",
        cascade="all, delete-orphan", order_by="MaterialConsumptionMachineEntry.sort_order",
    )


class MaterialConsumptionMachineEntry(Base):
    """
    One machine's slice of a Material Consumption record: its own pallet
    set (primary + secondary materials, via MaterialConsumptionPallet.
    machine_entry_id), its own Category/SKU/SKU Version (established by
    this entry's first scanned primary pallet, same snapshot pattern as
    Pallet.sku_code_snapshot elsewhere), and its own start_time/end_time.
    A record with 2 machines has 2 of these rows; Shift lives one level up
    on MaterialConsumption since it's shared across every machine entry.
    """
    __tablename__ = "material_consumption_machine_entries"
    id = Column(UUID(as_uuid=True), primary_key=True, default=gen_uuid)
    material_consumption_id = Column(UUID(as_uuid=True), ForeignKey("material_consumptions.id", ondelete="CASCADE"), nullable=False)
    machine_id = Column(UUID(as_uuid=True), ForeignKey("machines.id"), nullable=True)
    category = Column(Text, nullable=True)  # 'tray' | 'fgtray' -- set by this entry's first primary pallet scan
    sku_code_id = Column(UUID(as_uuid=True), ForeignKey("sku_codes.id"), nullable=True)
    sku_version_id = Column(UUID(as_uuid=True), ForeignKey("sku_versions.id"), nullable=True)
    sku_code_snapshot = Column(Text, nullable=True)
    sku_version_snapshot = Column(Text, nullable=True)
    start_time = Column(Text, nullable=True)
    end_time = Column(Text, nullable=True)
    sort_order = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow)

    material_consumption = relationship("MaterialConsumption", back_populates="machine_entries")
    machine = relationship("Machine")
    sku_code = relationship("SkuCode")
    sku_version = relationship("SkuVersion")
    pallets = relationship(
        "MaterialConsumptionPallet", back_populates="machine_entry",
        cascade="all, delete-orphan", order_by="MaterialConsumptionPallet.sort_order",
    )


class MaterialConsumptionPallet(Base):
    """
    Every pallet attached to a Material Consumption record -- both the
    primary RM pallets being consumed (role='primary') AND the secondary
    materials (role='cfb'/'pad'/'glue'/'polybag') -- in ONE table so a
    single unique constraint on pallet_id enforces, at the database level,
    that a pallet can never be attached to more than one *active*
    (draft-or-saved) Material Consumption record at a time, in any role.
    Scoped to one MACHINE ENTRY (machine_entry_id) within a record, since
    each machine has its own pallet set; material_consumption_id is kept
    alongside it (denormalized) purely so cross-record lookups don't need
    an extra join. Deleting the owning machine entry (only ever allowed
    while the record is still a draft, see the delete-dependency check in
    the API) frees the pallet immediately via cascade.

    Structured, not a comma-separated string -- see MaterialConsumption's
    module docstring and the task's explicit "do not store the pallet
    relationship only as a comma-separated display string" instruction.
    """
    __tablename__ = "material_consumption_pallets"
    id = Column(UUID(as_uuid=True), primary_key=True, default=gen_uuid)
    material_consumption_id = Column(UUID(as_uuid=True), ForeignKey("material_consumptions.id", ondelete="CASCADE"), nullable=False)
    machine_entry_id = Column(UUID(as_uuid=True), ForeignKey("material_consumption_machine_entries.id", ondelete="CASCADE"), nullable=False)
    role = Column(Text, nullable=False)  # 'primary' | 'cfb' | 'pad' | 'glue' | 'polybag'
    pallet_id = Column(UUID(as_uuid=True), ForeignKey("pallets.id"), nullable=False, unique=True)
    quantity = Column(Numeric, nullable=False, default=1)
    sort_order = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow)

    machine_entry = relationship("MaterialConsumptionMachineEntry", back_populates="pallets")
    pallet = relationship("Pallet")


class CustomerShipment(Base):
    """
    Customer Shipment -- the downstream workflow after FG Storage:
      FG Storage -> Customer Shipment -> Shipment Picking

    A manual, Admin-only record (create-once, no edit, no status workflow
    of its own -- see migration 0020's header notes). Creating one is the
    completion event; it atomically fans out exactly one
    ShipmentPickingRequest per line item (see
    customer_shipment_service.create_customer_shipment). Does NOT touch RQC
    -- RQC is fully upstream (Material Consumption -> Production -> IPQC ->
    RQC -> FG QR Generation -> FG Storage) and must never be re-triggered
    here.
    """
    __tablename__ = "customer_shipments"
    id = Column(UUID(as_uuid=True), primary_key=True, default=gen_uuid)
    shipment_number = Column(Text, nullable=False, unique=True)
    container_number = Column(Text, nullable=False, unique=True)
    customer = Column(Text, nullable=False)
    created_by = Column(UUID(as_uuid=True), ForeignKey("app_users.id"), nullable=True)
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow)

    line_items = relationship(
        "CustomerShipmentLineItem", back_populates="customer_shipment",
        cascade="all, delete-orphan",
    )
    picking_requests = relationship("ShipmentPickingRequest", back_populates="customer_shipment")


class CustomerShipmentLineItem(Base):
    __tablename__ = "customer_shipment_line_items"
    id = Column(UUID(as_uuid=True), primary_key=True, default=gen_uuid)
    customer_shipment_id = Column(UUID(as_uuid=True), ForeignKey("customer_shipments.id", ondelete="CASCADE"), nullable=False)
    sku_code_id = Column(UUID(as_uuid=True), ForeignKey("sku_codes.id"), nullable=True)
    sku_version_id = Column(UUID(as_uuid=True), ForeignKey("sku_versions.id"), nullable=True)
    sku_code_snapshot = Column(Text, nullable=True)
    sku_version_snapshot = Column(Text, nullable=True)
    pallets_required = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow)

    customer_shipment = relationship("CustomerShipment", back_populates="line_items")
    sku_code = relationship("SkuCode")
    sku_version = relationship("SkuVersion")


class ShipmentPickingRequest(Base):
    """
    One per CustomerShipmentLineItem (unique constraint on
    customer_shipment_line_item_id backstops this -- never one generic
    request per whole shipment). Every field needed to drive picking
    (Shipment Number, Customer, SKU Code, SKU Version, required pallet
    quantity) is snapshotted here at fan-out time, matching the
    snapshot-at-creation convention used by qr_generation_records / pallets
    / rqc_records elsewhere in this app.
    """
    __tablename__ = "shipment_picking_requests"
    id = Column(UUID(as_uuid=True), primary_key=True, default=gen_uuid)
    customer_shipment_id = Column(UUID(as_uuid=True), ForeignKey("customer_shipments.id"), nullable=False)
    customer_shipment_line_item_id = Column(UUID(as_uuid=True), ForeignKey("customer_shipment_line_items.id"), nullable=False, unique=True)
    shipment_number = Column(Text, nullable=True)
    container_number = Column(Text, nullable=True)
    customer = Column(Text, nullable=True)
    sku_code_id = Column(UUID(as_uuid=True), ForeignKey("sku_codes.id"), nullable=True)
    sku_version_id = Column(UUID(as_uuid=True), ForeignKey("sku_versions.id"), nullable=True)
    sku_code_snapshot = Column(Text, nullable=True)
    sku_version_snapshot = Column(Text, nullable=True)
    pallets_required = Column(Integer, nullable=False, default=0)
    status = Column(Text, nullable=False, default="pending")  # 'pending' | 'partial' | 'complete'
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow)

    customer_shipment = relationship("CustomerShipment", back_populates="picking_requests")
    line_item = relationship("CustomerShipmentLineItem")
    sku_code = relationship("SkuCode")
    sku_version = relationship("SkuVersion")
    picks = relationship(
        "ShipmentPickingPick", back_populates="request",
        cascade="all, delete-orphan", order_by="ShipmentPickingPick.picked_at",
    )


class ShipmentPickingPick(Base):
    """
    The one genuinely new piece of information nothing existing tracks:
    which specific pallet was picked against which request, and from which
    location (so an undo/remove-pick can restore a StorageRecord there).
    Picking itself reuses Pallet.lifecycle_status ('picked') +
    PalletLifecycleEvent + deleting the pallet's StorageRecord -- no
    duplicate pallet or storage source of truth is created here.
    """
    __tablename__ = "shipment_picking_picks"
    id = Column(UUID(as_uuid=True), primary_key=True, default=gen_uuid)
    shipment_picking_request_id = Column(UUID(as_uuid=True), ForeignKey("shipment_picking_requests.id", ondelete="CASCADE"), nullable=False)
    pallet_id = Column(UUID(as_uuid=True), ForeignKey("pallets.id"), nullable=False)
    location_id = Column(UUID(as_uuid=True), ForeignKey("locations.id"), nullable=True)
    picked_by = Column(UUID(as_uuid=True), ForeignKey("app_users.id"), nullable=True)
    picked_at = Column(DateTime(timezone=True), default=datetime.utcnow)

    request = relationship("ShipmentPickingRequest", back_populates="picks")
    pallet = relationship("Pallet")
    location = relationship("Location")


class OutwardVehicleInspection(Base):
    """
    Auto-created (never manually) the instant a Customer Shipment is
    recorded -- one per Customer Shipment (unique constraint on
    customer_shipment_id backstops idempotency). NOT linked to RQC --
    per explicit clarification, the real chain here is Customer Shipment
    -> Shipment Picking -> Outward Vehicle Inspection, not RQC. Starts
    'pending'; only its own save route (api/outward_vehicle_inspection.py)
    moves it to draft/hold/approved.
    """
    __tablename__ = "outward_vehicle_inspections"
    id = Column(UUID(as_uuid=True), primary_key=True, default=gen_uuid)
    customer_shipment_id = Column(UUID(as_uuid=True), ForeignKey("customer_shipments.id"), nullable=False, unique=True)
    shipment_number = Column(Text, nullable=True)
    customer_name = Column(Text, nullable=True)
    quantity = Column(Text, nullable=True)
    truck_number = Column(Text, nullable=True)
    invoice_number = Column(Text, nullable=True)
    transporter_name = Column(Text, nullable=True)
    seal_number = Column(Text, nullable=True)
    remarks = Column(Text, nullable=True)
    status = Column(Text, nullable=False, default="pending")  # 'pending' | 'draft' | 'approved' | 'hold'
    created_by = Column(UUID(as_uuid=True), ForeignKey("app_users.id"), nullable=True)
    updated_by = Column(UUID(as_uuid=True), ForeignKey("app_users.id"), nullable=True)
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow)
    updated_at = Column(DateTime(timezone=True), default=datetime.utcnow, onupdate=datetime.utcnow)

    customer_shipment = relationship("CustomerShipment")
    answers = relationship(
        "OutwardVehicleInspectionAnswer", back_populates="inspection",
        cascade="all, delete-orphan",
    )
    images = relationship(
        "OutwardVehicleInspectionImage", back_populates="inspection",
        cascade="all, delete-orphan", order_by="OutwardVehicleInspectionImage.sort_order",
    )


class OutwardVehicleInspectionAnswer(Base):
    """
    Per-record answers to the 7 fixed vehicle-condition checks
    (OVI_QUESTIONS in ovi_service.py) -- keyed by plain integer question_sr,
    same shape as rqc_defect_results.defect_sr, not a checklist_item_id FK
    (see migration 0021's header notes on why inward_vehicle_inspection_
    checklist_items wasn't reused: different, unrelated question content).
    """
    __tablename__ = "outward_vehicle_inspection_answers"
    id = Column(UUID(as_uuid=True), primary_key=True, default=gen_uuid)
    inspection_id = Column(UUID(as_uuid=True), ForeignKey("outward_vehicle_inspections.id", ondelete="CASCADE"), nullable=False)
    question_sr = Column(Integer, nullable=False)
    answer = Column(Text, nullable=True)  # 'ok' | 'not_ok' | null

    inspection = relationship("OutwardVehicleInspection", back_populates="answers")

    __table_args__ = (UniqueConstraint("inspection_id", "question_sr"),)


class OutwardVehicleInspectionImage(Base):
    """
    Loading-process photos for an Outward Vehicle Inspection record -- one
    named slot per row/photo type from the "Loading Container Process"
    template (License Plate, Container Number, Before Loading, First Row
    .. Eleventh Row, Seal Half/Entire, Lead Seal, Weighbridge Record; see
    OVI_IMAGE_TYPES in ovi_service.py for the fixed list). Same shape and
    same FastAPI upload/replace/delete routes as inward_vehicle_inspection_
    images (storage adapter, no OCR here -- these are loading-progress
    photos, not identifier images to extract text from).
    """
    __tablename__ = "outward_vehicle_inspection_images"
    id = Column(UUID(as_uuid=True), primary_key=True, default=gen_uuid)
    inspection_id = Column(UUID(as_uuid=True), ForeignKey("outward_vehicle_inspections.id", ondelete="CASCADE"), nullable=False)
    image_type = Column(Text, nullable=False)
    storage_path = Column(Text, nullable=False)
    public_url = Column(Text, nullable=True)
    sort_order = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow)

    inspection = relationship("OutwardVehicleInspection", back_populates="images")


class MachineDowntimeRecord(Base):
    """
    Fully independent of the shipment workflow (Customer Shipment/Shipment
    Picking/RQC/OVI) -- written directly by the browser via Supabase (RLS-
    gated, see migration 0021), same convention as sku_codes/vendors/
    machines. duration_minutes is computed and stored at save time (handles
    the overnight-wrap case, e.g. 23:30 -> 00:15 = 45m) so list/search/sort
    never have to recompute it from start/end on every read.
    """
    __tablename__ = "machine_downtime_records"
    id = Column(UUID(as_uuid=True), primary_key=True, default=gen_uuid)
    machine_id = Column(UUID(as_uuid=True), ForeignKey("machines.id"), nullable=True)
    machine_snapshot = Column(Text, nullable=True)
    shift = Column(Text, nullable=True)
    start_time = Column(Text, nullable=True)
    end_time = Column(Text, nullable=True)
    duration_minutes = Column(Integer, nullable=True)
    reason = Column(Text, nullable=True)
    status = Column(Text, nullable=False, default="draft")  # 'draft' | 'saved'
    created_by = Column(UUID(as_uuid=True), ForeignKey("app_users.id"), nullable=True)
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow)
    updated_at = Column(DateTime(timezone=True), default=datetime.utcnow, onupdate=datetime.utcnow)

    machine = relationship("Machine")


class HoldReleaseRecord(Base):
    """
    Hold & Release -- one row per (module, record_id), created (find-or-
    create, idempotent via the unique constraint) the moment a user opens a
    'hold'-status record in one of the five gated modules (Inward Vehicle
    Inspection, Inward QC, IPQC, RQC, Outward Vehicle Inspection). Written
    directly by the browser via Supabase (RLS-gated, see migration 0024),
    same convention as Machine Downtime / sku_codes / vendors / machines --
    there is no FastAPI router for this table, it's a plain form with no
    privileged/transactional logic.

    record_id is NOT a real foreign key (see migration 0024's comment) --
    it points into whichever of the five modules' own tables `module`
    names. This table only ever adds to a Hold record; it never overwrites
    or duplicates the original inspection's own data.
    """
    __tablename__ = "hold_release_records"
    id = Column(UUID(as_uuid=True), primary_key=True, default=gen_uuid)
    module = Column(Text, nullable=False)
    record_id = Column(UUID(as_uuid=True), nullable=False)
    date_of_hold = Column(Text, nullable=True)
    product_name = Column(Text, nullable=True)
    batch_code = Column(Text, nullable=True)
    point_of_detection = Column(Text, nullable=True)
    qty_of_hold = Column(Text, nullable=True)
    reason_for_hold = Column(Text, nullable=True)
    record_filled_by = Column(Text, nullable=True)
    date_of_decision = Column(Text, nullable=True)
    disposition = Column(Text, nullable=True)
    reason_of_disposition = Column(Text, nullable=True)
    qty_decided = Column(Text, nullable=True)
    done_by = Column(Text, nullable=True)
    approved_by = Column(Text, nullable=True)
    status = Column(Text, nullable=False, default="draft")  # 'draft' | 'completed'
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow)
    updated_at = Column(DateTime(timezone=True), default=datetime.utcnow, onupdate=datetime.utcnow)
