import { render, screen } from "@testing-library/react";
import { MockedProvider } from "@apollo/client/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { App } from "./App";

describe("App", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("renders the WaveStack music dashboard", () => {
    render(
      <MockedProvider>
        <App />
      </MockedProvider>
    );

    expect(screen.getByRole("heading", { name: "WaveStack" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /switch to dark mode|switch to normal mode/i })
    ).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Player" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Dashboard" })).toBeInTheDocument();
  });
});
