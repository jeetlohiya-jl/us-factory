"use client";
import type { InspectionDetail } from "@/lib/types";
import VehicleInspectionDetailContent from "./VehicleInspectionDetailContent";
import HoldReleaseSection from "@/components/HoldReleaseSection";

export default function RecordDetail({ detail, onClose, onEdit, canEdit }: {
  detail: InspectionDetail; onClose: () => void; onEdit: () => void; canEdit: boolean;
}) {
  return (
    <>
      <div className="panel-overlay open" onClick={onClose} />
      <div className="side-panel open">
        <div className="sp-head">
          <div>
            <h2>Vehicle Inspection Record</h2>
            <div className="sub">Shipment {detail.shipment_number} · <span className={`badge ${detail.status}`}>{detail.status}</span></div>
          </div>
          <button className="sp-close" onClick={onClose}>×</button>
        </div>
        <div className="sp-body">
          {detail.status === "hold" && (
            <HoldReleaseSection module="inward_vehicle_inspection" recordId={detail.id} canFill={canEdit} />
          )}
          <VehicleInspectionDetailContent detail={detail} />
        </div>
        <div className="sp-foot">
          <button className="btn btn-ghost" onClick={onClose}>Close</button>
          <div className="sp-foot-right">
            {canEdit && <button className="btn btn-primary" onClick={onEdit}>Edit</button>}
          </div>
        </div>
      </div>
    </>
  );
}
