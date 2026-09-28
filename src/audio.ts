export const SAMPLE_RATE = 16_000;

export function concatPcm(chunks: Int16Array[]): Int16Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Int16Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

export function pcmDurationMs(pcm: Int16Array, sampleRate = SAMPLE_RATE): number {
  return (pcm.length / sampleRate) * 1000;
}

/** Little-endian bytes of the PCM samples (the platform is little-endian on x86/ARM). */
export function pcmBytes(pcm: Int16Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(pcm.buffer as ArrayBuffer, pcm.byteOffset, pcm.byteLength);
}

/** Wrap mono 16-bit PCM in a WAV container. */
export function encodeWav(pcm: Int16Array, sampleRate = SAMPLE_RATE): Buffer {
  const dataSize = pcm.byteLength;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, Buffer.from(pcmBytes(pcm))]);
}

/** RMS level (dBFS) of the loudest window. Used to skip recordings with no speech at all. */
export function loudestWindowDb(pcm: Int16Array, windowMs = 100, sampleRate = SAMPLE_RATE): number {
  const windowSize = Math.max(1, Math.round((sampleRate * windowMs) / 1000));
  let loudest = 0;
  for (let start = 0; start < pcm.length; start += windowSize) {
    const end = Math.min(pcm.length, start + windowSize);
    let sumSquares = 0;
    for (let i = start; i < end; i++) {
      const s = (pcm[i] ?? 0) / 32768;
      sumSquares += s * s;
    }
    loudest = Math.max(loudest, Math.sqrt(sumSquares / (end - start)));
  }
  return loudest > 0 ? 20 * Math.log10(loudest) : -Infinity;
}
