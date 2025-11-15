import { useEffect } from "react";
import { useApolloClient } from "@apollo/client";
import { useNavigate } from "react-router-dom";

type OAuthCallbackPageProps = {
  onToken: (token: string) => void;
  onError: (message: string) => void;
};

export function OAuthCallbackPage({ onToken, onError }: OAuthCallbackPageProps) {
  const client = useApolloClient();
  const navigate = useNavigate();

  useEffect(() => {
    const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const token = params.get("token");
    const error = params.get("error");

    if (error) {
      onError(`Google login failed: ${error}`);
      navigate("/profile", { replace: true });
      return;
    }

    if (!token) {
      onError("Google login did not return a token.");
      navigate("/profile", { replace: true });
      return;
    }

    window.localStorage.setItem("wavestack:auth-token", token);
    onToken(token);

    void client.resetStore().finally(() => {
      navigate("/profile", { replace: true });
    });
  }, [client, navigate, onError, onToken]);

  return (
    <article aria-label="Completing Google sign in">
      <p className="eyebrow">Google OAuth</p>
      <h2>Signing you in...</h2>
      <p>WaveStack is saving your session and loading your profile.</p>
    </article>
  );
}
