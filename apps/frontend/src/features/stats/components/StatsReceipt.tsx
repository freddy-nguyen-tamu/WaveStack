import { formatSeconds } from "../../../song-format";

type ReceiptEntry = {
  label: string;
  subtitle: string;
  playCount: number;
  totalDurationSeconds: number;
};

type StatsReceiptProps = {
  title: string;
  periodLabel: string;
  entries: ReceiptEntry[];
  mode: "normal" | "brat";
  length: 10 | 50;
};

export function StatsReceipt({ title, periodLabel, entries, mode, length }: StatsReceiptProps) {
  const shown = entries.slice(0, length);

  return (
    <section className={mode === "brat" ? "stats-receipt stats-receipt--brat" : "stats-receipt"}>
      <div className="stats-receipt__paper">
        <h3>WAVESTACKIFY</h3>
        <p>{periodLabel.toUpperCase()}</p>
        <p>ORDER #0001 FOR {title.toUpperCase()}</p>
        <p>{new Date().toLocaleDateString()}</p>

        <div className="stats-receipt__rule" />

        <div className="stats-receipt__header">
          <span>QTY</span>
          <span>ITEM</span>
          <span>AMT</span>
        </div>

        <ol>
          {shown.map((entry, index) => (
            <li key={`${entry.label}-${index}`}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <strong>
                {entry.label}
                {entry.subtitle ? ` - ${entry.subtitle}` : ""}
              </strong>
              <span>{formatSeconds(entry.totalDurationSeconds)}</span>
            </li>
          ))}
        </ol>

        <div className="stats-receipt__rule" />

        <p>{shown.length} ITEM(S)</p>
        <p>THANK YOU FOR LISTENING</p>
      </div>
    </section>
  );
}
