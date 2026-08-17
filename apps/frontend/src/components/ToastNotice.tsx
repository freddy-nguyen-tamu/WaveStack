import { type ReactNode, useEffect } from "react";

const DISMISS_TOASTS_EVENT = "wavestack:dismiss-toasts";

function dismissAllToasts() {
  if (typeof window === "undefined") {
    return;
  }

  window.dispatchEvent(new Event(DISMISS_TOASTS_EVENT));
}

type ToastNoticeProps = {
  children: ReactNode;
  onDismiss: () => void;
};

export function ToastNotice({ children, onDismiss }: ToastNoticeProps) {
  useEffect(() => {
    window.addEventListener(DISMISS_TOASTS_EVENT, onDismiss);

    return () => {
      window.removeEventListener(DISMISS_TOASTS_EVENT, onDismiss);
    };
  }, [onDismiss]);

  return (
    <p
      className="toast-notice toast-notice--status"
      role="status"
      onMouseEnter={dismissAllToasts}
      onPointerEnter={dismissAllToasts}
    >
      {children}
    </p>
  );
}
