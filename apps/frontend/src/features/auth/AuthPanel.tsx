import { useMutation } from "@apollo/client";
import { LogIn, UserPlus, LogOut } from "lucide-react";
import { useState } from "react";
import { LOGIN_MUTATION, REGISTER_MUTATION } from "../../api";

type AuthUser = {
  id: string;
  email: string;
  displayName: string;
};

type AuthPanelProps = {
  user: AuthUser | null;
  onAuthChange: (user: AuthUser | null, token: string | null) => void;
};

export function AuthPanel({ user, onAuthChange }: AuthPanelProps) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState("");

  const [loginMutation, loginState] = useMutation(LOGIN_MUTATION);
  const [registerMutation, registerState] = useMutation(REGISTER_MUTATION);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError("");

    if (!email.trim() || !password.trim()) {
      setError("Email and password are required.");
      return;
    }

    if (mode === "register" && !displayName.trim()) {
      setError("Display name is required.");
      return;
    }

    try {
      const mutation = mode === "login" ? loginMutation : registerMutation;
      const variables = mode === "login"
        ? { email: email.trim(), password }
        : { email: email.trim(), displayName: displayName.trim(), password };

      const result = await mutation({ variables });

      const payload = mode === "login"
        ? result.data?.login
        : result.data?.register;

      if (!payload) {
        setError("Authentication failed. Check your credentials.");
        return;
      }

      const { token, user: authUser } = payload;
      window.localStorage.setItem("wavestack:auth-token", token);
      window.localStorage.setItem("wavestack:auth-user", JSON.stringify(authUser));
      onAuthChange(authUser, token);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Authentication failed.";
      setError(message.replace("GraphQL error: ", ""));
    }
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
          <strong>{user.displayName}</strong>
          <small>{user.email}</small>
        </span>
        <button type="button" onClick={handleLogout} aria-label="Log out">
          <LogOut aria-hidden="true" /> Log out
        </button>
      </section>
    );
  }

  const isLoading = loginState.loading || registerState.loading;

  return (
    <section className="auth-panel" aria-label="Authentication">
      <form className="auth-panel__form" onSubmit={handleSubmit}>
        <div className="auth-panel__tabs">
          <button
            type="button"
            className={mode === "login" ? "auth-panel__tab--active" : ""}
            onClick={() => setMode("login")}
            disabled={isLoading}
          >
            <LogIn aria-hidden="true" /> Log in
          </button>
          <button
            type="button"
            className={mode === "register" ? "auth-panel__tab--active" : ""}
            onClick={() => setMode("register")}
            disabled={isLoading}
          >
            <UserPlus aria-hidden="true" /> Register
          </button>
        </div>

        {mode === "register" && (
          <label>
            Display name
            <input
              type="text"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder="Your name"
              disabled={isLoading}
              required
            />
          </label>
        )}

        <label>
          Email
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@example.com"
            disabled={isLoading}
            required
          />
        </label>

        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="Enter password"
            disabled={isLoading}
            required
          />
        </label>

        {error ? <p role="alert" className="auth-panel__error">{error}</p> : null}

        <button type="submit" disabled={isLoading}>
          {isLoading ? "Please wait..." : mode === "login" ? "Log in" : "Register"}
        </button>
      </form>
    </section>
  );
}
