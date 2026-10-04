import React from "react";
import ReactDOM from "react-dom/client";
import { ApolloProvider } from "@apollo/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { apolloClient, restoreApolloCache } from "./api";
import { installPointerFocusPolicy } from "./hooks/pointerFocus";
import { installScrollOwnershipPolicy } from "./hooks/wheelHandoff";
import "./styles.css";

const TEXT_ENTRY_INPUT_TYPES = new Set([
  "text",
  "search",
  "email",
  "tel",
  "url",
  "password",
  "number"
]);

function isTextEntryTarget(target: Element | null): boolean {
  if (target instanceof HTMLTextAreaElement) {
    return true;
  }

  if (target instanceof HTMLInputElement) {
    return TEXT_ENTRY_INPUT_TYPES.has(target.type || "text");
  }

  return false;
}

function isAllowedCaretTarget(target: Element | null): boolean {
  return Boolean(
    target &&
    (isTextEntryTarget(target) || target.closest(".song-modal__lyrics-text"))
  );
}

function nodeElement(node: Node | null): Element | null {
  if (node instanceof Element) {
    return node;
  }

  return node?.parentElement ?? null;
}

function isLyricsSelectionTarget(target: Node | null): boolean {
  return Boolean(nodeElement(target)?.closest(".song-modal__lyrics-text"));
}

function clearPageCaretOutsideAllowedZones() {
  if (isAllowedCaretTarget(document.activeElement)) {
    return;
  }

  const selection = document.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return;
  }

  // Lyrics remain intentionally selectable/copyable. Everywhere else the app
  // is a keyboard-control surface, so a document caret must never become the
  // hidden owner of Space/Z/X/arrow keystrokes.
  if (
    isLyricsSelectionTarget(selection.anchorNode) &&
    isLyricsSelectionTarget(selection.focusNode)
  ) {
    return;
  }

  selection.removeAllRanges();
}

function installCaretSelectionPolicy(): () => void {
  const onSelectStart = (event: Event) => {
    // Selection events are allowed to target a Text node, especially inside a
    // content-editable/read-only lyrics surface. Normalize that node back to
    // its containing element before applying the global no-caret policy.
    const target = event.target instanceof Node ? nodeElement(event.target) : null;

    if (isAllowedCaretTarget(target)) {
      return;
    }

    event.preventDefault();
  };

  const onSelectionChange = () => {
    clearPageCaretOutsideAllowedZones();
  };

  const onPointerDown = (event: PointerEvent) => {
    const target = event.target instanceof Node ? nodeElement(event.target) : null;

    if (isAllowedCaretTarget(target)) {
      return;
    }

    clearPageCaretOutsideAllowedZones();
  };

  document.addEventListener("selectstart", onSelectStart, true);
  document.addEventListener("selectionchange", onSelectionChange);
  document.addEventListener("pointerdown", onPointerDown, true);

  return () => {
    document.removeEventListener("selectstart", onSelectStart, true);
    document.removeEventListener("selectionchange", onSelectionChange);
    document.removeEventListener("pointerdown", onPointerDown, true);
  };
}

function releaseRestoredNonEditorFocus() {
  window.requestAnimationFrame(() => {
    const active = document.activeElement;

    // Browsers may restore a previously focused link after reload/navigation.
    // Do not let the WaveStack brand (or any other non-editor) become an
    // automatic keyboard owner. Explicit keyboard Tab focus still works later.
    if (
      active instanceof HTMLElement &&
      active !== document.body &&
      active !== document.documentElement &&
      !isAllowedCaretTarget(active)
    ) {
      active.blur();
    }

    clearPageCaretOutsideAllowedZones();
  });
}

async function bootstrap() {
  // Pointer activation should run an action without leaving buttons/links in a
  // persistent focused state. The shared policy preserves keyboard focus, text
  // editing, native select behavior, range dragging, and dialog focus trapping.
  installPointerFocusPolicy();
  installScrollOwnershipPolicy();
  installCaretSelectionPolicy();

  // Discourage ordinary image copying without interfering with lyric selection.
  for (const eventName of ["dragstart", "contextmenu", "selectstart"] as const) {
    document.addEventListener(eventName, event => {
      if (event.target instanceof Element && event.target.closest("img, .song-artwork")) {
        event.preventDefault();
        event.stopPropagation();
      }
    }, true);
  }
  await restoreApolloCache();

  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <ApolloProvider client={apolloClient}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </ApolloProvider>
    </React.StrictMode>
  );

  releaseRestoredNonEditorFocus();
}

void bootstrap();



