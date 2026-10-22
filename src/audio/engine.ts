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
  if (Object.values(next).every(t => t.solo)) {
    for (const key of Object.keys(next)) next[key] = { ...next[key]!, solo: false };
  }
  return next;
}
export function mediaURL(value: string) {
  if (!value.startsWith('/api/v1/') || value.includes('..') || value.includes('#')) throw new Error('Недопустимый адрес аудио');
  return value;
}

export interface AudioWindowSource {
  duration: number;
  load(start: number, end: number): Promise<AudioBuffer>;
}
/** All windows/sources are scheduled against one context clock. */
export class AudioEngine {
  buffers = new Map<string, AudioBuffer>();
  streams = new Map<string, AudioWindowSource>();
  onTrackError: (id: string, error: unknown) => void = () => {};
  error = '';
  onError: (message: string) => void = () => {};
  private mix: Record<string, Mix> = {};
  private wantsPlayback = false;
  private boundaryTimer: ReturnType<typeof setTimeout> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending: Promise<unknown> = Promise.resolve();
  private streaming = false;
  private scheduledUntil = 0;
  private nodes: { source: AudioBufferSourceNode; gain: GainNode; id: string }[] = [];
  private offset = 0;
  private started = 0;
  playing = false;
  disposed = false;
  private generation = 0;
  constructor(readonly context: AudioContext, readonly duration: number) {}
  get playbackRequested() { return this.wantsPlayback; }
  get position() { return Math.min(this.playing && this.streaming ? this.scheduledUntil : this.duration, this.offset + (this.playing ? Math.max(0, this.context.currentTime - this.started) : 0)); }
  async play(mix: Record<string, Mix>) {
    this.wantsPlayback = true;
    const generation = ++this.generation;
    // resume is called directly from the click, before any network/decode await.
    this.mix = mix;
    await this.context.resume();
    if (this.disposed || generation !== this.generation) return;
    this.stopNodes();
    this.streaming = this.streams.size > 0;
    if (this.offset >= this.duration) this.offset = 0;
    this.error = '';
    if (this.streaming) {
      // Serialize against a canceled seek's in-flight decode; it must not accumulate windows.
      await this.pending;
      if (this.disposed || generation !== this.generation) return;
      const end = Math.min(this.duration, this.offset + 4);
      const window = this.loadWindow(this.offset, end);
      this.pending = window;
      const loaded = await window;
      if (this.disposed || generation !== this.generation) return;
      if (!loaded.length) throw new Error('Нет доступных дорожек');
      this.started = this.context.currentTime + 0.1;
      this.playing = true;
      this.schedule(loaded, this.offset);
      this.scheduledUntil = end;
      this.pump(generation);
      return;
    }
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
  private async loadWindow(start: number, end: number) {
    const loaded = await Promise.all([...this.streams].map(async ([id, stream]) => {
      if (start >= stream.duration) return null;
      try { return { id, buffer: await stream.load(start, Math.min(end, stream.duration)) }; }
      catch (error) { this.streams.delete(id); this.setMix(this.mix); this.onTrackError(id, error); return null; }
    }));
    return loaded.filter(item => item !== null);
  }
  private schedule(loaded: { id: string; buffer: AudioBuffer }[], start: number) {
    for (const { id, buffer } of loaded) {
      const source = this.context.createBufferSource(), gain = this.context.createGain();
      source.buffer = buffer; source.connect(gain); gain.connect(this.context.destination);
      const node = { source, gain, id };
      this.nodes.push(node);
      source.onended = () => {
        source.disconnect(); source.buffer = null; gain.disconnect();
        this.nodes = this.nodes.filter(n => n !== node);
      };
      source.start(this.started + (start - this.offset));
    }
    this.setMix(this.mix);
  }
  private pump(generation: number) {
    // Watch the buffered boundary independently of the pending network/decode.
    const watchBoundary = () => {
      if (!this.playing || generation !== this.generation) return;
      if (this.scheduledUntil < this.duration && this.context.currentTime >= this.started + (this.scheduledUntil - this.offset)) {
        this.starve();
        return;
      }
      this.boundaryTimer = setTimeout(watchBoundary, 50);
    };
    watchBoundary();
    const tick = async () => {
      if (!this.playing || generation !== this.generation) return;
      if (this.scheduledUntil < this.duration && this.scheduledUntil < this.position + 8) {
        const start = this.scheduledUntil, end = Math.min(this.duration, start + 4);
        const requestedAudio = [...this.streams.values()].some(stream => start < stream.duration);
        const window = this.loadWindow(start, end);
        this.pending = window;
        const loaded = await window;
        if (!this.playing || generation !== this.generation) return;
        if (requestedAudio && !loaded.length) {
          this.pause();
          this.error = 'Нет доступных дорожек. Воспроизведение остановлено.';
          this.onError(this.error);
          return;
        }
        // Stop the entire transport on starvation rather than silently losing synchronization.
        if (this.context.currentTime >= this.started + (start - this.offset)) {
          this.starve();
          return;
        }
        this.schedule(loaded, start); this.scheduledUntil = end;
      }
      if (this.playing) this.timer = setTimeout(() => { void tick(); }, 100);
    };
    void tick();
  }
  private starve() {
    const bufferedEnd = this.scheduledUntil;
    this.pause(); this.offset = bufferedEnd;
    this.error = 'Аудио не успело загрузиться. Нажмите воспроизведение ещё раз.';
    this.onError(this.error);
  }
  private stopNodes() {
    clearTimeout(this.boundaryTimer);
    clearTimeout(this.timer);
    this.nodes.forEach(({ source, gain }) => { source.stop(); source.disconnect(); source.buffer = null; gain.disconnect(); });
    this.nodes = [];
  }
  pause() { this.wantsPlayback = false; ++this.generation; this.offset = this.position; this.playing = false; this.stopNodes(); }
  seek(time: number, mix: Record<string, Mix>) {
    const playing = this.wantsPlayback;
    this.pause(); this.offset = Math.max(0, Math.min(this.duration, time));
    if (playing) return this.play(mix);
    return Promise.resolve();
  }
  setMix(mix: Record<string, Mix>) {
    this.mix = mix;
    const solo = Object.entries(mix).some(([id, t]) => t.solo && (this.streams.has(id) || this.buffers.has(id)));
    for (const { id, gain } of this.nodes) {
      const t = mix[id]!;
      gain.gain.setTargetAtTime(t.muted || (solo && !t.solo) ? 0 : t.volume / 100, this.context.currentTime, 0.005);
    }
  }
  dispose() { this.pause(); this.disposed = true; this.buffers.clear(); this.streams.clear(); void this.context.close(); }
}
