import { PvRecorder } from '@picovoice/pvrecorder-node';
import { concatPcm } from './audio.ts';

const FRAME_LENGTH = 512; // 32 ms at 16 kHz (PvRecorder always records 16 kHz mono int16)

export function listInputDevices(): string[] {
  return PvRecorder.getAvailableDevices();
}

export function resolveDeviceIndex(device: string | number): number {
  if (typeof device === 'number') return device;
  if (device.trim() === '' || device.toLowerCase() === 'default') return -1;
  const devices = listInputDevices();
  const index = devices.findIndex((d) => d.toLowerCase().includes(device.toLowerCase()));
  if (index === -1) {
    console.warn(`[recorder] No input device matching "${device}", using the default. Available: ${devices.join(' | ')}`);
  }
  return index;
}

export class Recorder {
  #recorder: PvRecorder;
  #chunks: Int16Array[] = [];
  #loop: Promise<void> | null = null;
  #running = false;

  constructor(deviceIndex: number) {
    this.#recorder = new PvRecorder(FRAME_LENGTH, deviceIndex);
  }

  get deviceName(): string {
    return this.#recorder.getSelectedDevice();
  }

  get isRecording(): boolean {
    return this.#running;
  }

  start(): void {
    if (this.#running) return;
    this.#chunks = [];
    this.#recorder.start();
    this.#running = true;
    this.#loop = this.#readLoop();
  }

  async #readLoop(): Promise<void> {
    while (this.#running) {
      try {
        const frame = await this.#recorder.read();
        this.#chunks.push(frame.slice());
      } catch (error) {
        if (this.#running) console.error('[recorder] read failed:', error);
        break;
      }
    }
  }

  /** Stop recording and return everything captured since start(). */
  async stop(): Promise<Int16Array> {
    if (!this.#running) return new Int16Array(0);
    this.#running = false;
    await this.#loop;
    this.#loop = null;
    this.#recorder.stop();
    const pcm = concatPcm(this.#chunks);
    this.#chunks = [];
    return pcm;
  }

  release(): void {
    this.#running = false;
    try {
      this.#recorder.stop();
    } catch {
      // not started
    }
    this.#recorder.release();
  }
}
