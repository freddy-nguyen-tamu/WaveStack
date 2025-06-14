import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const sources = JSON.parse(readFileSync(resolve(here, "coverage-sources.json"), "utf-8"));

function summarize(source) {
  const reportPath = resolve(here, source.path);
  if (!existsSync(reportPath)) {
    return { ...source, status: "Missing", reportPath };
  }

  if (reportPath.endsWith(".json")) {
    const report = JSON.parse(readFileSync(reportPath, "utf-8"));
    const total = report.total ?? report;
    const lines = total.lines?.pct ?? "available";
    return { ...source, status: `Ready (${lines}% lines)`, reportPath };
  }

  return { ...source, status: "Ready", reportPath };
}

const rows = sources.map(summarize).map((source) => `            <tr>
              <td>${source.name}</td>
              <td>${source.tool}</td>
              <td>${source.status}</td>
              <td>${source.reportPath}</td>
            </tr>`).join("\n");

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>WaveStack Coverage Dashboard</title>
  </head>
  <body>
    <main>
      <h1>WaveStack Coverage Dashboard</h1>
      <p>Combined coverage status for Vitest, Jest, Pytest, and xUnit.</p>
      <section aria-label="Coverage reports">
        <table>
          <thead>
            <tr>
              <th>Service</th>
              <th>Tool</th>
              <th>Status</th>
              <th>Report</th>
            </tr>
          </thead>
          <tbody>
${rows}
          </tbody>
        </table>
      </section>
    </main>
  </body>
</html>
`;

writeFileSync(resolve(here, "index.html"), html);
console.log("Coverage dashboard rendered.");
