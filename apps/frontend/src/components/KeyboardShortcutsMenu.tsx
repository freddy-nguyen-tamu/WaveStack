import { ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export function KeyboardShortcutsMenu() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    function closeOnOutsidePointer(event: PointerEvent) {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) {
        setOpen(false);
      }
    }

    document.addEventListener("pointerdown", closeOnOutsidePointer, true);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer, true);
  }, [open]);

  return (
    <div ref={rootRef} className={open ? "keyboard-shortcuts keyboard-shortcuts--open" : "keyboard-shortcuts"}>
      <button
        type="button"
        className="keyboard-shortcuts__toggle"
        aria-label={open ? "Hide keyboard shortcuts" : "Show keyboard shortcuts"}
        aria-expanded={open}
        aria-controls="wavestack-keyboard-shortcuts"
        title="Keyboard shortcuts"
        onClick={() => setOpen(current => !current)}
      >
        <ChevronDown aria-hidden="true" />
      </button>

      {open ? (
        <div
          id="wavestack-keyboard-shortcuts"
          className="keyboard-shortcuts__bar"
          role="region"
          aria-label="Keyboard shortcuts"
        >
          <span><kbd>Space</kbd> Play/Pause</span>
          <span><kbd>X</kbd> + <kbd>→</kbd> Next</span>
          <span><kbd>Z</kbd> + <kbd>←</kbd> Back/restart</span>
          <span><kbd>Ctrl/⌘</kbd> + <kbd>F</kbd> Find lyrics</span>
          <span><kbd>↑/↓</kbd> Lyric matches</span>
          <span><kbd>Esc</kbd> Close</span>
        </div>
      ) : null}
    </div>
  );
}
