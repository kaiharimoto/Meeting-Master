// AudioWorklet processor: taps the recording bus and emits 16 kHz mono
// Int16 PCM batches (with an RMS level) for live transcription.
//
// Runs on the audio thread — keep it allocation-light. Resampling is
// fractional-step linear interpolation carried across 128-frame blocks, so
// any AudioContext rate (48 k, 44.1 k, …) maps cleanly to 16 kHz. Linear
// interpolation is fully adequate for ASR input.
//
// Each 2048-sample batch (128 ms of audio) is posted as a transferable
// ArrayBuffer: { buf, rms }. The renderer batches a few of these before
// crossing IPC (see recorder.js).

const TARGET_RATE = 16000;
const BATCH_SAMPLES = 2048;

class PcmTapProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // Read position within [prev, ...block] in input-sample units; index 0 is
    // the last sample of the previous block so interpolation never breaks at
    // block boundaries.
    this.pos = 1;
    this.prev = 0;
    this.out = new Int16Array(BATCH_SAMPLES);
    this.outLen = 0;
    this.sumSquares = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0 || !input[0] || input[0].length === 0) {
      return true;
    }
    const n = input[0].length;
    const step = sampleRate / TARGET_RATE; // AudioWorklet global sampleRate

    for (let p = this.pos; p <= n; p += step) {
      const k = Math.floor(p);
      const t = p - k;
      // buffer index k: 0 = prev, 1..n = block samples 0..n-1
      const s0 = k === 0 ? this.prev : this.sampleAt(input, k - 1);
      const s1 = k >= n ? this.sampleAt(input, n - 1) : this.sampleAt(input, k);
      const s = s0 + (s1 - s0) * t;
      this.push(s);
      this.pos = p + step;
    }
    this.pos -= n; // carry the fractional remainder into the next block
    this.prev = this.sampleAt(input, n - 1);
    return true;
  }

  /** Mono mixdown of channel sample i. */
  sampleAt(input, i) {
    if (input.length === 1) return input[0][i];
    let sum = 0;
    for (let c = 0; c < input.length; c += 1) sum += input[c][i];
    return sum / input.length;
  }

  push(sample) {
    const clamped = sample > 1 ? 1 : sample < -1 ? -1 : sample;
    this.out[this.outLen] = (clamped * 32767) | 0;
    this.outLen += 1;
    this.sumSquares += clamped * clamped;
    if (this.outLen >= BATCH_SAMPLES) {
      const rms = Math.sqrt(this.sumSquares / BATCH_SAMPLES);
      this.port.postMessage({ buf: this.out.buffer, rms }, [this.out.buffer]);
      this.out = new Int16Array(BATCH_SAMPLES);
      this.outLen = 0;
      this.sumSquares = 0;
    }
  }
}

registerProcessor('pcm-tap', PcmTapProcessor);
