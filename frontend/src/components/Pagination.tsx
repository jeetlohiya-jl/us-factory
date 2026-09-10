"use client";

type PaginationProps = {
  page: number;
  pageSize: number;
  matchedCount: number;
  onPageChange: (page: number) => void;
  loading?: boolean;
};

// Shared Prev/Next control for every list/history page's server-paginated
// table. Deliberately renders nothing when everything already fits on one
// page -- most tables in this app are small enough that pagination controls
// would just be clutter, so they only show up once a search/filter combo
// actually spans more than one page of results.
export default function Pagination({ page, pageSize, matchedCount, onPageChange, loading }: PaginationProps) {
  if (matchedCount <= pageSize) return null;

  const pageCount = Math.max(1, Math.ceil(matchedCount / pageSize));

  return (
    <div className="pagination">
      <div className="pagination-indicator">Page {page} of {pageCount}</div>
      <div className="pagination-buttons">
        <button
          className="btn btn-secondary"
          disabled={!!loading || page <= 1}
          onClick={() => onPageChange(page - 1)}
        >
          Prev
        </button>
        <button
          className="btn btn-secondary"
          disabled={!!loading || page >= pageCount}
          onClick={() => onPageChange(page + 1)}
        >
          Next
        </button>
      </div>
    </div>
  );
}
