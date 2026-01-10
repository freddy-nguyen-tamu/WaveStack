type PieEntry = {
  label: string;
  value: number;
};

type StatsPieChartProps = {
  title: string;
  entries: PieEntry[];
};

const palette = [
  "#60a5fa",
  "#a78bfa",
  "#34d399",
  "#fbbf24",
  "#fb7185",
  "#22d3ee",
  "#c084fc",
  "#f97316"
];

export function StatsPieChart({ title, entries }: StatsPieChartProps) {
  const topEntries = entries
    .filter((entry) => entry.value > 0)
    .slice(0, 8);

  const total = topEntries.reduce((sum, entry) => sum + entry.value, 0);

  if (!topEntries.length || total <= 0) {
    return (
      <section className="stats-pie-card">
        <h3>{title}</h3>
        <p>No chart data yet.</p>
      </section>
    );
  }

  let cumulative = 0;

  const gradient = topEntries
    .map((entry, index) => {
      const start = (cumulative / total) * 100;
      cumulative += entry.value;
      const end = (cumulative / total) * 100;
      return `${palette[index % palette.length]} ${start}% ${end}%`;
    })
    .join(", ");

  return (
    <section className="stats-pie-card">
      <h3>{title}</h3>

      <div className="stats-pie-card__body">
        <div
          className="stats-pie-card__chart"
          style={{ background: `conic-gradient(${gradient})` }}
          aria-label={title}
        >
          <span />
        </div>

        <ol className="stats-pie-card__legend">
          {topEntries.map((entry, index) => (
            <li key={entry.label}>
              <span style={{ background: palette[index % palette.length] }} />
              <strong>{entry.label}</strong>
              <small>{entry.value} play(s)</small>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
