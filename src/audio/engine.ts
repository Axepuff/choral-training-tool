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
  private loopBuffers = new Map<string, { start: number; end: number; buffer: AudioBuffer }>();
  private loop: { start: number; end: number } | null = null;
  private beatSeconds = 0;
  private beatsPerBar = 4;
  private metronome = false;
  private clicks: { source: OscillatorNode; gain: GainNode }[] = [];
  private clickTimer: ReturnType<typeof setTimeout> | undefined;
  private nextClick = 0;
  private timelinePosition() {
    return Math.min(this.playing && this.streaming ? this.scheduledUntil : this.limit,
      this.offset + (this.playing ? Math.max(0, this.context.currentTime - this.started) : 0));
  }
  private get limit() { return this.loop ? Infinity : this.duration; }
  private songPosition(time: number) {
    if (!this.loop || time < this.loop.end - 1e-8) return time;
    const length = this.loop.end - this.loop.start;
    const phase = ((time - this.loop.start) % length + length) % length;
    return this.loop.start + (length - phase < 1e-8 ? 0 : phase);
  }
  private windowEnd(start: number) {
    const position = this.songPosition(start);
    return start + Math.min(4, (this.loop?.end ?? this.duration) - position);
  }
  async setLoop(range: { start: number; end: number } | null, mix = this.mix) {
    if (range && (!Number.isFinite(range.start) || !Number.isFinite(range.end) || range.start < 0 || range.end > this.duration || range.start >= range.end)) throw new Error('Недопустимые границы повтора');
    if (this.loop?.start === range?.start && this.loop?.end === range?.end) return;
    const resume = this.wantsPlayback;
    this.pause();
    this.loopBuffers.clear();
    this.loop = range;
    if (range && (this.offset < range.start || this.offset >= range.end)) this.offset = range.start;
    if (resume) await this.play(mix);
  }
  setMetronome(enabled: boolean, bpm: number, beatsPerBar: number, beatUnit: number) {
    this.stopClicks();
    this.metronome = enabled;
    this.beatSeconds = 60 * 4 / (bpm * beatUnit);
    this.beatsPerBar = beatsPerBar;
    if (this.playing) this.startClicks();
  }
  private stopClicks() {
    clearTimeout(this.clickTimer);
    this.clicks.forEach(({ source, gain }) => { source.stop(); source.disconnect(); gain.disconnect(); });
    this.clicks = [];
  }
  private startClicks() {
    if (!this.metronome || !(this.beatSeconds > 0)) return;
    this.nextClick = this.timelinePosition();
    const tick = () => {
      if (!this.playing) return;
      const now = this.context.currentTime;
      // Schedule only a short horizon, using the same epoch as every audio window.
      while (this.started + this.nextClick - this.offset < now + 0.15 && this.nextClick < this.limit) {
        const position = this.songPosition(this.nextClick);
        const beat = Math.ceil((position - 1e-8) / this.beatSeconds);
        const time = this.nextClick + beat * this.beatSeconds - position;
        if (this.loop && beat * this.beatSeconds >= this.loop.end - 1e-8) {
          this.nextClick += this.loop.end - position;
          continue;
        }
        const when = this.started + time - this.offset;
        if (time >= this.limit || (this.streaming && time >= this.scheduledUntil)) break;
        if (when >= now) {
          const click = this.context.createOscillator(), gain = this.context.createGain();
          click.frequency.value = beat % this.beatsPerBar === 0 ? 1200 : 800;
          gain.gain.setValueAtTime(0.18, when);
          gain.gain.exponentialRampToValueAtTime(0.001, when + 0.025);
          click.connect(gain); gain.connect(this.context.destination);
          const node = { source: click, gain };
          this.clicks.push(node);
          click.onended = () => { click.disconnect(); gain.disconnect(); this.clicks = this.clicks.filter(c => c !== node); };
          click.start(when); click.stop(when + 0.03);
        }
        this.nextClick = time + this.beatSeconds;
        if (this.loop) this.nextClick = Math.min(this.nextClick, time + this.loop.end - this.songPosition(time));
      }
      this.clickTimer = setTimeout(tick, 25);
    };
    tick();
  }
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
  get position() { return this.songPosition(this.timelinePosition()); }
  async play(mix: Record<string, Mix>) {
    this.wantsPlayback = true;
    const generation = ++this.generation;
    // resume is called directly from the click, before any network/decode await.
    this.mix = mix;
    await this.context.resume();
    if (this.disposed || generation !== this.generation) return;
    this.stopNodes();
    this.streaming = this.streams.size > 0 || (!!this.loop && this.buffers.size > 0);
    if (this.loop && (this.offset < this.loop.start || this.offset >= this.loop.end)) this.offset = this.loop.start;
    else if (this.offset >= this.duration) this.offset = 0;
    this.error = '';
    if (this.streaming) {
      // Serialize against a canceled seek's in-flight decode; it must not accumulate windows.
      await this.pending;
      if (this.disposed || generation !== this.generation) return;
      const end = this.windowEnd(this.offset);
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
      this.startClicks();
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
    this.startClicks();
  }
  private async loadWindow(start: number, end: number): Promise<{ id: string; buffer: AudioBuffer; offset?: number; length?: number }[]> {
    const length = end - start;
    start = this.songPosition(start); end = start + length;
    const loaded = await Promise.all([...this.streams].map(async ([id, stream]) => {
      if (start >= stream.duration) return null;
      try {
        const until = Math.min(end, this.loop?.end ?? this.duration, stream.duration);
        const cached = this.loopBuffers.get(id);
        if (cached && Math.abs(cached.start - start) < 1e-7 && Math.abs(cached.end - until) < 1e-7) return { id, buffer: cached.buffer };
        const buffer = await stream.load(start, until);
        // A short loop reuses its decoded PCM; do not fetch/decode each repetition.
        if (!this.disposed && this.loop && this.loop.end - this.loop.start <= 4) this.loopBuffers.set(id, { start, end: until, buffer });
        return { id, buffer };
      }
      catch (error) { this.streams.delete(id); this.setMix(this.mix); this.onTrackError(id, error); return null; }
    }));
    return [...loaded.filter(item => item !== null), ...[...this.buffers].flatMap(([id, buffer]) =>
      this.loop && start < buffer.duration ? [{ id, buffer, offset: start, length: Math.min(end, buffer.duration) - start }] : [])];
  }
  private schedule(loaded: { id: string; buffer: AudioBuffer; offset?: number; length?: number }[], start: number) {
    for (const { id, buffer, offset, length } of loaded) {
      const source = this.context.createBufferSource(), gain = this.context.createGain();
      source.buffer = buffer; source.connect(gain); gain.connect(this.context.destination);
      const node = { source, gain, id };
      this.nodes.push(node);
      source.onended = () => {
        source.disconnect(); source.buffer = null; gain.disconnect();
        this.nodes = this.nodes.filter(n => n !== node);
      };
      const when = this.started + (start - this.offset);
      if (offset === undefined) source.start(when);
      else source.start(when, offset, length);
    }
    this.setMix(this.mix);
  }
  private pump(generation: number) {
    // Watch the buffered boundary independently of the pending network/decode.
    const watchBoundary = () => {
      if (!this.playing || generation !== this.generation) return;
      if (this.scheduledUntil < this.limit && this.context.currentTime >= this.started + (this.scheduledUntil - this.offset)) {
        this.starve();
        return;
      }
      this.boundaryTimer = setTimeout(watchBoundary, 50);
    };
    watchBoundary();
    const tick = async () => {
      if (!this.playing || generation !== this.generation) return;
      while (this.scheduledUntil < this.limit && this.scheduledUntil < this.timelinePosition() + (this.loop ? Math.max(0.3, Math.min(8, (this.loop.end - this.loop.start) * 3)) : 8)) {
        const start = this.scheduledUntil, end = this.windowEnd(start);
        const requestedAudio = [...this.streams.values(), ...(this.loop ? this.buffers.values() : [])].some(stream => this.songPosition(start) < stream.duration);
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
    this.pause(); this.offset = this.songPosition(bufferedEnd);
    this.error = 'Аудио не успело загрузиться. Нажмите воспроизведение ещё раз.';
    this.onError(this.error);
  }
  private stopNodes() {
    this.stopClicks();
    clearTimeout(this.boundaryTimer);
    clearTimeout(this.timer);
    this.nodes.forEach(({ source, gain }) => { source.stop(); source.disconnect(); source.buffer = null; gain.disconnect(); });
    this.nodes = [];
  }
  pause() { this.wantsPlayback = false; ++this.generation; this.offset = this.position; this.playing = false; this.stopNodes(); }
  seek(time: number, mix: Record<string, Mix>) {
    const playing = this.wantsPlayback;
    this.pause(); this.offset = Math.max(0, Math.min(this.duration, time));
    if (this.loop && (this.offset < this.loop.start || this.offset >= this.loop.end)) this.offset = this.loop.start;
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
  dispose() { this.pause(); this.disposed = true; this.loopBuffers.clear(); this.buffers.clear(); this.streams.clear(); void this.context.close(); }
}
