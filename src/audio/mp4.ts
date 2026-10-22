/** Bounded-window reader for the server's non-fragmented mono AAC-LC MP4. */
const u32 = (data: Uint8Array, offset: number) => new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(offset);
function word(value: number) { const data = new Uint8Array(4); new DataView(data.buffer).setUint32(0, value); return data; }
function join(...parts: Uint8Array[]) { const data = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0; for (const part of parts) { data.set(part, at); at += part.length; } return data; }
function box(type: string, data: Uint8Array) { return join(word(data.length + 8), new TextEncoder().encode(type), data); }
function boxes(data: Uint8Array) {
  const result: { type: string; data: Uint8Array }[] = [];
  for (let at = 0; at < data.length;) {
    if (at + 8 > data.length) throw new Error('Повреждённый MP4');
    const size = u32(data, at);
    if (size < 8 || at + size > data.length) throw new Error('Неподдерживаемый MP4');
    result.push({ type: new TextDecoder().decode(data.subarray(at + 4, at + 8)), data: data.subarray(at + 8, at + size) });
    at += size;
  }
  return result;
}
const child = (data: Uint8Array, type: string) => { const found = boxes(data).find(b => b.type === type); if (!found) throw new Error(`MP4: нет ${type}`); return found.data; };
export type RangeReader = (start: number, end: number) => Promise<Uint8Array>;
function validateTiming(stts: Uint8Array, sampleCount: number) {
  if (stts.length < 8) throw new Error('Повреждённый AAC timing');
  const entries = u32(stts, 4);
  if (!entries || stts.length !== 8 + entries * 8) throw new Error('Повреждённый AAC timing');
  let frames = 0, drift = 0;
  for (let i = 0; i < entries; i++) {
    const count = u32(stts, 8 + i * 8), delta = u32(stts, 12 + i * 8);
    if (!count || !delta || count > sampleCount - frames) throw new Error('Повреждённый AAC timing');
    // The worker's asetpts/resampling can round packet timestamps, e.g. to
    // 1023/1025 ticks for a 44.1 kHz input. AAC still decodes 1024 PCM samples.
    // Permit at most 1 ms of cumulative rounding; do not permit actual drift.
    const fullFrames = Math.min(count, sampleCount - 1 - frames);
    drift += fullFrames * (delta - 1024);
    if (Math.abs(drift) > 48) throw new Error('Неподдерживаемый AAC timing');
    frames += count;
    if (frames === sampleCount && (delta + drift < 1 || delta + drift > 1024)) throw new Error('Неподдерживаемый AAC timing');
  }
  if (frames !== sampleCount) throw new Error('Повреждённый AAC timing');
}
export class MP4Reader {
  private constructor(private read: RangeReader, private moov: Uint8Array, private ftyp: Uint8Array, private offsets: number[], private sizes: number[], private priming: number) {}
  static async open(read: RangeReader) {
    // Skip mdat using its header: never download a complete long recording.
    let at = 0, moov: Uint8Array | undefined, ftyp: Uint8Array | undefined;
    for (let count = 0; count < 16; count++) {
      const header = await read(at, at + 7);
      const size = u32(header, 0), type = new TextDecoder().decode(header.subarray(4, 8));
      if (size < 8 || size > 64 * 1024 * 1024) throw new Error('Неподдерживаемый размер MP4');
      if (type === 'ftyp' && size <= 128) ftyp = box('ftyp', await read(at + 8, at + size - 1));
      if (type === 'moov' && size > 2 * 1024 * 1024) throw new Error('Слишком большой индекс MP4');
      if (type === 'moov') { moov = await read(at + 8, at + size - 1); break; }
      at += size;
    }
    if (!moov || !ftyp) throw new Error('MP4: нет индекса');
    const trak = child(moov, 'trak'), mdia = child(trak, 'mdia');
    const mdhd = child(mdia, 'mdhd');
    if (mdhd[0] !== 0 || u32(mdhd, 12) !== 48000) throw new Error('Неподдерживаемая частота MP4');
    const stbl = child(child(mdia, 'minf'), 'stbl');
    const stsz = child(stbl, 'stsz'), stsc = child(stbl, 'stsc'), stco = child(stbl, 'stco');
    const count = u32(stsz, 8);
    if (!count || count > 60000 || stsz.length !== 12 + (u32(stsz, 4) ? 0 : count * 4)) throw new Error('Недопустимый индекс MP4');
    validateTiming(child(stbl, 'stts'), count);
    const sizes = Array.from({ length: count }, (_, i) => u32(stsz, 4) || u32(stsz, 12 + i * 4));
    const runs = Array.from({ length: u32(stsc, 4) }, (_, i) => ({ first: u32(stsc, 8 + i * 12), samples: u32(stsc, 12 + i * 12) }));
    const offsets: number[] = []; let run = 0;
    for (let chunk = 1; chunk <= u32(stco, 4); chunk++) {
      if (runs[run + 1]?.first === chunk) run++;
      let offset = u32(stco, 8 + (chunk - 1) * 4);
      for (let i = 0; i < runs[run]!.samples; i++) { offsets.push(offset); offset += sizes[offsets.length - 1]!; }
    }
    if (offsets.length !== count) throw new Error('Повреждённые chunks MP4');
    for (let i = 1; i < count; i++) {
      if (offsets[i] !== offsets[i - 1]! + sizes[i - 1]!) throw new Error('Неподдерживаемое чередование MP4');
    }
    let priming = 0;
    const edts = boxes(trak).find(b => b.type === 'edts');
    if (edts) {
      const elst = child(edts.data, 'elst');
      if (elst[0] !== 0 || u32(elst, 4) !== 1) throw new Error('Неподдерживаемые edits MP4');
      priming = u32(elst, 12);
      if (priming > 48000) throw new Error('Неподдерживаемая задержка AAC');
    }
    return new MP4Reader(read, moov, ftyp, offsets, sizes, priming);
  }
  async decode(context: AudioContext, start: number, end: number) {
    const sampleStart = Math.round(start * 48000) + this.priming;
    // Two AAC frames warm up overlap/prediction before the audible window.
    const first = Math.max(0, Math.floor(sampleStart / 1024) - 2);
    const last = Math.min(this.sizes.length, Math.ceil((end * 48000 + this.priming) / 1024) + 1);
    const sizes = this.sizes.slice(first, last), length = sizes.length * 1024;
    const bytes = await this.read(this.offsets[first]!, this.offsets[last - 1]! + sizes.at(-1)! - 1);
    const full = new Uint8Array(4);
    const rewrite = (data: Uint8Array, parent: string): Uint8Array => join(...boxes(data).filter(b => b.type !== 'edts').map(({ type, data: body }) => {
      let payload = body;
      if (['trak', 'mdia', 'minf', 'stbl'].includes(type)) payload = rewrite(body, type);
      else if (type === 'mvhd' || type === 'tkhd' || type === 'mdhd') {
        if (body[0] !== 0) throw new Error('Неподдерживаемая версия MP4');
        payload = body.slice();
        const scale = type === 'mdhd' ? 48000 : u32(child(this.moov, 'mvhd'), 12);
        new DataView(payload.buffer).setUint32(type === 'tkhd' ? 20 : 16, Math.ceil(length * scale / 48000));
      } else if (parent === 'stbl') {
        if (type === 'stts') payload = join(full, word(1), word(sizes.length), word(1024));
        if (type === 'stsc') payload = join(full, word(1), word(1), word(sizes.length), word(1));
        if (type === 'stsz') payload = join(full, word(0), word(sizes.length), ...sizes.map(word));
        if (type === 'stco') payload = join(full, word(1), word(this.ftyp.length + 8)); // one mdat chunk after ftyp
      }
      return box(type, payload);
    }));
    const segment = join(this.ftyp, box('mdat', bytes), box('moov', rewrite(this.moov, 'moov')));
    const decoded = await context.decodeAudioData(segment.buffer as ArrayBuffer);
    const offset = sampleStart - first * 1024;
    const samples = Math.round((end - start) * 48000);
    if (decoded.sampleRate !== 48000 || samples <= 0 || decoded.length - offset < samples) throw new Error('Неподдерживаемый декодер AAC');
    const output = context.createBuffer(1, samples, 48000);
    output.copyToChannel(decoded.getChannelData(0).subarray(offset, offset + samples), 0);
    return output;
  }
}
