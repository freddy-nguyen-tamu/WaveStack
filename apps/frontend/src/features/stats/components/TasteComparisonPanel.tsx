import { useQuery } from "@apollo/client";
import { TASTE_COMPARISON_QUERY } from "../../../api";

type StatsEntry = {
  key: string;
  label: string;
  subtitle: string;
  rank: number;
  playCount: number;
};

type TasteComparisonResult = {
  userPlayCount: number;
  libraryUserCount: number;
  obscurityScore: number;
  mainstreamScore: number;
  uniquenessScore: number;
  overlapScore: number;
  rareArtists: StatsEntry[];
  commonArtists: StatsEntry[];
};

type TasteComparisonPanelProps = {
  period: string;
};

export function TasteComparisonPanel({ period }: TasteComparisonPanelProps) {
  const { data, loading } = useQuery<{ tasteComparison: TasteComparisonResult }>(
    TASTE_COMPARISON_QUERY,
    {
      variables: { period },
      fetchPolicy: "cache-and-network"
    }
  );

  const comparison = data?.tasteComparison;

  if (loading && !comparison) {
    return <p className="stats-loading">Loading taste comparison...</p>;
  }

  if (!comparison) {
    return null;
  }

  return (
    <section className="taste-comparison-card">
      <div>
        <p className="eyebrow">Compared with WaveStack listeners</p>
        <h3>Your taste profile</h3>
        <p>
          This compares your artists against the rest of the logged-in WaveStack
          listening history. It gets more meaningful as more users listen.
        </p>
      </div>

      <div className="taste-comparison-bars">
        <ComparisonBar label="Obscurity" value={comparison.obscurityScore} />
        <ComparisonBar label="Mainstream" value={comparison.mainstreamScore} />
        <ComparisonBar label="Uniqueness" value={comparison.uniquenessScore} />
        <ComparisonBar label="Overlap" value={comparison.overlapScore} />
      </div>

      <div className="taste-comparison-lists">
        <div>
          <h4>Rarer in WaveStack</h4>
          <ol>
            {comparison.rareArtists.slice(0, 5).map((entry) => (
              <li key={entry.key}>
                <strong>{entry.label}</strong>
                <span>{entry.subtitle}</span>
              </li>
            ))}
          </ol>
        </div>

        <div>
          <h4>More common in WaveStack</h4>
          <ol>
            {comparison.commonArtists.slice(0, 5).map((entry) => (
              <li key={entry.key}>
                <strong>{entry.label}</strong>
                <span>{entry.subtitle}</span>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}

function ComparisonBar({ label, value }: { label: string; value: number }) {
  return (
    <div className="taste-comparison-bar">
      <div>
        <strong>{label}</strong>
        <span>{value}%</span>
      </div>
      <meter min={0} max={100} value={value} />
    </div>
  );
}
