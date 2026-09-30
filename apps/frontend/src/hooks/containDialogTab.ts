// Keep keyboard navigation within an active dialog without changing the
// document scroll container. Also handles focus escaping through a portal menu.
export function containDialogTab(event: KeyboardEvent, dialog: HTMLElement | null) {
  if (event.key !== "Tab" || event.defaultPrevented || !dialog) return;

  const candidates = Array.from(dialog.querySelectorAll<HTMLElement>(
    'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
  )).filter((element) => element.getClientRects().length > 0);
  const first = candidates[0];
  const last = candidates[candidates.length - 1];
  if (!first || !last) {
    event.preventDefault();
    dialog.focus({ preventScroll: true });
    return;
  }

  const active = document.activeElement;
  if (!active || !dialog.contains(active)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  } else if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}
