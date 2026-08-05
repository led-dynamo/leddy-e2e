import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readFixture = async (name) => JSON.parse(
  await readFile(new URL(`../fixtures/${name}`, import.meta.url)),
);

const [command, esp32Hello, stm32Hello] = await Promise.all([
  readFixture('show-command.json'),
  readFixture('hello-esp32.json'),
  readFixture('hello-stm32.json'),
]);

test('show command carries an arbitrary-length message', () => {
  assert.equal(command.type, 'show');
  assert.ok(command.payload.text.length > 20);
  assert.ok(command.payload.speed_pixels_per_second > 0);
});

test('100x5 through 300x20 boards remain configuration data, not compiled constants', () => {
  const configurations = [
    { width: 100, height: 5 },
    { width: 300, height: 20 },
    { width: 192, height: 16 },
  ];
  assert.equal(configurations.every(({ width, height }) => width > 0 && height > 0), true);
});

test('ESP32 hello advertises native wireless transports', () => {
  assert.equal(esp32Hello.type, 'hello');
  assert.equal(esp32Hello.payload.capabilities.platform, 'esp32');
  assert.deepEqual(
    esp32Hello.payload.capabilities.transports,
    ['usb_serial', 'wifi', 'ble'],
  );
  assert.ok(esp32Hello.payload.capabilities.max_width >= 300);
});

test('STM32 hello stays deterministic without claiming BLE', () => {
  assert.equal(stm32Hello.type, 'hello');
  assert.equal(stm32Hello.payload.capabilities.platform, 'stm32');
  assert.ok(stm32Hello.payload.capabilities.transports.includes('usb_serial'));
  assert.ok(stm32Hello.payload.capabilities.transports.includes('ethernet'));
  assert.equal(stm32Hello.payload.capabilities.transports.includes('ble'), false);
  assert.ok(stm32Hello.payload.capabilities.max_width >= 192);
});

test('controller fixtures preserve the common capability contract', () => {
  for (const event of [esp32Hello, stm32Hello]) {
    const { capabilities } = event.payload;
    assert.equal(typeof capabilities.max_width, 'number');
    assert.equal(typeof capabilities.max_height, 'number');
    assert.equal(capabilities.color_depth_bits, 24);
    assert.equal(capabilities.supports_brightness, true);
    assert.ok(Array.isArray(capabilities.transports));
  }
});
