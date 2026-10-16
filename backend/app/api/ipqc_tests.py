"""
Falcon IPQC -- Burst Test and Pinhole Test (migration 0090).

Both tests are tied to a PRODUCTION RUN and one lamination machine (LM1-LM7)
-- never to a SKU alone -- and follow the Outward Vehicle Inspection pattern:
a list, a side panel to open / fill / save / revisit a record, Save Draft and
Save, status computed on the server, photos/files attached to the record.

  GET  /run-options                  runs (+ their lamination machines) to start a test from
  POST /burst-tests | /pinhole-tests create (idempotent on client_request_id)
  GET  /{kind}-tests, /{kind}-tests/{id}
  PUT  /{kind}-tests/{id}            the one atomic save (header + all readings)
  DELETE /{kind}-tests/{id}
  POST /{kind}-tests/{id}/attachments, DELETE .../attachments/{attachment_id}

Permissions reuse the existing "ipqc" module: view to read, fill_section to
create / save / attach (the same "fill in this record" gate every inspection
uses), delete to delete. Falcon only: Gainesville gets a 404.
Recorded By and the testing time are stamped here from the signed-in user and
the database clock -- the client never sends either.
"""
import uuid
from typing import Optional

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile, status
from sqlalchemy import func, or_, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, joinedload, selectinload

from app.adapters.auth.base import AuthenticatedUser
from app.adapters.storage.factory import get_storage_adapter
from app.api import deps, schemas
from app.api.deps import get_current_user
from app.core.product import FALCON, current_unit
from app.db import models
from app.db.session import get_db
from app.domain import ipqc_attachments as att_svc
from app.domain import ipqc_tests_service as svc

router = APIRouter(prefix="/api/v1/ipqc-tests", tags=["ipqc"])

MODULE = "ipqc"
PAGE_SIZE = 50
KINDS = {
    "burst": {"model": models.IpqcBurstTest, "reading": models.IpqcBurstTestReading, "fk": "burst_test_id", "label": "Burst Test"},
    "pinhole": {"model": models.IpqcPinholeTest, "reading": models.IpqcPinholeTestReading, "fk": "pinhole_test_id", "label": "Pinhole Test"},
}


def _falcon_only():
    # Burst / Pinhole tests and IPQC attachments are Falcon-only.
    if current_unit() != FALCON:
        raise HTTPException(status_code=404, detail="Not found.")


def get_perms(current_user: AuthenticatedUser = Depends(get_current_user), db: Session = Depends(get_db)) -> models.ModulePermission:
    return deps.effective_permission(db, current_user.user_id, MODULE)


def require(action: str):
    def _dep(perm: models.ModulePermission = Depends(get_perms)):
        if not getattr(perm, f"can_{action}", False):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=f"You do not have permission to {action} this record.")
        return perm
    return _dep


def _kind(kind: str) -> dict:
    cfg = KINDS.get(kind)
    if cfg is None:
        raise HTTPException(status_code=404, detail="Not found.")
    return cfg


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def _names(db: Session, ids) -> dict:
    ids = {i for i in ids if i}
    if not ids:
        return {}
    return {u.id: u.full_name for u in db.query(models.AppUser).filter(models.AppUser.id.in_(ids))}


def _event(db: Session, kind: str, test, action: str, user_id, detail: Optional[str] = None) -> None:
    db.add(models.IpqcTestEvent(
        **{KINDS[kind]["fk"]: test.id}, action=action, status_after=test.status, detail=detail,
        user_id=uuid.UUID(str(user_id)) if user_id else None,
    ))


def _load(db: Session, kind: str, test_id: uuid.UUID, lock: bool = False):
    cfg = _kind(kind)
    q = db.query(cfg["model"]).filter(cfg["model"].id == test_id)
    if lock:
        q = q.with_for_update()
    test = q.first()
    if not test:
        raise HTTPException(status_code=404, detail=f"{cfg['label']} not found.")
    return test


def _serialize(db: Session, kind: str, t, created: bool = False):
    attachments = sorted(t.attachments, key=lambda a: a.created_at or 0)
    events = sorted(t.events, key=lambda e: e.created_at or 0, reverse=True)
    users = _names(db, [t.recorded_by, t.updated_by] + [a.uploaded_by for a in attachments] + [e.user_id for e in events])
    common = dict(
        id=t.id, production_run_id=t.production_run_id, run_number=t.run_number_snapshot, machine_id=t.machine_id,
        machine_code=t.machine_code, sku_code=t.sku_code_snapshot, sku_version=t.sku_version_snapshot, shift=t.shift,
        production_date=t.production_date, test_number=t.test_number, container_number=t.container_number,
        remarks=t.remarks, status=t.status, fail_count=t.fail_count, tested_at=t.tested_at,
        recorded_by_name=users.get(t.recorded_by), updated_by_name=users.get(t.updated_by), updated_at=t.updated_at,
        attachments=[
            schemas.IpqcAttachmentOut(
                id=a.id, filename=a.filename, content_type=a.content_type, size_bytes=a.size_bytes,
                public_url=a.public_url, uploaded_by_name=users.get(a.uploaded_by), created_at=a.created_at)
            for a in attachments
        ],
        events=[
            schemas.IpqcTestEventOut(
                id=e.id, action=e.action, status_after=e.status_after, detail=e.detail,
                user_name=users.get(e.user_id), created_at=e.created_at)
            for e in events
        ],
        created=created,
    )
    if kind == "burst":
        return schemas.BurstTestOut(
            **common, undetermined_count=t.undetermined_count,
            readings=[schemas.BurstReadingOut(sr=r.sr, sealing_temp_c=r.sealing_temp_c, sealing_time_s=r.sealing_time_s,
                                              burst_inhg=r.burst_inhg, result=r.result) for r in t.readings],
        )
    return schemas.PinholeTestOut(
        **common, sku_weight=t.sku_weight_snapshot,
        readings=[schemas.PinholeReadingOut(sr=r.sr, shot_number=r.shot_number, avg_weight_g=r.avg_weight_g,
                                            trays_failed=r.trays_failed, remarks=r.remarks, result=r.result) for r in t.readings],
    )


def _machine_out(m) -> schemas.IpqcRunMachineOut:
    return schemas.IpqcRunMachineOut(machine_id=m["machine_id"], machine_code=m["machine_code"],
                                     sku_code=m.get("sku_code"), sku_version=m.get("sku_version"))


# ---------------------------------------------------------------------------
# run picker
# ---------------------------------------------------------------------------

@router.get("/run-options", response_model=list[schemas.IpqcRunOptionOut])
def run_options(
    search: str = Query("", max_length=60),
    db: Session = Depends(get_db),
    _f=Depends(_falcon_only),
    _perm=Depends(require("view")),
):
    """Recent Production Runs to start a test from, each with the lamination
    machines (LM1-LM7) used on it. One query for the runs plus one for the
    machine list -- the panel never fetches per run."""
    q = (
        db.query(models.ProductionRun)
        .options(
            joinedload(models.ProductionRun.sku_code),
            joinedload(models.ProductionRun.sku_version),
            joinedload(models.ProductionRun.material_consumptions)
            .joinedload(models.MaterialConsumption.machine_entries)
            .joinedload(models.MaterialConsumptionMachineEntry.machine),
        )
        .order_by(models.ProductionRun.created_at.desc())
    )
    s = search.strip()
    if s:
        like = f"%{s}%"
        q = q.filter(or_(models.ProductionRun.run_number.ilike(like), models.ProductionRun.shipment_number.ilike(like)))
    runs = q.limit(25).all()
    seen, out = set(), []
    lamination = [
        {"machine_id": m.id, "machine_code": m.code}
        for m in db.query(models.Machine).filter(models.Machine.machine_type == "lamination", models.Machine.is_active.is_(True)).order_by(models.Machine.code)
        if svc.is_valid_lamination_machine(m)
    ]
    for r in runs:
        if r.id in seen:
            continue
        seen.add(r.id)
        used = svc.run_lamination_machines(r)
        out.append(schemas.IpqcRunOptionOut(
            production_run_id=r.id, run_number=r.run_number, shipment_number=r.shipment_number, shift=r.shift,
            production_date=r.production_date,
            sku_code=(used[0]["sku_code"] if used and used[0]["sku_code"] else (r.sku_code.code if r.sku_code else None)),
            sku_version=(used[0]["sku_version"] if used and used[0]["sku_version"] else (r.sku_version.version if r.sku_version else None)),
            machines=[_machine_out(u) for u in used],
            all_machines=[_machine_out(m) for m in lamination],
        ))
    return out


# ---------------------------------------------------------------------------
# list / get / create / save / delete
# ---------------------------------------------------------------------------

@router.get("/{kind}-tests", response_model=schemas.IpqcTestListOut)
def list_tests(
    kind: str,
    search: str = Query("", max_length=60),
    status_filter: str = Query("", alias="status"),
    machine: str = Query("", max_length=20),
    production_run_id: Optional[uuid.UUID] = None,
    page: int = Query(1, ge=1),
    db: Session = Depends(get_db),
    _f=Depends(_falcon_only),
    _perm=Depends(require("view")),
):
    cfg = _kind(kind)
    M = cfg["model"]
    q = db.query(M)
    if production_run_id:
        q = q.filter(M.production_run_id == production_run_id)
    if status_filter in ("draft", "passed", "failed"):
        q = q.filter(M.status == status_filter)
    if machine:
        q = q.filter(M.machine_code == machine)
    s = search.strip()
    if s:
        like = f"%{s}%"
        q = q.filter(or_(M.run_number_snapshot.ilike(like), M.sku_code_snapshot.ilike(like), M.container_number.ilike(like)))
    total = q.count()
    rows = (
        q.options(selectinload(M.readings), selectinload(M.attachments))
        .order_by(M.created_at.desc(), M.test_number.desc())
        .offset((page - 1) * PAGE_SIZE).limit(PAGE_SIZE).all()
    )
    users = _names(db, [r.recorded_by for r in rows])
    return schemas.IpqcTestListOut(
        matched_count=total,
        items=[
            schemas.IpqcTestListItem(
                id=r.id, run_number=r.run_number_snapshot, production_run_id=r.production_run_id, machine_code=r.machine_code,
                sku_code=r.sku_code_snapshot, sku_version=r.sku_version_snapshot, shift=r.shift, test_number=r.test_number,
                container_number=r.container_number, status=r.status, reading_count=len(r.readings),
                attachment_count=len(r.attachments), tested_at=r.tested_at, recorded_by_name=users.get(r.recorded_by),
            )
            for r in rows
        ],
    )


@router.get("/{kind}-tests/{test_id}")
def get_test(
    kind: str, test_id: uuid.UUID, db: Session = Depends(get_db),
    _f=Depends(_falcon_only), _perm=Depends(require("view")),
):
    t = _load(db, kind, test_id)
    return _serialize(db, kind, t)


@router.post("/{kind}-tests", status_code=status.HTTP_201_CREATED)
def create_test(
    kind: str,
    payload: schemas.IpqcTestCreateIn,
    db: Session = Depends(get_db),
    current_user: AuthenticatedUser = Depends(get_current_user),
    _f=Depends(_falcon_only),
    _perm=Depends(require("fill_section")),
):
    """Starts a test for a Production Run. Idempotent on client_request_id: a
    retry or double click returns the SAME record (201 -> 200 with created=false)
    instead of a duplicate, while a new request id (a new "start test") for the
    same run legitimately creates test #2, #3 ... Recorded By and the testing
    time come from the login and the database clock."""
    cfg = _kind(kind)
    M = cfg["model"]

    def existing():
        return db.query(M).filter(M.client_request_id == payload.client_request_id).first()

    found = existing()
    if found:
        if found.production_run_id != payload.production_run_id:
            raise HTTPException(status_code=409, detail="This request id was already used for a different Production Run.")
        return _serialize(db, kind, found, created=False)

    run = svc.load_run(db, payload.production_run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Production Run not found.")
    try:
        link = svc.resolve_link(db, run, payload.machine_id)
    except svc.TestRuleError as e:
        raise HTTPException(status_code=422, detail=e.message)

    extra = {"sku_weight_snapshot": link["sku_weight_snapshot"]} if kind == "pinhole" else {}
    # Serialise creates per run (released at commit/rollback): numbering stays
    # gap-free and in order even when several people start a test at once, and a
    # second click with the same request id waits, then finds the first row.
    db.execute(text("select pg_advisory_xact_lock(hashtextextended(:k, 0))"), {"k": f"ipqc-{kind}-{run.id}"})
    found = existing()
    if found:
        return _serialize(db, kind, found, created=False)
    for _attempt in range(4):
        next_no = (db.query(func.coalesce(func.max(M.test_number), 0)).filter(M.production_run_id == run.id).scalar() or 0) + 1
        try:
            with db.begin_nested():
                t = M(
                    client_request_id=payload.client_request_id, production_run_id=run.id,
                    run_number_snapshot=link["run_number_snapshot"], machine_id=link["machine_id"], machine_code=link["machine_code"],
                    sku_code_id=link["sku_code_id"], sku_version_id=link["sku_version_id"],
                    sku_code_snapshot=link["sku_code_snapshot"], sku_version_snapshot=link["sku_version_snapshot"],
                    shift=link["shift"], production_date=link["production_date"], test_number=next_no, status="draft",
                    recorded_by=uuid.UUID(current_user.user_id), updated_by=uuid.UUID(current_user.user_id), **extra,
                )
                db.add(t)
                db.flush()
            break
        except IntegrityError:
            # Lost a race: either the same request id landed first, or another test took this number.
            found = existing()
            if found:
                return _serialize(db, kind, found, created=False)
    else:
        raise HTTPException(status_code=409, detail="Could not allocate a test number; please try again.")
    _event(db, kind, t, "created", current_user.user_id, f"Test #{t.test_number} on {t.machine_code}")
    db.commit()
    db.refresh(t)
    return _serialize(db, kind, t, created=True)


def _save_common(db, kind, t, payload, current_user, ev: dict, detail: str):
    t.container_number = (payload.container_number or "").strip() or None
    t.remarks = (payload.remarks or "").strip() or None
    t.status = ev["status"]
    t.fail_count = ev["fail_count"]
    if kind == "burst":
        t.undetermined_count = ev["undetermined_count"]
    t.updated_by = uuid.UUID(current_user.user_id)
    _event(db, kind, t, "saved", current_user.user_id, detail)


@router.put("/burst-tests/{test_id}", response_model=schemas.BurstTestOut)
def save_burst_test(
    test_id: uuid.UUID,
    payload: schemas.BurstTestSaveIn,
    db: Session = Depends(get_db),
    current_user: AuthenticatedUser = Depends(get_current_user),
    _f=Depends(_falcon_only),
    _perm=Depends(require("fill_section")),
):
    """Atomic save: header + every reading replaced together. Status is worked
    out here (draft / passed / failed), never trusted from the client."""
    t = _load(db, "burst", test_id, lock=True)
    try:
        ev = svc.evaluate_burst(payload.save_mode, payload.container_number, payload.remarks, payload.readings)
    except svc.TestRuleError as e:
        raise HTTPException(status_code=422, detail=e.message)
    for existing in list(t.readings):
        db.delete(existing)
    db.flush()
    for r in ev["rows"]:
        db.add(models.IpqcBurstTestReading(test_id=t.id, **r))
    detail = f"{payload.save_mode.title()} save, {len(ev['rows'])} reading(s), {ev['fail_count']} failed"
    _save_common(db, "burst", t, payload, current_user, ev, detail)
    db.commit()
    db.refresh(t)
    return _serialize(db, "burst", t)


@router.put("/pinhole-tests/{test_id}", response_model=schemas.PinholeTestOut)
def save_pinhole_test(
    test_id: uuid.UUID,
    payload: schemas.PinholeTestSaveIn,
    db: Session = Depends(get_db),
    current_user: AuthenticatedUser = Depends(get_current_user),
    _f=Depends(_falcon_only),
    _perm=Depends(require("fill_section")),
):
    t = _load(db, "pinhole", test_id, lock=True)
    try:
        ev = svc.evaluate_pinhole(payload.save_mode, payload.readings)
    except svc.TestRuleError as e:
        raise HTTPException(status_code=422, detail=e.message)
    for existing in list(t.readings):
        db.delete(existing)
    db.flush()
    for r in ev["rows"]:
        db.add(models.IpqcPinholeTestReading(test_id=t.id, **r))
    detail = f"{payload.save_mode.title()} save, {len(ev['rows'])} reading(s), {ev['fail_count']} failed"
    _save_common(db, "pinhole", t, payload, current_user, ev, detail)
    db.commit()
    db.refresh(t)
    return _serialize(db, "pinhole", t)


@router.delete("/{kind}-tests/{test_id}", status_code=204)
def delete_test(
    kind: str, test_id: uuid.UUID, db: Session = Depends(get_db),
    _f=Depends(_falcon_only), _perm=Depends(require("delete")),
):
    t = _load(db, kind, test_id)
    paths = [a.storage_path for a in t.attachments]
    db.delete(t)
    db.commit()
    storage = get_storage_adapter()
    for p in paths:
        try:
            storage.delete(p)
        except Exception:
            pass  # an orphaned file is harmless
    return None


# ---------------------------------------------------------------------------
# attachments
# ---------------------------------------------------------------------------

@router.post("/{kind}-tests/{test_id}/attachments", response_model=schemas.IpqcAttachmentOut, status_code=201)
async def upload_test_attachment(
    kind: str, test_id: uuid.UUID,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user: AuthenticatedUser = Depends(get_current_user),
    _f=Depends(_falcon_only),
    _perm=Depends(require("fill_section")),
):
    cfg = _kind(kind)
    t = _load(db, kind, test_id, lock=True)
    content = await file.read(att_svc.MAX_BYTES + 1)
    try:
        info = att_svc.validate_upload(file.filename, content)
    except att_svc.AttachmentError as e:
        raise HTTPException(status_code=e.status_code, detail=e.message)
    fk = cfg["fk"]
    count = db.query(models.IpqcAttachment).filter(getattr(models.IpqcAttachment, fk) == t.id).count()
    if count >= att_svc.MAX_FILES_PER_RECORD:
        raise HTTPException(status_code=422, detail=f"A record can have at most {att_svc.MAX_FILES_PER_RECORD} attachments.")
    dup = (
        db.query(models.IpqcAttachment)
        .filter(getattr(models.IpqcAttachment, fk) == t.id, models.IpqcAttachment.content_sha256 == info["sha256"]).first()
    )
    if dup:
        raise HTTPException(status_code=409, detail=f"This file is already attached ({dup.filename}).")
    storage = get_storage_adapter()
    path = att_svc.storage_path_for(kind, t.id, info["filename"], info["ext"])
    stored = storage.save(path, content, info["content_type"])
    row = models.IpqcAttachment(
        **{fk: t.id}, filename=info["filename"], content_type=info["content_type"], size_bytes=info["size_bytes"],
        content_sha256=info["sha256"], storage_path=stored.storage_path, public_url=stored.public_url,
        uploaded_by=uuid.UUID(current_user.user_id),
    )
    db.add(row)
    _event(db, kind, t, "attachment_added", current_user.user_id, info["filename"])
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        try:
            storage.delete(stored.storage_path)
        except Exception:
            pass
        raise HTTPException(status_code=409, detail="This file is already attached.")
    db.refresh(row)
    return schemas.IpqcAttachmentOut(
        id=row.id, filename=row.filename, content_type=row.content_type, size_bytes=row.size_bytes,
        public_url=row.public_url, uploaded_by_name=_names(db, [row.uploaded_by]).get(row.uploaded_by), created_at=row.created_at,
    )


@router.delete("/{kind}-tests/{test_id}/attachments/{attachment_id}", status_code=204)
def delete_test_attachment(
    kind: str, test_id: uuid.UUID, attachment_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: AuthenticatedUser = Depends(get_current_user),
    _f=Depends(_falcon_only),
    _perm=Depends(require("fill_section")),
):
    cfg = _kind(kind)
    t = _load(db, kind, test_id, lock=True)
    row = (
        db.query(models.IpqcAttachment)
        .filter(models.IpqcAttachment.id == attachment_id, getattr(models.IpqcAttachment, cfg["fk"]) == t.id).first()
    )
    if not row:
        raise HTTPException(status_code=404, detail="Attachment not found.")
    path, name = row.storage_path, row.filename
    db.delete(row)
    _event(db, kind, t, "attachment_removed", current_user.user_id, name)
    db.commit()
    try:
        get_storage_adapter().delete(path)
    except Exception:
        pass
    return None
