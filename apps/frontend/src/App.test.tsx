import { render, screen } from "@testing-library/react";
import { MockedProvider } from "@apollo/client/testing";
import { describe, expect, it } from "vitest";
import { App } from "./App";

describe("App", () => {
  it("renders the WaveStack music dashboard", () => {
    render(
      <MockedProvider>
        <App />
      </MockedProvider>
    );

    expect(screen.getByRole("heading", { name: "WaveStack" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Player" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Dashboard" })).toBeInTheDocument();
  });
});
