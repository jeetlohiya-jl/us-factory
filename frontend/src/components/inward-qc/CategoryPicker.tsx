"use client";
import { useState } from "react";
import type { QcManualCategory } from "@/lib/types";

const CATEGORY_LABELS: Record<QcManualCategory, string> = {
  pad: "Soaker Pad", polybag: "Polybag", cfb: "CFB", glue: "Glue",
};

/**
 * "+ New Record" step 1 from the prototype: a category picker with EXACTLY
 * the four manual categories. Tray / FG Non-Padded Tray is deliberately
 * never offered here — it is only ever auto-created from an approved
 * Vehicle Inspection (see the Inward QC page's row-click handling).
 */
export default function CategoryPicker({ onNext, onCancel }: { onNext: (category: QcManualCategory) => void; onCancel: () => void }) {
  const [selected, setSelected] = useState<QcManualCategory | null>(null);

  return (
    <>
      <div className="panel-overlay open" onClick={onCancel} />
      <div className="side-panel open">
        <div className="sp-head">
          <div><h2>New Inward QC Record</h2></div>
          <button className="sp-close" onClick={onCancel}>×</button>
        </div>
        <div className="sp-body">
          <div className="section-label" style={{ marginTop: 0 }}>Select Category</div>
          <div className="category-pick">
            {(Object.keys(CATEGORY_LABELS) as QcManualCategory[]).map((cat) => (
              <div
                key={cat}
                className={`cat-card ${selected === cat ? "sel" : ""}`}
                onClick={() => setSelected(cat)}
              >
                <div className="name">{CATEGORY_LABELS[cat]}</div>
              </div>
            ))}
          </div>
        </div>
        <div className="sp-foot">
          <button className="btn btn-ghost" onClick={onCancel}>Cancel</button>
          <div className="sp-foot-right">
            <button className="btn btn-primary" disabled={!selected} onClick={() => selected && onNext(selected)}>Next →</button>
          </div>
        </div>
      </div>
    </>
  );
}
