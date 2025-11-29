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
    const searchParams = new URLSearchParams(window.location.search);
    const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));

    const token = searchParams.get("token") ?? hashParams.get("token");
    const error = searchParams.get("error") ?? hashParams.get("error");

    if (error) {
      onError(`Google login failed: ${error}`);
      navigate("/profile", { replace: true });
      return;
    }

    if (!token) {
      onError(`Google login did not return a token. Callback URL was ${window.location.href}`);
      navigate("/profile", { replace: true });
      return;
    }

    window.localStorage.setItem("wavestack:auth-token", token);
    onToken(token);

    void client.clearStore().finally(() => {
      navigate("/profile", { replace: true });
      window.location.reload();
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
