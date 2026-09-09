import React from "react";
import ReactDOM from "react-dom/client";
import { ApolloProvider } from "@apollo/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { apolloClient, restoreApolloCache } from "./api";
import "./styles.css";

async function bootstrap() {
  // Discourage ordinary image copying without interfering with lyric selection.
  for (const eventName of ["dragstart", "contextmenu", "selectstart"] as const) {
    document.addEventListener(eventName, event => {
      if (event.target instanceof Element && event.target.closest("img, .song-artwork")) {
        event.preventDefault();
      }
    });
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
