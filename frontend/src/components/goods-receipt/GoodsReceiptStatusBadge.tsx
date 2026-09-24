import type { GoodsReceiptStatus } from "@/lib/types";
import { statusLabel } from "@/lib/terms";

const CLS: Record<GoodsReceiptStatus, string> = { draft: "draft", pending: "pending", partial: "partial", received: "approved" };
// Status wording matches each container's own "Inwarded" (Received is only
// used for quantities, e.g. Pallets Received).
const LABEL: Record<GoodsReceiptStatus, string> = {
  draft: statusLabel("draft"), pending: statusLabel("pending"), partial: "Partially Inwarded", received: statusLabel("inwarded"),
};

export function GoodsReceiptStatusBadge({ status }: { status: GoodsReceiptStatus }) {
  return <span className={`badge ${CLS[status] || "pending"}`}>{LABEL[status] || status}</span>;
}
