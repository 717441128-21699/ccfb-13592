// 自测:合成 MIDI -> 解析 -> 排版 -> 校验约束与性能
// 运行: node test/selftest.ts
import { parseMidi } from '../src/midi.ts';
import { layoutRoll, PRESET_88, PRESET_65 } from '../src/layout.ts';

// ---- 合成一个 SMF format 1 文件 ----
function varLen(v: number): number[] {
  const bytes = [v & 0x7f];
  v >>= 7;
  while (v > 0) { bytes.unshift((v & 0x7f) | 0x80); v >>= 7; }
  return bytes;
}
function track(events: number[]): number[] {
  const len = events.length;
  return [
    0x4d, 0x54, 0x72, 0x6b, // MTrk
    (len >> 24) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff,
    ...events,
  ];
}

const TPQ = 480;
const ev: number[] = [];
// tempo 500000us/qn
ev.push(0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20);
let tick = 0;
function deltaTo(t: number) { ev.push(...varLen(t - tick)); tick = t; }

// 1) 密集重复音(触发纸桥约束):C4 每 60 tick 一次,持续 50 tick
for (let i = 0; i < 40; i++) {
  deltaTo(i * 60); ev.push(0x90, 60, 100);
  deltaTo(i * 60 + 50); ev.push(0x80, 60, 0);
}
// 2) 音阶 + 变化力度(测试力度分区)
for (let i = 0; i < 60; i++) {
  const pitch = 30 + i;
  const vel = 20 + ((i * 37) % 100);
  const t0 = 3000 + i * 120;
  deltaTo(t0); ev.push(0x90, pitch, vel);
  deltaTo(t0 + 100); ev.push(0x80, pitch, 0);
}
// 3) 和弦(低音区)
for (let i = 0; i < 10; i++) {
  const t0 = 11000 + i * 480;
  for (const p of [36, 40, 43]) { deltaTo(t0); ev.push(0x90, p, 30 + i * 8); }
  for (const p of [36, 40, 43]) { deltaTo(t0 + 400); ev.push(0x80, p, 0); }
}
// 4) 延音踏板
deltaTo(11000); ev.push(0xb0, 64, 127);
deltaTo(15000); ev.push(0xb0, 64, 0);
// 5) 超音域音符(应被丢弃并告警)
deltaTo(16000); ev.push(0x90, 10, 80);
deltaTo(16100); ev.push(0x80, 10, 0);
deltaTo(16200); ev.push(0xff, 0x2f, 0x00); // end of track

const header = [
  0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6,
  0, 1, 0, 1, (TPQ >> 8) & 0xff, TPQ & 0xff,
];
const buf = new Uint8Array([...header, ...track(ev)]).buffer;

// ---- 解析 ----
const t0 = performance.now();
const midi = parseMidi(buf);
const tParse = performance.now() - t0;
console.log(`解析: ${midi.notes.length} 音符, ${midi.pedals.length} 段踏板, 时长 ${midi.durationSec.toFixed(2)}s, 耗时 ${tParse.toFixed(1)}ms`);

let failures = 0;
function check(cond: boolean, msg: string) {
  if (!cond) { console.error(`  ✗ ${msg}`); failures++; }
}

check(midi.notes.length === 40 + 60 + 30 + 1, `音符数应为 131,实际 ${midi.notes.length}`);
check(midi.pedals.length === 1, `踏板段数应为 1,实际 ${midi.pedals.length}`);
// 第一个音: tick 0 -> 0s; 第 40 个重复音后音阶在 tick 3000 -> 3000/480*0.5 = 3.125s
const scale0 = midi.notes.find(n => n.pitch === 30);
check(scale0 !== undefined && Math.abs(scale0.start - 3.125) < 1e-6, `音阶首音应在 3.125s,实际 ${scale0?.start}`);

// ---- 排版(88 音) ----
for (const [name, spec] of [['88音', PRESET_88], ['65音', PRESET_65]] as const) {
  const t1 = performance.now();
  const L = layoutRoll(midi, spec);
  const tLayout = performance.now() - t1;
  console.log(`\n[${name}] 孔数 ${L.holes.length}, 卷长 ${(L.totalLengthMm / 1000).toFixed(2)}m, 纸速 ${L.paperSpeedMmS.toFixed(1)}mm/s, 耗时 ${tLayout.toFixed(1)}ms`);
  console.log(`  告警: ${L.warnings.join(' | ') || '无'}`);

  check(tLayout < 5000, `${name}: 排版应 < 5s`);
  // 校验 1: 同轨道相邻孔纸桥 >= minBridge(允许 snap 误差)
  const byTrack = new Map<number, typeof L.holes>();
  for (const h of L.holes) {
    if (!byTrack.has(h.track)) byTrack.set(h.track, []);
    byTrack.get(h.track)!.push(h);
  }
  let bridgeOk = true, lenOk = true;
  for (const [, list] of byTrack) {
    list.sort((a, b) => a.yMm - b.yMm);
    for (let i = 0; i + 1 < list.length; i++) {
      const gap = list[i + 1].yMm - (list[i].yMm + list[i].lenMm);
      if (gap < spec.minBridgeMm - spec.snapMm - 1e-6) bridgeOk = false;
    }
    for (const h of list) if (h.lenMm < spec.minHoleLenMm - 1e-6) lenOk = false;
  }
  check(bridgeOk, `${name}: 存在纸桥不足的相邻孔`);
  check(lenOk, `${name}: 存在小于最小孔长的孔`);
  // 校验 2: 超音域音符被丢弃
  check(L.stats.dropped >= 1, `${name}: 超音域音符应被丢弃`);
  // 校验 3: 密集重复音触发了缩短
  check(L.stats.shortened > 0, `${name}: 密集重复音应触发缩短`);
  // 校验 4: 力度轨/踏板轨有孔
  check(L.holes.some(h => h.kind === 'dynBass'), `${name}: 缺少低音力度轨`);
  check(L.holes.some(h => h.kind === 'dynTreble'), `${name}: 缺少高音力度轨`);
  check(L.holes.some(h => h.kind === 'pedal'), `${name}: 缺少踏板轨`);
  // 校验 5: 65 音时音阶高部(pitch>97)应被丢弃
  if (name === '65音') {
    check(L.holes.every(h => h.kind !== 'note' || h.track <= spec.highNote - spec.lowNote), '65音: 存在越界轨道');
  }
}

// ---- 大曲性能测试:模拟 2 万音符 ----
import type { MidiNote } from '../src/midi.ts';
const bigNotes: MidiNote[] = [];
let t = 0;
let seed = 42;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
for (let i = 0; i < 20000; i++) {
  t += rnd() * 0.05;
  const dur = 0.05 + rnd() * 0.5;
  bigNotes.push({ pitch: 21 + Math.floor(rnd() * 88), start: t, end: t + dur, velocity: 20 + Math.floor(rnd() * 100), channel: 0 });
}
const big = { notes: bigNotes, pedals: [], durationSec: t + 1, name: 'big' };
const t2 = performance.now();
const L2 = layoutRoll(big, PRESET_88);
const tBig = performance.now() - t2;
console.log(`\n[性能] 20000 音符排版耗时 ${tBig.toFixed(1)}ms(要求 < 5000ms)`);
check(tBig < 5000, '大曲排版超时');
check(L2.holes.length > 0, '大曲无输出');

console.log(failures === 0 ? '\n全部通过 ✓' : `\n${failures} 项失败 ✗`);
process.exit(failures === 0 ? 0 : 1);
