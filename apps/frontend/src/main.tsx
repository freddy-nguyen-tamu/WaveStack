import React from "react";
import ReactDOM from "react-dom/client";
import { ApolloProvider } from "@apollo/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { apolloClient, restoreApolloCache } from "./api";
import "./styles.css";

async function bootstrap() {
  let pointerInteraction = false;
  document.addEventListener("pointerdown", () => { pointerInteraction = true; }, true);
  document.addEventListener("keydown", () => { pointerInteraction = false; }, true);
  document.addEventListener("focusin", event => {
    const target = event.target;
    if (!pointerInteraction || !(target instanceof HTMLElement)) return;
    // Text entry and native dropdowns must remain usable; keyboard focus is untouched.
    if (target.matches("textarea, select, input:not([type=range]):not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]):not([type=reset])") ||
        target.isContentEditable || target.matches("#player-card-seek, #mini-player-seek")) return;
    if (target.matches("button, a[href], input, [tabindex]")) target.blur();
  }, true);
  document.addEventListener("change", event => {
    if (pointerInteraction && event.target instanceof HTMLSelectElement) event.target.blur();
  }, true);
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
}

void bootstrap();
