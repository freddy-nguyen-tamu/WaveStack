import React from "react";
import ReactDOM from "react-dom/client";
import { ApolloProvider } from "@apollo/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { apolloClient, restoreApolloCache } from "./api";
import { installPointerFocusPolicy, releasePageFocus } from "./hooks/pointerFocus";
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

  // Lyrics remain intentionally selectable/copyable. Keep any selection that
  // started in the lyrics even when its moving focus endpoint leaves the lyric
  // element while the user drags above/below the modal or outside the browser
  // content area. Requiring both endpoints to stay inside the lyrics caused the
  // selectionchange guard to erase a legitimate in-progress lyric selection.
  // Everywhere else the app remains a keyboard-control surface, so a document
  // caret must never become the hidden owner of Space/Z/X/arrow keystrokes.
  if (isLyricsSelectionTarget(selection.anchorNode)) {
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

function releaseRestoredFocus() {
  window.requestAnimationFrame(() => {
    // Startup/history restoration can revive either a link/button or an old
    // text field without a fresh focus event. Begin every page load with no
    // stale keyboard owner; deliberate editor clicks still focus normally.
    releasePageFocus();
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

  releaseRestoredFocus();
}

void bootstrap();



