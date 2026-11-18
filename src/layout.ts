// 排版核心:把 MIDI 音符换算成纸卷上的孔位/孔长,处理纸桥约束与力度分区。
import type { MidiData, MidiNote } from './midi';

export interface RollSpec {
  name: string;
  lowNote: number;        // 最低 MIDI 音高
  highNote: number;       // 最高 MIDI 音高
  holesPerInch: number;   // 每英寸孔位数(横向密度)
  paperWidthMm: number;   // 纸宽
  sideMarginMm: number;   // 纸边到第一列孔中心的距离
  holeWidthMm: number;    // 孔的横向宽度
  tempoMark: number;      // 纸卷速度标号(惯例:标号/10 = 英尺/分钟)
  minBridgeMm: number;    // 同轨道相邻孔间最小纸桥
  minHoleLenMm: number;   // 冲床可冲的最小孔长
  snapMm: number;         // 纵向位置吸附精度(冲床步距)
  splitPitch: number;     // 力度分区边界:<= 此音高为低音半区
  dynLevels: number;      // 力度量化档数
}

export const PRESET_88: RollSpec = {
  name: '88音标准卷',
  lowNote: 21, highNote: 108,
  holesPerInch: 9,
  paperWidthMm: 287, sideMarginMm: 14.5,
  holeWidthMm: 1.6,
  tempoMark: 80,
  minBridgeMm: 2.0,
  minHoleLenMm: 1.2,
  snapMm: 0.1,
  splitPitch: 60,
  dynLevels: 4,
};

export const PRESET_65: RollSpec = {
  name: '65音卷',
  lowNote: 33, highNote: 97,
  holesPerInch: 6,
  paperWidthMm: 287, sideMarginMm: 8,
  holeWidthMm: 2.0,
  tempoMark: 70,
  minBridgeMm: 2.0,
  minHoleLenMm: 1.5,
  snapMm: 0.1,
  splitPitch: 65,
  dynLevels: 4,
};

export type HoleKind = 'note' | 'dynBass' | 'dynTreble' | 'pedal';

export interface Hole {
  track: number;      // 轨道号(0..trackCount-1)
  xMm: number;        // 孔中心横向位置
  yMm: number;        // 孔起点(纸前进方向)
  lenMm: number;      // 孔长
  widthMm: number;
  kind: HoleKind;
  label?: string;     // 备注(音高/力度档)
}

export interface TrackInfo {
  index: number;
  kind: HoleKind;
  label: string;
  xMm: number;
}

export interface RollLayout {
  spec: RollSpec;
  tracks: TrackInfo[];
  holes: Hole[];            // 按 y 排序
  totalLengthMm: number;
  paperSpeedMmS: number;
  dynLevelValues: number[]; // 量化后的力度档(velocity 值),供对照
  warnings: string[];
  stats: { notes: number; shortened: number; dropped: number; holes: number };
}

export function paperSpeedMmS(spec: RollSpec): number {
  // 惯例:速度标号 T => T/10 英尺/分钟
  return (spec.tempoMark / 10) * 304.8 / 60;
}

const snap = (v: number, step: number) => Math.round(v / step) * step;

/** 一维 k-means(带时长权重),把连续力度值量化成 K 档,使总误差最小 */
function quantizeLevels(values: number[], weights: number[], k: number): { centers: number[]; assign: number[] } {
  const n = values.length;
  if (n === 0) return { centers: [], assign: [] };
  k = Math.max(1, Math.min(k, n));
  // 初始中心:按加权分位数取
  const order = values.map((v, i) => i).sort((a, b) => values[a] - values[b]);
  const centers: number[] = [];
  const totalW = weights.reduce((s, w) => s + w, 0);
  let acc = 0, ci = 0;
  for (let j = 0; j < k; j++) {
    const target = ((j + 0.5) / k) * totalW;
    while (ci < n - 1 && acc < target) { acc += weights[order[ci]]; ci++; }
    centers.push(values[order[ci]]);
  }
  const assign = new Array<number>(n).fill(0);
  for (let iter = 0; iter < 50; iter++) {
    let changed = false;
    for (let i = 0; i < n; i++) {
      let best = 0, bd = Infinity;
      for (let j = 0; j < k; j++) {
        const d = Math.abs(values[i] - centers[j]);
        if (d < bd) { bd = d; best = j; }
      }
      if (assign[i] !== best) { assign[i] = best; changed = true; }
    }
    const sumW = new Array<number>(k).fill(0);
    const sumV = new Array<number>(k).fill(0);
    for (let i = 0; i < n; i++) {
      sumW[assign[i]] += weights[i];
      sumV[assign[i]] += values[i] * weights[i];
    }
    for (let j = 0; j < k; j++) if (sumW[j] > 0) centers[j] = sumV[j] / sumW[j];
    if (!changed) break;
  }
  // 中心排序,让档号 0 = 最弱
  const idx = centers.map((c, j) => j).sort((a, b) => centers[a] - centers[b]);
  const remap = new Array<number>(k);
  const sortedCenters = idx.map((j, newJ) => { remap[j] = newJ; return centers[j]; });
  return { centers: sortedCenters, assign: assign.map(a => remap[a]) };
}

export function layoutRoll(midi: MidiData, spec: RollSpec): RollLayout {
  const warnings: string[] = [];
  const speed = paperSpeedMmS(spec);
  const spacing = 25.4 / spec.holesPerInch;
  const noteCount = spec.highNote - spec.lowNote + 1;

  // 轨道布局:音符轨在中间栅格上;低音力度/延音踏板/高音力度三条控制轨
  // 放在两侧纸边空白处(与真实纸卷的表达孔位置一致),不占用音符栅格。
  const noteTrackX = (i: number) => spec.sideMarginMm + i * spacing; // i: 0..noteCount-1
  const gridRight = noteTrackX(noteCount - 1);
  const rightMargin = spec.paperWidthMm - gridRight;
  const dynBassX = spec.sideMarginMm * 0.35;
  const pedalX = spec.sideMarginMm * 0.7;
  const dynTrebleX = gridRight + rightMargin * 0.5;

  const tracks: TrackInfo[] = [];
  for (let i = 0; i < noteCount; i++) {
    tracks.push({ index: i, kind: 'note', label: `音 ${spec.lowNote + i}`, xMm: noteTrackX(i) });
  }
  const dynBassTrack = tracks.length;
  tracks.push({ index: dynBassTrack, kind: 'dynBass', label: '低音力度', xMm: dynBassX });
  const pedalTrack = tracks.length;
  tracks.push({ index: pedalTrack, kind: 'pedal', label: '延音踏板', xMm: pedalX });
  const dynTrebleTrack = tracks.length;
  tracks.push({ index: dynTrebleTrack, kind: 'dynTreble', label: '高音力度', xMm: dynTrebleX });

  const hw = spec.holeWidthMm / 2;
  if (gridRight + hw > spec.paperWidthMm) {
    warnings.push(`音符栅格右缘 ${(gridRight + hw).toFixed(1)}mm 超出纸宽 ${spec.paperWidthMm}mm,请调大纸宽或减小边距`);
  }
  if (dynBassX - hw < 0 || pedalX + hw > noteTrackX(0) - hw) {
    warnings.push(`左侧边距 ${spec.sideMarginMm}mm 放不下控制轨(低音力度/踏板),请加大边距`);
  }
  if (dynTrebleX + hw > spec.paperWidthMm || dynTrebleX - hw < gridRight + hw) {
    warnings.push(`右侧边距 ${rightMargin.toFixed(1)}mm 放不下高音力度轨,请加大纸宽或减小边距`);
  }

  // ---- 音符 -> 孔 ----
  interface RawHole { track: number; y: number; len: number; note: MidiNote }
  const perTrack = new Map<number, RawHole[]>();
  let dropped = 0;
  for (const n of midi.notes) {
    if (n.pitch < spec.lowNote || n.pitch > spec.highNote) {
      dropped++;
      continue;
    }
    const track = n.pitch - spec.lowNote;
    let y = snap(n.start * speed, spec.snapMm);
    let len = snap((n.end - n.start) * speed, spec.snapMm);
    if (len < spec.minHoleLenMm) len = spec.minHoleLenMm; // 太短先补到冲床最小孔长
    if (!perTrack.has(track)) perTrack.set(track, []);
    perTrack.get(track)!.push({ track, y, len, note: n });
  }
  if (dropped) warnings.push(`${dropped} 个音符超出 ${spec.lowNote}-${spec.highNote} 音域,已丢弃`);

  // ---- 纸桥约束:同一轨道相邻孔间距 < minBridge 时缩短前一个 ----
  let shortened = 0, bridgeDropped = 0;
  const noteHoles: Hole[] = [];
  for (const [track, list] of perTrack) {
    list.sort((a, b) => a.y - b.y);
    for (let i = 0; i < list.length; i++) {
      const cur = list[i];
      const next = list[i + 1];
      if (next) {
        const gap = next.y - (cur.y + cur.len);
        if (gap < spec.minBridgeMm) {
          const newLen = next.y - spec.minBridgeMm - cur.y;
          if (newLen !== cur.len) {
            shortened++;
            cur.len = Math.max(0, newLen);
          }
        }
      }
      if (cur.len < spec.minHoleLenMm) {
        bridgeDropped++;
        continue; // 缩短后已不足最小孔长,只能舍弃
      }
      noteHoles.push({
        track, xMm: noteTrackX(track), yMm: cur.y, lenMm: cur.len,
        widthMm: spec.holeWidthMm, kind: 'note',
        label: `${cur.note.pitch} v${cur.note.velocity}`,
      });
    }
  }
  if (shortened) warnings.push(`${shortened} 个孔因纸桥不足 ${spec.minBridgeMm}mm 被缩短`);
  if (bridgeDropped) warnings.push(`${bridgeDropped} 个音缩短后不足最小孔长 ${spec.minHoleLenMm}mm,已舍弃`);

  // ---- 力度分区:每个半区同一时刻只有一个力度 ----
  // 扫描线:O(n log n) 求出每个半区各时间段激活音符的力度均值,
  // 再用时长加权 k-means 量化成 dynLevels 档 —— 在"全区一个力度"约束下使总误差最小。
  const controlHoles: Hole[] = [];
  interface SweepEv { t: number; half: 0 | 1; dSum: number; dCnt: number }
  const sweep: SweepEv[] = [];
  for (const n of midi.notes) {
    const half = n.pitch <= spec.splitPitch ? 0 : 1;
    sweep.push({ t: n.start, half, dSum: n.velocity, dCnt: 1 });
    sweep.push({ t: n.end, half, dSum: -n.velocity, dCnt: -1 });
  }
  sweep.sort((a, b) => a.t - b.t);

  let dynLevelValues: number[] = [];
  for (const half of [0, 1] as const) {
    // 扫出该半区的分段均值
    const segs: { t: number; dur: number; vel: number }[] = [];
    let sum = 0, cnt = 0, prevT = -1;
    for (const e of sweep) {
      if (e.half !== half) continue;
      if (prevT >= 0 && e.t > prevT && cnt > 0) {
        segs.push({ t: prevT, dur: e.t - prevT, vel: sum / cnt });
      }
      sum += e.dSum;
      cnt += e.dCnt;
      prevT = e.t;
    }
    if (!segs.length) continue;
    const { centers, assign } = quantizeLevels(segs.map(s => s.vel), segs.map(s => s.dur), spec.dynLevels);
    dynLevelValues = centers.map(c => Math.round(c));
    // 相邻同档合并成一条长孔
    const track = half === 0 ? dynBassTrack : dynTrebleTrack;
    const xMm = half === 0 ? dynBassX : dynTrebleX;
    let runStart = 0;
    for (let i = 1; i <= segs.length; i++) {
      if (i === segs.length || assign[i] !== assign[runStart]) {
        const t0 = segs[runStart].t;
        const t1 = segs[i - 1].t + segs[i - 1].dur;
        const y = snap(t0 * speed, spec.snapMm);
        const len = Math.max(spec.minHoleLenMm, snap((t1 - t0) * speed, spec.snapMm));
        controlHoles.push({
          track, xMm, yMm: y, lenMm: len,
          widthMm: spec.holeWidthMm,
          kind: half === 0 ? 'dynBass' : 'dynTreble',
          label: `力度档 ${assign[runStart] + 1}/${centers.length} (≈v${Math.round(centers[assign[runStart]])})`,
        });
        runStart = i;
      }
    }
  }

  // ---- 踏板轨 ----
  for (const p of midi.pedals) {
    const y = snap(p.start * speed, spec.snapMm);
    const len = Math.max(spec.minHoleLenMm, snap((p.end - p.start) * speed, spec.snapMm));
    controlHoles.push({
      track: pedalTrack, xMm: pedalX, yMm: y, lenMm: len,
      widthMm: spec.holeWidthMm, kind: 'pedal', label: '延音踏板',
    });
  }

  // 控制轨同样要满足纸桥约束(与下一孔拉开 minBridge)
  controlHoles.sort((a, b) => a.track - b.track || a.yMm - b.yMm);
  for (let i = 0; i + 1 < controlHoles.length; i++) {
    const a = controlHoles[i], b = controlHoles[i + 1];
    if (a.track !== b.track) continue;
    const gap = b.yMm - (a.yMm + a.lenMm);
    if (gap < spec.minBridgeMm) {
      a.lenMm = Math.max(spec.minHoleLenMm, b.yMm - spec.minBridgeMm - a.yMm);
    }
  }

  const holes = [...noteHoles, ...controlHoles].sort((a, b) => a.yMm - b.yMm || a.track - b.track);
  const lastY = holes.reduce((m, h) => Math.max(m, h.yMm + h.lenMm), 0);

  return {
    spec, tracks, holes,
    totalLengthMm: lastY + 50, // 卷尾留 50mm
    paperSpeedMmS: speed,
    dynLevelValues,
    warnings,
    stats: {
      notes: midi.notes.length,
      shortened,
      dropped: dropped + bridgeDropped,
      holes: holes.length,
    },
  };
}
