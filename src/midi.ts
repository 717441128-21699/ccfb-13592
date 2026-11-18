// 标准 MIDI 文件 (SMF) 解析:提取音符、速度表、踏板事件,统一换算成秒。

export interface MidiNote {
  pitch: number;      // MIDI 音高 0-127
  start: number;      // 秒
  end: number;        // 秒
  velocity: number;   // 1-127
  channel: number;
}

export interface PedalEvent {
  start: number; // 秒
  end: number;   // 秒
}

export interface MidiData {
  notes: MidiNote[];
  pedals: PedalEvent[];   // 延音踏板 CC64 区间
  durationSec: number;
  name: string;
}

interface RawEvent {
  tick: number;
  type: 'noteOn' | 'noteOff' | 'tempo' | 'cc';
  pitch?: number;
  velocity?: number;
  channel?: number;
  tempoUs?: number;   // 微秒/四分音符
  ccNum?: number;
  ccVal?: number;
}

function readVarLen(view: DataView, pos: number): [number, number] {
  let v = 0;
  let b: number;
  do {
    b = view.getUint8(pos++);
    v = (v << 7) | (b & 0x7f);
  } while (b & 0x80);
  return [v, pos];
}

export function parseMidi(buf: ArrayBuffer): MidiData {
  const view = new DataView(buf);
  let pos = 0;

  const readTag = (p: number) =>
    String.fromCharCode(view.getUint8(p), view.getUint8(p + 1), view.getUint8(p + 2), view.getUint8(p + 3));

  if (readTag(0) !== 'MThd') throw new Error('不是有效的 MIDI 文件(缺少 MThd)');
  const headerLen = view.getUint32(4);
  const format = view.getUint16(8);
  const nTracks = view.getUint16(10);
  const division = view.getUint16(12);
  if (division & 0x8000) throw new Error('暂不支持 SMPTE 时间格式的 MIDI');
  const ticksPerQuarter = division;
  pos = 8 + headerLen;

  const events: RawEvent[] = [];
  let name = '';

  for (let t = 0; t < nTracks; t++) {
    // 跳过非 MTrk 块
    while (pos + 8 <= buf.byteLength && readTag(pos) !== 'MTrk') {
      pos += 8 + view.getUint32(pos + 4);
    }
    if (pos + 8 > buf.byteLength) break;
    const trackLen = view.getUint32(pos + 4);
    let p = pos + 8;
    const end = p + trackLen;
    let tick = 0;
    let status = 0;

    while (p < end) {
      const [delta, np] = readVarLen(view, p);
      p = np;
      tick += delta;
      let b = view.getUint8(p);
      if (b & 0x80) {
        status = b;
        p++;
      } // 否则是 running status
      const type = status & 0xf0;
      const ch = status & 0x0f;

      if (status === 0xff) {
        const meta = view.getUint8(p++);
        const [len, np2] = readVarLen(view, p);
        p = np2;
        if (meta === 0x51 && len === 3) {
          const us = (view.getUint8(p) << 16) | (view.getUint8(p + 1) << 8) | view.getUint8(p + 2);
          events.push({ tick, type: 'tempo', tempoUs: us });
        } else if (meta === 0x03 && !name) {
          name = new TextDecoder().decode(new Uint8Array(buf, p, len));
        }
        p += len;
      } else if (status === 0xf0 || status === 0xf7) {
        const [len, np2] = readVarLen(view, p);
        p = np2 + len;
      } else if (type === 0x90 || type === 0x80) {
        const pitch = view.getUint8(p);
        const vel = view.getUint8(p + 1);
        p += 2;
        if (type === 0x90 && vel > 0) {
          events.push({ tick, type: 'noteOn', pitch, velocity: vel, channel: ch });
        } else {
          events.push({ tick, type: 'noteOff', pitch, velocity: vel, channel: ch });
        }
      } else if (type === 0xb0) {
        const ccNum = view.getUint8(p);
        const ccVal = view.getUint8(p + 1);
        p += 2;
        events.push({ tick, type: 'cc', ccNum, ccVal, channel: ch });
      } else if (type === 0xc0 || type === 0xd0) {
        p += 1;
      } else {
        p += 2; // 0xa0 / 0xe0 等双字节事件
      }
    }
    pos = end;
  }

  // 按 tick 排序(同 tick 时 tempo 优先,保证速度表正确)
  events.sort((a, b) => a.tick - b.tick || (a.type === 'tempo' ? -1 : 0) - (b.type === 'tempo' ? -1 : 0));

  // 速度表:tick -> 秒
  const tickToSec = (() => {
    const tempos: { tick: number; us: number }[] = [];
    for (const e of events) if (e.type === 'tempo') tempos.push({ tick: e.tick, us: e.tempoUs! });
    if (tempos.length === 0 || tempos[0].tick > 0) tempos.unshift({ tick: 0, us: 500000 });
    // 去重(同 tick 取最后一个)
    const uniq: typeof tempos = [];
    for (const t of tempos) {
      if (uniq.length && uniq[uniq.length - 1].tick === t.tick) uniq[uniq.length - 1] = t;
      else uniq.push(t);
    }
    const segments: { tick: number; sec: number; usPerTick: number }[] = [];
    let sec = 0;
    for (let i = 0; i < uniq.length; i++) {
      const usPerTick = uniq[i].us / ticksPerQuarter;
      if (i > 0) sec += ((uniq[i].tick - uniq[i - 1].tick) * segments[i - 1].usPerTick) / 1e6;
      segments.push({ tick: uniq[i].tick, sec, usPerTick });
    }
    return (tick: number) => {
      // 二分找段
      let lo = 0, hi = segments.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (segments[mid].tick <= tick) lo = mid; else hi = mid - 1;
      }
      const s = segments[lo];
      return s.sec + ((tick - s.tick) * s.usPerTick) / 1e6;
    };
  })();

  // 配对 noteOn/noteOff
  const notes: MidiNote[] = [];
  const open = new Map<string, { tick: number; velocity: number }[]>();
  let maxTick = 0;
  for (const e of events) {
    if (e.type !== 'noteOn' && e.type !== 'noteOff') continue;
    maxTick = Math.max(maxTick, e.tick);
    const key = `${e.channel}:${e.pitch}`;
    if (e.type === 'noteOn') {
      if (!open.has(key)) open.set(key, []);
      open.get(key)!.push({ tick: e.tick, velocity: e.velocity! });
    } else {
      const stack = open.get(key);
      if (stack && stack.length) {
        const on = stack.shift()!;
        if (e.tick > on.tick) {
          notes.push({
            pitch: e.pitch!,
            start: tickToSec(on.tick),
            end: tickToSec(e.tick),
            velocity: on.velocity,
            channel: e.channel!,
          });
        }
      }
    }
  }

  // 延音踏板 CC64(>=64 为踩下)
  const pedals: PedalEvent[] = [];
  const pedalDown = new Map<number, number>();
  for (const e of events) {
    if (e.type !== 'cc' || e.ccNum !== 64) continue;
    const ch = e.channel!;
    if (e.ccVal! >= 64) {
      if (!pedalDown.has(ch)) pedalDown.set(ch, e.tick);
    } else if (pedalDown.has(ch)) {
      const start = pedalDown.get(ch)!;
      pedalDown.delete(ch);
      if (e.tick > start) pedals.push({ start: tickToSec(start), end: tickToSec(e.tick) });
    }
  }

  notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  pedals.sort((a, b) => a.start - b.start);
  void format;

  return { notes, pedals, durationSec: tickToSec(maxTick), name: name || '未命名' };
}
