// 在浏览器里合成一首示例曲的 SMF 文件,用于不依赖外部 MIDI 快速试机。
export function buildDemoMidi(): ArrayBuffer {
  const TPQ = 480;
  const ev: number[] = [];
  let tick = 0;
  const varLen = (v: number) => {
    const b = [v & 0x7f];
    v >>= 7;
    while (v > 0) { b.unshift((v & 0x7f) | 0x80); v >>= 7; }
    return b;
  };
  const deltaTo = (t: number) => { ev.push(...varLen(t - tick)); tick = t; };
  const note = (t: number, pitch: number, vel: number, dur: number) => {
    deltaTo(t); ev.push(0x90, pitch, vel);
    deltaTo(t + dur); ev.push(0x80, pitch, 0);
  };

  deltaTo(0); ev.push(0xff, 0x51, 0x03, 0x07, 0xa1, 0x20); // 120bpm
  // 右手旋律:音阶与琶音,力度起伏
  for (let i = 0; i < 48; i++) {
    const scale = [60, 62, 64, 65, 67, 69, 71, 72];
    const pitch = scale[i % 8] + 12 * Math.floor((i % 16) / 8);
    const vel = 45 + Math.round(40 * Math.sin(i / 6));
    note(480 * Math.floor(i / 2) + (i % 2) * 240, pitch, vel, 200);
  }
  // 左手伴奏:低音和弦
  for (let bar = 0; bar < 12; bar++) {
    const roots = [36, 41, 43, 36];
    const root = roots[bar % 4];
    for (const p of [root, root + 7, root + 12]) {
      note(bar * 960, p, 35 + bar * 4, 900);
    }
  }
  // 快速重复音(演示纸桥约束)
  for (let i = 0; i < 12; i++) note(12000 + i * 90, 72, 90, 70);
  // 延音踏板两段
  deltaTo(0); ev.push(0xb0, 64, 127);
  deltaTo(5760); ev.push(0xb0, 64, 0);
  deltaTo(5760 + 960); ev.push(0xb0, 64, 127);
  deltaTo(11520); ev.push(0xb0, 64, 0);
  deltaTo(13000); ev.push(0xff, 0x2f, 0x00);

  const trackLen = ev.length;
  const bytes = [
    0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, (TPQ >> 8) & 0xff, TPQ & 0xff,
    0x4d, 0x54, 0x72, 0x6b,
    (trackLen >> 24) & 0xff, (trackLen >> 16) & 0xff, (trackLen >> 8) & 0xff, trackLen & 0xff,
    ...ev,
  ];
  return new Uint8Array(bytes).buffer;
}
