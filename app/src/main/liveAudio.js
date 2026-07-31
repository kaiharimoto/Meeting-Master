'use strict';

// Pure audio helpers for live transcription — no Electron imports, so they
// run under plain `node --test` (app/test/unit/liveAudio.test.js).

const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2;

// Window-cutting defaults (see liveTranscriber.js for the rationale).
const CUT_AT_MS = 8000;
const SILENCE_TO_CUT_MS = 600;
const HARD_CUT_MS = 15000;
const SILENCE_RMS = 0.012;

/** Wrap 16 kHz mono Int16 LE PCM in a minimal 44-byte-header WAV. */
function encodeWav(pcmBuffer) {
  const dataLen = pcmBuffer.length;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataLen, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * BYTES_PER_SAMPLE, 28); // byte rate
  header.writeUInt16LE(BYTES_PER_SAMPLE, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataLen, 40);
  return Buffer.concat([header, pcmBuffer]);
}

/**
 * Stateful window cutter. feed(buf, rms) returns an array of finished
 * windows ({buf, ms, peakRms}); flush() finalizes whatever is pending.
 * Cuts at a natural pause (>= cutAtMs of audio ending in >= silenceToCutMs
 * of silence) or hard-cuts at hardCutMs to bound latency.
 */
function createWindowCutter(opts = {}) {
  const cutAtMs = opts.cutAtMs ?? CUT_AT_MS;
  const silenceToCutMs = opts.silenceToCutMs ?? SILENCE_TO_CUT_MS;
  const hardCutMs = opts.hardCutMs ?? HARD_CUT_MS;
  const silenceRms = opts.silenceRms ?? SILENCE_RMS;

  let chunks = [];
  let ms = 0;
  let trailingSilenceMs = 0;
  let peakRms = 0;

  function cut() {
    const win = { buf: Buffer.concat(chunks), ms, peakRms };
    chunks = [];
    ms = 0;
    trailingSilenceMs = 0;
    peakRms = 0;
    return win;
  }

  return {
    feed(buf, rms) {
      const chunkMs = (buf.length / BYTES_PER_SAMPLE / SAMPLE_RATE) * 1000;
      chunks.push(buf);
      ms += chunkMs;
      peakRms = Math.max(peakRms, Number(rms) || 0);
      trailingSilenceMs = (Number(rms) || 0) < silenceRms ? trailingSilenceMs + chunkMs : 0;
      if (ms >= hardCutMs || (ms >= cutAtMs && trailingSilenceMs >= silenceToCutMs)) {
        return [cut()];
      }
      return [];
    },
    flush() {
      return ms > 0 ? cut() : null;
    },
    pendingMs: () => ms,
  };
}

module.exports = {
  SAMPLE_RATE,
  BYTES_PER_SAMPLE,
  CUT_AT_MS,
  SILENCE_TO_CUT_MS,
  HARD_CUT_MS,
  SILENCE_RMS,
  encodeWav,
  createWindowCutter,
};
