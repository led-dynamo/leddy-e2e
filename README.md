# leddy-e2e

Cross-repository validation for the full Leddy path: browser or CLI submission,
API acceptance, WebSocket delivery, device simulation, scrolling behavior, and
GitOps deployment smoke tests.

The browser matrix is organized under `tests/browser/{playwright,puppeteer,selenium}`.
The bootstrap test suite uses only Node's built-in test runner so it remains
fast and dependency-free.

```sh
npm test
```
