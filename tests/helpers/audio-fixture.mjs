import { execFileSync } from 'node:child_process';

export function makeWav(sampleRate, seconds = 8, channels = 1) {
  const samples = Math.round(sampleRate * seconds);
  const wav = Buffer.alloc(44 + samples * channels * 2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(channels, 22);
  wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * channels * 2, 28);
  wav.writeUInt16LE(channels * 2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  for (let i = 0; i < samples; i++) for (let channel = 0; channel < channels; channel++) {
    wav.writeInt16LE(Math.round(Math.sin(i * Math.PI * 2 * (440 + channel * 110) / sampleRate) * 8000), 44 + (i * channels + channel) * 2);
  }
  return wav;
}

// Match backend/internal/processing/worker.go, including its timestamp filter.
// The previous browser fixture omitted asetpts and never exercised this output.
export const playbackArgs = ['-map', '0:a:0', '-vn', '-sn', '-dn', '-map_metadata', '-1', '-ac', '1', '-ar', '48000', '-af', 'asetpts=N/SR/TB', '-c:a', 'aac', '-profile:a', 'aac_low', '-b:a', '96k', '-threads', '1', '-f', 'mp4'];
export function encodePlayback(input, output) {
  execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-xerror', '-threads', '1', '-filter_threads', '1', '-i', input, ...playbackArgs, '-y', output]);
}
