# Testing And Coverage

WaveStack reserves test coverage lanes for every runtime:

| Runtime | Test tool | Coverage output |
| --- | --- | --- |
| React frontend | Vitest | `apps/frontend/coverage/coverage-summary.json` |
| NestJS GraphQL API | Jest | `services/graphql-api/coverage/coverage-summary.json` |
| Python FastAPI service | Pytest | terminal and XML/JSON reports from pytest-cov |
| C#/.NET service | xUnit | `TestResults` coverage collector output |
| Cross-service checks | Integration tests | `tests/integration` |

The `coverage-dashboard` folder contains a small dashboard scaffold that can combine these reports later.
