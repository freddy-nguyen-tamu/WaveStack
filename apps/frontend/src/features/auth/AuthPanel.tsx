import { LogOut } from "lucide-react";
import { useEffect, useState } from "react";

type AuthUser = {
  id: string;
  email: string;
  displayName: string;
  avatarUrl?: string | null;
};

type AuthPanelProps = {
  user: AuthUser | null;
  onAuthChange: (user: AuthUser | null, token: string | null) => void;
};

const AUTH_URL_ENDPOINT = `${import.meta.env.VITE_GRAPHQL_URL?.replace("/graphql", "") ?? "http://localhost:3000"}/auth/google/url`;

export function AuthPanel({ user, onAuthChange }: AuthPanelProps) {
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const hash = window.location.hash;
    if (!hash.startsWith("#token=") && !hash.startsWith("#error=")) return;

    const params = new URLSearchParams(hash.slice(1));
    const token = params.get("token");
    const error = params.get("error");

    if (error) {
      console.error("OAuth error:", error);
      window.location.hash = "";
      return;
    }

    if (token) {
      window.localStorage.setItem("wavestack:auth-token", token);
      window.location.hash = "";
      window.location.reload();
    }
  }, []);

  function handleGoogleLogin() {
    setLoading(true);
    window.location.href = AUTH_URL_ENDPOINT;
  }

  function handleLogout() {
    window.localStorage.removeItem("wavestack:auth-token");
    window.localStorage.removeItem("wavestack:auth-user");
    onAuthChange(null, null);
  }

  if (user) {
    return (
      <section className="auth-panel" aria-label="User account">
        <span className="auth-panel__user">
          {user.avatarUrl ? (
            <img
              src={user.avatarUrl}
              alt=""
              className="auth-panel__avatar"
              width="32"
              height="32"
            />
          ) : null}
          <strong>{user.displayName}</strong>
          <small>{user.email}</small>
        </span>
        <button type="button" onClick={handleLogout} aria-label="Log out">
          <LogOut aria-hidden="true" /> Log out
        </button>
      </section>
    );
  }

  return (
    <section className="auth-panel" aria-label="Authentication">
      <button
        type="button"
        className="auth-panel__google-btn"
        onClick={handleGoogleLogin}
        disabled={loading}
      >
        {loading ? (
          "Please wait..."
        ) : (
          <>
            <svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true">
              <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
              <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
              <path fill="#FBBC05" d="M10.54 28.59A14.5 14.5 0 0 1 9.5 24c0-1.59.28-3.14.76-4.59l-7.98-6.19A23.99 23.99 0 0 0 0 24c0 3.77.87 7.35 2.56 10.56l7.98-5.97z" />
              <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 5.97C6.51 42.62 14.62 48 24 48z" />
            </svg>
            Continue with Google
          </>
        )}
      </button>
    </section>
  );
}
