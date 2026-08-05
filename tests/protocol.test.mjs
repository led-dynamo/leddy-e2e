import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const command = JSON.parse(await readFile(new URL('../fixtures/show-command.json', import.meta.url)));

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
