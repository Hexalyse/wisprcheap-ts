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

/**
 * Opens the microphone for each recording (~20 ms) and closes it afterwards, so a headset that was
 * plugged in or a new default device is picked up without restarting. It also keeps the mic
 * (and the Windows "microphone in use" indicator) off between dictations.
 */
export class Recorder {
  #device: string | number;
  #recorder: PvRecorder | null = null;
  #chunks: Int16Array[] = [];
  #loop: Promise<void> | null = null;
  #running = false;
  #lastDeviceName: string | null = null;

  constructor(device: string | number) {
    this.#device = device;
  }

  /** Change the configured device (config reload). Applies from the next recording. */
  setDevice(device: string | number): void {
    this.#device = device;
  }

  /** Name of the device a recording would use right now. */
  currentDeviceName(): string {
    const recorder = new PvRecorder(FRAME_LENGTH, resolveDeviceIndex(this.#device));
    try {
      return recorder.getSelectedDevice();
    } finally {
      recorder.release();
    }
  }

  get isRecording(): boolean {
    return this.#running;
  }

  start(): void {
    if (this.#running) return;
    const recorder = new PvRecorder(FRAME_LENGTH, resolveDeviceIndex(this.#device));
    try {
      recorder.start();
    } catch (error) {
      recorder.release();
      throw error;
    }
    const name = recorder.getSelectedDevice();
    if (this.#lastDeviceName !== null && name !== this.#lastDeviceName) console.log(`[recorder] Now using: ${name}`);
    this.#lastDeviceName = name;

    this.#recorder = recorder;
    this.#chunks = [];
    this.#running = true;
    this.#loop = this.#readLoop(recorder);
  }

  async #readLoop(recorder: PvRecorder): Promise<void> {
    while (this.#running) {
      try {
        const frame = await recorder.read();
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
    this.#close();
    const pcm = concatPcm(this.#chunks);
    this.#chunks = [];
    return pcm;
  }

  #close(): void {
    const recorder = this.#recorder;
    this.#recorder = null;
    if (!recorder) return;
    try {
      recorder.stop();
    } catch {
      // already stopped
    }
    recorder.release();
  }

  release(): void {
    this.#running = false;
    this.#close();
  }
}
