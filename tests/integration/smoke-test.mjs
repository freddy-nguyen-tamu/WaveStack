const shouldRun = process.env.RUN_INTEGRATION === "1";

if (!shouldRun) {
  console.log("Integration smoke test skipped. Set RUN_INTEGRATION=1 when WaveStack services are running.");
  process.exit(0);
}

const graphqlUrl = process.env.GRAPHQL_URL ?? "http://localhost:3000/graphql";
const audioUrl = process.env.AUDIO_SERVICE_URL ?? "http://localhost:8000/health";
const analyticsUrl = process.env.ANALYTICS_SERVICE_URL ?? "http://localhost:8080/health";

async function assertOk(name, request) {
  const response = await request();
  if (!response.ok) {
    throw new Error(`${name} failed with ${response.status}`);
  }
  console.log(`${name} ok`);
}

await assertOk("GraphQL API", () =>
  fetch(graphqlUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: "{ songs { id title artistName } }" })
  })
);

await assertOk("Audio AI service", () => fetch(audioUrl));
await assertOk("Analytics service", () => fetch(analyticsUrl));

console.log("WaveStack integration smoke test passed.");
