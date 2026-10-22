export interface AudioTrack {
  id: string; name: string; gain: number; durationMs: number | null;
  mediaUrl: string | null; peaksUrl: string | null;
}
export interface AudioSong {
  id: string; title: string; notes: string; bpm: number; beatsPerBar: number; beatUnit: number;
  durationMs: number | null; tracks: AudioTrack[];
}
export interface Mix { volume: number; muted: boolean; solo: boolean }
export function updateMix(mix: Record<string, Mix>, id: string, patch: Partial<Mix>) {
  const next = { ...mix, [id]: { ...mix[id]!, ...patch } };
  if (patch.solo) next[id]!.muted = false;
  if (patch.muted) next[id]!.solo = false;
  if (Object.values(next).every(t => t.solo)) Object.values(next).forEach(t => { t.solo = false; });
  return next;
}
export function mediaURL(value: string) {
  if (!value.startsWith('/api/v1/') || value.includes('..') || value.includes('#')) throw new Error('Недопустимый адрес аудио');
  return value;
}

/** All sources are scheduled against one context clock. No HTML media clocks/timers. */
export class AudioEngine {
  buffers = new Map<string, AudioBuffer>();
  private nodes: { source: AudioBufferSourceNode; gain: GainNode; id: string }[] = [];
  private offset = 0;
  private started = 0;
  playing = false;
  disposed = false;
  private generation = 0;
  constructor(readonly context: AudioContext, readonly duration: number) {}
  get position() { return Math.min(this.duration, this.offset + (this.playing ? Math.max(0, this.context.currentTime - this.started) : 0)); }
  async play(mix: Record<string, Mix>) {
    const generation = ++this.generation;
    // resume is called directly from the click, before any network/decode await.
    await this.context.resume();
    if (this.disposed || generation !== this.generation) return;
    this.stopNodes();
    if (this.offset >= this.duration) this.offset = 0;
    this.started = this.context.currentTime + 0.04;
    for (const [id, buffer] of this.buffers) {
      if (this.offset >= buffer.duration) continue;
      const source = this.context.createBufferSource();
      const gain = this.context.createGain();
      source.buffer = buffer; source.connect(gain); gain.connect(this.context.destination);
      this.nodes.push({ source, gain, id });
      source.start(this.started, this.offset);
    }
    this.playing = true;
    this.setMix(mix);
  }
  private stopNodes() {
    this.nodes.forEach(({ source, gain }) => { source.stop(); source.disconnect(); gain.disconnect(); });
    this.nodes = [];
  }
  pause() { ++this.generation; this.offset = this.position; this.playing = false; this.stopNodes(); }
  seek(time: number, mix: Record<string, Mix>) {
    const playing = this.playing;
    this.pause(); this.offset = Math.max(0, Math.min(this.duration, time));
    if (playing) return this.play(mix);
    return Promise.resolve();
  }
  setMix(mix: Record<string, Mix>) {
    const solo = Object.values(mix).some(t => t.solo);
    for (const { id, gain } of this.nodes) {
      const t = mix[id]!;
      gain.gain.setTargetAtTime(t.muted || (solo && !t.solo) ? 0 : t.volume / 100, this.context.currentTime, 0.005);
    }
  }
  dispose() { this.pause(); this.disposed = true; this.buffers.clear(); void this.context.close(); }
}
