import { useEffect, useMemo, useState } from "react";
import { useMutation } from "@apollo/client";
import { AlertTriangle, Brain, Sparkles } from "lucide-react";
import { JUDGE_TASTE_MUTATION } from "../../../api";
import fancyWritingStyles from "../../../../fancy_writing.json";

type TasteJudgeResult = {
  ok: boolean;
  verdictTitle: string;
  roast: string;
  summary: string;
  badges: string[];
  tasteScore: number;
  obscurityScore: number;
  chaosScore: number;
  generatedAt: string;
};

type TasteJudgePanelProps = {
  period: string;
};

type FancyWritingStyle = {
  phrase: string;
  example?: string;
};

const loadingLines = [
  "Initializing neural net...",
  "Training on objectively good music...",
  "Checking if the aux cord should be revoked...",
  "Comparing vibes against WaveStack history...",
  "Waiting for the judge to stop being dramatic..."
];

export function TasteJudgePanel({ period }: TasteJudgePanelProps) {
  const [visibleLines, setVisibleLines] = useState<string[]>([]);
  const [uiError, setUiError] = useState("");
  const [selectedWritingStyle, setSelectedWritingStyle] = useState<FancyWritingStyle | null>(null);

  const [judgeTaste, { data, loading, error }] = useMutation<{
    judgeTaste: TasteJudgeResult;
  }>(JUDGE_TASTE_MUTATION, {
    onError: (mutationError) => {
      setUiError(mutationError.message);
    },
    onCompleted: () => {
      setUiError("");
    }
  });

  useEffect(() => {
    if (!loading) {
      return;
    }

    setVisibleLines([]);
    setUiError("");

    let index = 0;

    const interval = window.setInterval(() => {
      setVisibleLines((items) => {
        const line = loadingLines[index] ?? "Still judging...";
        return [...items, line].slice(-5);
      });

      index += 1;

      if (index >= loadingLines.length) {
        window.clearInterval(interval);
      }
    }, 550);

    return () => window.clearInterval(interval);
  }, [loading]);

  const result = data?.judgeTaste;
  const badges = useMemo(() => result?.badges ?? [], [result]);

  async function runJudge() {
    setUiError("");
    const styles = fancyWritingStyles as FancyWritingStyle[];
    const nextStyle = styles[Math.floor(Math.random() * styles.length)] ?? null;
    setSelectedWritingStyle(nextStyle);

    await judgeTaste({
      variables: {
        period,
        writingStylePhrase: nextStyle?.phrase,
        writingStyleExample: nextStyle?.example
      }
    });
  }

  return (
    <section className="taste-judge-card">
      <div>
        <p className="eyebrow">AI taste judge</p>
        <h3>How questionable is your WaveStack taste?</h3>
        <p>
          Let WaveStack turn your listening history into a little character
          study: theatrical, oddly tender, and just merciless enough to feel
          true.
        </p>
      </div>

      <button
        type="button"
        className="taste-judge-card__button"
        onClick={() => void runJudge()}
        disabled={loading}
      >
        <Brain aria-hidden="true" />
        {loading ? "Judging..." : "Judge my taste"}
      </button>

      {loading ? (
        <div className="taste-terminal" aria-live="polite">
          {visibleLines.map((line) => (
            <p key={line}>&gt; {line}</p>
          ))}
          <span className="taste-terminal__cursor" />
        </div>
      ) : null}

      {uiError || error ? (
        <div className="taste-verdict taste-verdict--error" role="alert">
          <div className="taste-verdict__title">
            <AlertTriangle aria-hidden="true" />
            <h4>Judge failed</h4>
          </div>
          <p>{uiError || error?.message}</p>
        </div>
      ) : null}

      {result ? (
        <div className={result.ok ? "taste-verdict" : "taste-verdict taste-verdict--error"}>
          <div className="taste-verdict__title">
            {result.ok ? <Sparkles aria-hidden="true" /> : <AlertTriangle aria-hidden="true" />}
            <div>
              <p className="eyebrow">{result.ok ? "Verdict ready" : "Judge unavailable"}</p>
              <h4>{result.verdictTitle}</h4>
            </div>
          </div>

          <p className="taste-verdict__roast">
            {selectedWritingStyle?.phrase ? (
              <>
                <span className="taste-verdict__style">{selectedWritingStyle.phrase}.</span>
                <br />
              </>
            ) : null}
            {[result.roast, result.summary].filter(Boolean).join(" ")}
          </p>

          <div className="taste-score-grid">
            <ScorePill label="Taste" value={result.tasteScore} />
            <ScorePill label="Obscurity" value={result.obscurityScore} />
            <ScorePill label="Chaos" value={result.chaosScore} />
          </div>

          <div className="taste-badges" aria-label="Taste badges">
            {badges.map((badge) => (
              <span key={badge}>{badge}</span>
            ))}
          </div>

          <p className="taste-verdict__timestamp">
            Judged {new Date(result.generatedAt).toLocaleString()}
          </p>
        </div>
      ) : null}
    </section>
  );
}

function ScorePill({ label, value }: { label: string; value: number }) {
  return (
    <div className="taste-score-pill">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}
