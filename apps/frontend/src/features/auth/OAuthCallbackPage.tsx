import { useEffect } from "react";
import { useNavigate } from "react-router-dom";

export function OAuthCallbackPage() {
  const navigate = useNavigate();

  useEffect(() => {
    navigate(`/profile${window.location.search}`, { replace: true });
  }, [navigate]);

  return (
    <article aria-label="Completing Google sign in">
      <p className="eyebrow">Google OAuth</p>
      <h2>Signing you in...</h2>
      <p>WaveStack is saving your session and loading your profile.</p>
    </article>
  );
}
