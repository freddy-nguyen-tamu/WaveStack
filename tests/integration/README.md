# Integration Tests

The integration smoke test is dependency-light on purpose. It uses built-in `fetch` so it can run after the Docker Compose stack or a Kubernetes port-forward is available.

Set `RUN_INTEGRATION=1` when the platform is running:

```txt
RUN_INTEGRATION=1 node tests/integration/smoke-test.mjs
```

Without that flag, the test exits successfully and explains that live checks were skipped.
