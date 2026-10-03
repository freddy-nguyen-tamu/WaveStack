
import React from "react";
import ReactDOM from "react-dom/client";
import { ApolloProvider } from "@apollo/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { apolloClient, restoreApolloCache } from "./api";
import { installPointerFocusPolicy } from "./hooks/pointerFocus";
import { installScrollOwnershipPolicy } from "./hooks/wheelHandoff";
import "./styles.css";

function isTextEntryTarget(target: Element | null): boolean {
  return target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable);
}

function primeAppKeyboardFocus() {
  const root = document.getElementById("root");

  if (!(root instanceof HTMLElement) || isTextEntryTarget(document.activeElement)) {
    return;
  }

  const active = document.activeElement;
  const pageAlreadyOwnsMeaningfulFocus =
    active instanceof HTMLElement &&
    active !== document.body &&
    active !== document.documentElement &&
    active !== root;

  if (pageAlreadyOwnsMeaningfulFocus) {
    return;
  }

  // A browser refresh can leave keyboard focus on browser chrome even though
  // the WaveStack tab is visible. Ask the top-level browsing context for focus
  // and give the non-tabbable app root a programmatic focus target so global
  // shortcuts are live immediately without requiring a throwaway page click.
  window.focus();
  root.tabIndex = -1;
  root.focus({ preventScroll: true });
}

function scheduleAppKeyboardFocus() {
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(primeAppKeyboardFocus);
  });
}

async function bootstrap() {
  // Pointer activation should run an action without leaving buttons/links in a
  // persistent focused state. The shared policy preserves keyboard focus, text
  // editing, native select behavior, range dragging, and dialog focus trapping.
  installPointerFocusPolicy();
  installScrollOwnershipPolicy();

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

  scheduleAppKeyboardFocus();
  window.addEventListener("pageshow", scheduleAppKeyboardFocus);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      scheduleAppKeyboardFocus();
    }
  });
}

void bootstrap();
