import { useState } from "react";
import { Link } from "react-router-dom";
import type { AuthUser } from "../../App";

type AuthPanelProps = {
  user: AuthUser | null;
  onLogout: () => void;
};

function apiOrigin(): string {
  const graphqlUrl = import.meta.env.VITE_GRAPHQL_URL ?? "http://localhost:3000/graphql";

  try {
    return new URL(graphqlUrl).origin;
  } catch {
    return "http://localhost:3000";
  }
}

export function AuthPanel({ user, onLogout }: AuthPanelProps) {
  const [isStartingGoogleLogin, setIsStartingGoogleLogin] = useState(false);
  const [error, setError] = useState("");

  async function startGoogleLogin() {
    setIsStartingGoogleLogin(true);
    setError("");

    try {
      const response = await fetch(`${apiOrigin()}/auth/google/url`);

      if (!response.ok) {
        throw new Error(`Google login URL request failed with ${response.status}`);
      }

      const data = (await response.json()) as { url?: string };

      if (!data.url) {
        throw new Error("The API did not return a Google login URL.");
      }

      window.location.href = data.url;
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : "Could not start Google login.");
      setIsStartingGoogleLogin(false);
    }
  }

  if (user) {
    const initials = user.displayName
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part.charAt(0).toUpperCase())
      .join("") || "U";

    return (
      <section className="auth-panel auth-panel--signed-in" aria-label="Account">
        <Link className="auth-panel__profile-link" to="/profile" aria-label={`View profile for ${user.displayName}`}>
          {user.avatarUrl ? (
            <img className="auth-panel__avatar" src={user.avatarUrl} alt="" />
          ) : (
            <span className="auth-panel__avatar auth-panel__avatar--fallback" aria-hidden="true">
              {initials}
            </span>
          )}
          <span>View profile</span>
        </Link>

        <button type="button" onClick={onLogout}>
          Log out
        </button>
      </section>
    );
  }

  return (
    <section className="auth-panel" aria-label="Account">
      <button
        type="button"
        className="auth-panel__google"
        onClick={() => void startGoogleLogin()}
        disabled={isStartingGoogleLogin}
      >
        {isStartingGoogleLogin ? "Opening Google..." : "Continue with Google"}
      </button>

      {error ? <p className="auth-panel__error">{error}</p> : null}
    </section>
  );
}
