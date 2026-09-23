import type { GoodsReceiptStatus } from "@/lib/types";

const CLS: Record<GoodsReceiptStatus, string> = { draft: "draft", pending: "pending", partial: "partial", received: "approved" };
const LABEL: Record<GoodsReceiptStatus, string> = { draft: "Draft", pending: "Pending", partial: "Partially Received", received: "Received" };

export function GoodsReceiptStatusBadge({ status }: { status: GoodsReceiptStatus }) {
  return <span className={`badge ${CLS[status] || "pending"}`}>{LABEL[status] || status}</span>;
}
