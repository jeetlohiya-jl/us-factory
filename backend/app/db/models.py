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
    is_active = Column(Boolean, nullable=False, default=True)
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow)

    __table_args__ = (UniqueConstraint("category", "name"),)


class InwardVehicleInspection(Base):
    __tablename__ = "inward_vehicle_inspections"
    id = Column(UUID(as_uuid=True), primary_key=True, default=gen_uuid)
    shipment_number = Column(Text, nullable=False)
    is_auto_shipment_number = Column(Boolean, nullable=False, default=False)
    category = Column(Text, nullable=False)
    truck_number = Column(Text, nullable=True)
    container_number = Column(Text, nullable=True)
    vendor_name = Column(Text, nullable=True)
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
    status = Column(Text, nullable=False, default="approved")
    created_by = Column(UUID(as_uuid=True), ForeignKey("app_users.id"), nullable=True)
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow)

    sku_code = relationship("SkuCode")
    sku_version = relationship("SkuVersion")


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
