import type { RefObject } from "react";

type PaginationBarProps = {
  currentPage: number;
  pageCount: number;
  onPageChange: (page: number) => void;
  label?: string;
  scrollTargetRef?: RefObject<HTMLElement | null>;
};

export function PaginationBar({
  currentPage,
  pageCount,
  onPageChange,
  label = "Pagination",
  scrollTargetRef
}: PaginationBarProps) {
  if (pageCount <= 1) {
    return null;
  }

  const pages = Array.from({ length: pageCount }, (_, index) => index + 1);

  function changePage(page: number) {
    const nextPage = Math.min(pageCount, Math.max(1, page));

    if (nextPage === currentPage) {
      return;
    }

    onPageChange(nextPage);

    // A pagination click replaces the visible result page. Most routes should
    // return to the route top, but embedded paginated sections can provide their
    // own start element so pagination does not throw the user out of that section.
    window.requestAnimationFrame(() => {
      const scrollTarget = scrollTargetRef?.current;

      if (scrollTarget) {
        scrollTarget.scrollIntoView({ block: "start", behavior: "auto" });
        return;
      }

      window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    });
  }

  return (
    <nav className="pagination-bar" aria-label={label}>
      <button
        type="button"
        className="pagination-bar__edge"
        onClick={() => changePage(currentPage - 1)}
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
            onClick={() => changePage(page)}
          >
            {page}
          </button>
        ))}
      </div>

      <button
        type="button"
        className="pagination-bar__edge"
        onClick={() => changePage(currentPage + 1)}
        disabled={currentPage === pageCount}
      >
        Next
      </button>
    </nav>
  );
}
