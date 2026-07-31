'use strict';

// Pure-function tests for the live-transcription audio helpers.
// Run with: npm run test:unit  (node --test)

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SAMPLE_RATE,
  BYTES_PER_SAMPLE,
  encodeWav,
  createWindowCutter,
} = require('../../src/main/liveAudio');

/** A zeroed PCM buffer covering `ms` milliseconds at 16 kHz mono 16-bit. */
function bufMs(ms) {
  return Buffer.alloc((SAMPLE_RATE * BYTES_PER_SAMPLE * ms) / 1000);
}

test('encodeWav writes a correct 44-byte header', () => {
  const pcm = Buffer.from([0x01, 0x00, 0x02, 0x00]); // two samples
  const wav = encodeWav(pcm);

  assert.equal(wav.length, 44 + 4);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.readUInt32LE(4), 36 + 4); // RIFF size
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.toString('ascii', 12, 16), 'fmt ');
  assert.equal(wav.readUInt32LE(16), 16); // fmt chunk size
  assert.equal(wav.readUInt16LE(20), 1); // PCM
  assert.equal(wav.readUInt16LE(22), 1); // mono
  assert.equal(wav.readUInt32LE(24), 16000); // sample rate
  assert.equal(wav.readUInt32LE(28), 32000); // byte rate
  assert.equal(wav.readUInt16LE(32), 2); // block align
  assert.equal(wav.readUInt16LE(34), 16); // bits per sample
  assert.equal(wav.toString('ascii', 36, 40), 'data');
  assert.equal(wav.readUInt32LE(40), 4); // data length
  assert.deepEqual([...wav.subarray(44)], [...pcm]); // payload untouched
});

test('cutter cuts at a pause once enough audio accumulated', () => {
  const cutter = createWindowCutter(); // 8 s + 600 ms silence, hard 15 s
  const SPEECH = 0.1;
  const SILENCE = 0.001;

  // 8 s of speech in 500 ms chunks — never cuts mid-speech.
  for (let i = 0; i < 16; i += 1) {
    assert.deepEqual(cutter.feed(bufMs(500), SPEECH), []);
  }
  // 500 ms silence: trailing silence (500) < 600 — still no cut.
  assert.deepEqual(cutter.feed(bufMs(500), SILENCE), []);
  // Another 500 ms silence: >= 8 s total AND >= 600 ms trailing silence → cut.
  const wins = cutter.feed(bufMs(500), SILENCE);
  assert.equal(wins.length, 1);
  assert.equal(Math.round(wins[0].ms), 9000);
  assert.equal(wins[0].buf.length, bufMs(9000).length);
  assert.equal(wins[0].peakRms, SPEECH);
  assert.equal(cutter.pendingMs(), 0);
});

test('cutter hard-cuts at 15 s of continuous speech', () => {
  const cutter = createWindowCutter();
  const SPEECH = 0.2;
  let wins = [];
  let fed = 0;
  while (wins.length === 0) {
    wins = cutter.feed(bufMs(500), SPEECH);
    fed += 500;
    assert.ok(fed <= 15000, 'must cut by 15 s');
  }
  assert.equal(fed, 15000);
  assert.equal(Math.round(wins[0].ms), 15000);
});

test('flush finalizes the pending tail and empties the cutter', () => {
  const cutter = createWindowCutter();
  cutter.feed(bufMs(1000), 0.1);
  cutter.feed(bufMs(500), 0.1);
  const win = cutter.flush();
  assert.equal(Math.round(win.ms), 1500);
  assert.equal(win.buf.length, bufMs(1500).length);
  assert.equal(cutter.flush(), null); // nothing left
  assert.equal(cutter.pendingMs(), 0);
});

test('an all-silence window reports a peakRms below the VAD threshold', () => {
  const cutter = createWindowCutter({ hardCutMs: 2000 });
  let wins = [];
  while (wins.length === 0) wins = cutter.feed(bufMs(500), 0.001);
  assert.ok(wins[0].peakRms < 0.012); // liveTranscriber drops these windows
});
