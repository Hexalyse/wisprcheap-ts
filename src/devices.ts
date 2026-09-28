import { PvSpeaker } from '@picovoice/pvspeaker-node';
import { listInputDevices } from './recorder.ts';

console.log('Input devices (use the index or part of the name as recording.device):');
listInputDevices().forEach((name, i) => console.log(`  ${i}: ${name}`));
console.log('\nOutput devices (sound cues use the system default):');
PvSpeaker.getAvailableDevices().forEach((name, i) => console.log(`  ${i}: ${name}`));
