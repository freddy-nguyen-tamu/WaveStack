type PaginationBarProps = {
  currentPage: number;
  pageCount: number;
  onPageChange: (page: number) => void;
  label?: string;
};

export function PaginationBar({
  currentPage,
  pageCount,
  onPageChange,
  label = "Pagination"
}: PaginationBarProps) {
  if (pageCount <= 1) {
    return null;
  }

  const pages = Array.from({ length: pageCount }, (_, index) => index + 1);

  return (
    <nav className="pagination-bar" aria-label={label}>
      <button
        type="button"
        className="pagination-bar__edge"
        onClick={() => onPageChange(Math.max(1, currentPage - 1))}
        disabled={currentPage === 1}
      >
        Previous
      </button>

      <div className="pagination-bar__pages" aria-label={`${label} pages`}>
        {pages.map((page) => (
          <button
            key={page}
            type="button"
            className={page === currentPage ? "pagination-bar__page pagination-bar__page--active" : "pagination-bar__page"}
            aria-current={page === currentPage ? "page" : undefined}
            onClick={() => onPageChange(page)}
          >
            {page}
          </button>
        ))}
      </div>

      <button
        type="button"
        className="pagination-bar__edge"
        onClick={() => onPageChange(Math.min(pageCount, currentPage + 1))}
        disabled={currentPage === pageCount}
      >
        Next
      </button>
    </nav>
  );
}
