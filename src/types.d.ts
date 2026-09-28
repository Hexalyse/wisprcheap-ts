// @picovoice/pvspeaker-node ships type declarations but its package.json doesn't point to them,
// so declare the small part of the API used here.
declare module '@picovoice/pvspeaker-node' {
  export class PvSpeaker {
    constructor(sampleRate: number, bitsPerSample: number, options?: { bufferSizeSecs?: number; deviceIndex?: number });
    start(): void;
    stop(): void;
    write(pcm: ArrayBuffer): number;
    flush(pcm?: ArrayBuffer): number;
    release(): void;
    static getAvailableDevices(): string[];
  }
}
