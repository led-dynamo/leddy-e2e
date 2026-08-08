# leddy-e2e

Cross-repository validation for the full Leddy path: browser or CLI submission,
API acceptance, WebSocket delivery, device simulation, scrolling behavior, and
GitOps deployment smoke tests.

The browser matrix is organized under `tests/browser/{playwright,puppeteer,selenium}`.
The protocol tests use Node's built-in test runner so the orchestration layer
remains dependency-free.

## Software-only vertical slice

`virtual-device/` is a Rust device fixture built from the same
`leddy-interfaces` and `leddy-lib` packages used by production device agents.
It connects to the real API WebSocket, renders sampled frames with the canonical
renderer, emits hello/ack/telemetry events, and writes one JSON observation per
display command for the system test to assert.

`tests/system/virtual-device.test.mjs` exercises the live API server and proves:

- arbitrary messages wider than a 300×20 board render and reach the device;
- row/device frame sizes come from the canonical renderer;
- acknowledgements and telemetry update API device state;
- a disconnected device receives the latest desired state on reconnect;
- replay does not duplicate an active command ahead of a subsequent clear;
- clear itself is replayable after reconnect;
- 300×20 and 100×5 board extremes are exercised;
- left/right scrolling and forever/once/count repeat modes travel through the full path.

GitHub Actions checks out the current `leddy-api-server.rs` `main`, builds both
Rust binaries, starts the API on localhost, and runs the protocol and system
suite against that real process.

```sh
npm test
```
