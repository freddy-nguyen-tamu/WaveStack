import { render, screen } from "@testing-library/react";
import { MockedProvider } from "@apollo/client/testing";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
import { App } from "./App";

describe("App", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("renders the WaveStack music dashboard", () => {
    render(
      <MemoryRouter>
        <MockedProvider>
          <App />
        </MockedProvider>
      </MemoryRouter>
    );

    expect(screen.getByRole("link", { name: /wavestack home/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /switch to dark mode/i })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Player" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "All songs" })).toBeInTheDocument();
  });
});
