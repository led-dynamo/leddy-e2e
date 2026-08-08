import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import test from "node:test";

const API_URL = process.env.LEDDY_API_URL ?? "http://127.0.0.1:18080";
const DEVICE_WS_URL = process.env.LEDDY_DEVICE_WS_URL ?? "ws://127.0.0.1:18080/v1/ws/devices";
const DEVICE_BIN = process.env.LEDDY_VIRTUAL_DEVICE_BIN;
const DEVICE_ID = "virtual-e2e";

function timeout(promise, milliseconds, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), milliseconds);
    }),
  ]);
}

async function jsonRequest(path, options = {}) {
  const response = await fetch(`${API_URL}${path}`, options);
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { response, body };
}

async function post(path, body) {
  return jsonRequest(path, {
    method: "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function waitForDevice(predicate, label, milliseconds = 10_000) {
  const deadline = Date.now() + milliseconds;
  let last = null;
  while (Date.now() < deadline) {
    const { response, body } = await jsonRequest(`/v1/devices/${DEVICE_ID}`);
    if (response.ok) {
      last = body;
      if (predicate(body)) return body;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${label}; last snapshot=${JSON.stringify(last)}`);
}

function startDevice({ maxCommands, width, height }) {
  assert.ok(DEVICE_BIN, "LEDDY_VIRTUAL_DEVICE_BIN must point to the built fixture");
  const child = spawn(DEVICE_BIN, [], {
    env: {
      ...process.env,
      LEDDY_DEVICE_WS_URL: DEVICE_WS_URL,
      LEDDY_DEVICE_ID: DEVICE_ID,
      LEDDY_MATRIX_WIDTH: String(width),
      LEDDY_MATRIX_HEIGHT: String(height),
      LEDDY_VIRTUAL_DEVICE_MAX_COMMANDS: String(maxCommands),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })[Symbol.asyncIterator]();

  return {
    child,
    async next(label) {
      const result = await timeout(lines.next(), 10_000, label);
      if (result.done) {
        throw new Error(`virtual device exited before ${label}; stderr=${stderr}`);
      }
      return JSON.parse(result.value);
    },
    async exited() {
      const [code, signal] = await timeout(once(child, "exit"), 10_000, "virtual device exit");
      assert.equal(signal, null, `virtual device killed by ${signal}; stderr=${stderr}`);
      assert.equal(code, 0, `virtual device exited ${code}; stderr=${stderr}`);
    },
    stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    },
  };
}

function message({ id, text, direction, repeat }) {
  return {
    id,
    text,
    speed_pixels_per_second: 120,
    direction,
    repeat,
    issued_at_unix_ms: Date.now(),
  };
}

function assertRendered(observation, { id, width, height, direction }) {
  assert.equal(observation.type, "show");
  assert.equal(observation.message_id, id);
  assert.equal(observation.width, width);
  assert.equal(observation.height, height);
  assert.equal(observation.frame_pixels, width * height);
  assert.equal(observation.device_pixels, width * height);
  assert.ok(observation.lit_pixels > 0, "sampled canonical renderer frame should light pixels");
  assert.equal(observation.direction, direction);
}

test("API, virtual device, canonical renderer, telemetry, clear, and reconnect form one slice", async (t) => {
  const devices = [];
  t.after(() => devices.forEach((device) => device.stop()));

  const health = await jsonRequest("/health");
  assert.equal(health.response.status, 200);
  assert.deepEqual(health.body, { status: "ok" });

  const longText = "LEDDY SOFTWARE ONLY VERTICAL SLICE ".repeat(20);
  const firstMessage = message({
    id: "e2e-long-left-forever",
    text: longText,
    direction: "left",
    repeat: "forever",
  });

  const first = startDevice({ maxCommands: 1, width: 300, height: 20 });
  devices.push(first);
  await waitForDevice((device) => device.firmware_version === "0.1.0", "initial hello");

  const published = await post("/v1/messages", firstMessage);
  assert.equal(published.response.status, 202);
  assert.equal(published.body.message_id, firstMessage.id);
  assert.equal(published.body.revision, 1);
  assert.equal(published.body.connected_receivers, 1);

  const firstObservation = await first.next("initial show observation");
  assertRendered(firstObservation, {
    id: firstMessage.id,
    width: 300,
    height: 20,
    direction: "left",
  });
  assert.ok(firstObservation.content_width > 300, "arbitrary message should exceed physical width");
  assert.equal(firstObservation.repeat, "forever");
  await first.exited();
  await waitForDevice(
    (device) =>
      device.current_message_id === firstMessage.id && device.last_ack_command_id === firstMessage.id,
    "show acknowledgement and telemetry",
  );

  // Reconnect while Show is desired. The first command must be exactly one replay.
  // If the replay is duplicated from the live queue, it will occupy the second slot
  // and the Clear assertion below fails.
  const second = startDevice({ maxCommands: 2, width: 300, height: 20 });
  devices.push(second);
  const replay = await second.next("replayed show after reconnect");
  assertRendered(replay, {
    id: firstMessage.id,
    width: 300,
    height: 20,
    direction: "left",
  });

  const cleared = await post("/v1/clear");
  assert.equal(cleared.response.status, 202);
  assert.equal(cleared.body.revision, 2);
  assert.equal(cleared.body.connected_receivers, 1);
  const clearObservation = await second.next("clear after replay");
  assert.equal(clearObservation.type, "clear", "a duplicate Show must not displace Clear");
  await second.exited();
  await waitForDevice(
    (device) => device.current_message_id === null && device.last_ack_command_id === "clear",
    "clear acknowledgement and telemetry",
  );

  // A new connection receives the latest Clear desired state.
  const third = startDevice({ maxCommands: 1, width: 300, height: 20 });
  devices.push(third);
  assert.equal((await third.next("replayed clear after reconnect")).type, "clear");
  await third.exited();

  // Exercise the minimum requested fixture and the remaining direction/repeat variants.
  const fourth = startDevice({ maxCommands: 3, width: 100, height: 5 });
  devices.push(fourth);
  assert.equal((await fourth.next("clear on minimum board reconnect")).type, "clear");

  const onceRight = message({
    id: "e2e-right-once",
    text: "RIGHT ONCE",
    direction: "right",
    repeat: "once",
  });
  const onceResponse = await post("/v1/messages", onceRight);
  assert.equal(onceResponse.response.status, 202);
  assert.equal(onceResponse.body.revision, 3);
  const onceObservation = await fourth.next("right once observation");
  assertRendered(onceObservation, {
    id: onceRight.id,
    width: 100,
    height: 5,
    direction: "right",
  });
  assert.equal(onceObservation.repeat, "once");

  const countedLeft = message({
    id: "e2e-left-count-two",
    text: "COUNT TWO",
    direction: "left",
    repeat: { count: 2 },
  });
  const countResponse = await post("/v1/messages", countedLeft);
  assert.equal(countResponse.response.status, 202);
  assert.equal(countResponse.body.revision, 4);
  const countObservation = await fourth.next("left counted observation");
  assertRendered(countObservation, {
    id: countedLeft.id,
    width: 100,
    height: 5,
    direction: "left",
  });
  assert.deepEqual(countObservation.repeat, { count: 2 });
  await fourth.exited();

  await waitForDevice(
    (device) =>
      device.current_message_id === countedLeft.id && device.last_ack_command_id === countedLeft.id,
    "final acknowledgement and telemetry",
  );
});
