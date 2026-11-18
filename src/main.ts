import { parseMidi, type MidiData } from './midi';
import { layoutRoll, PRESET_88, PRESET_65, type RollSpec, type RollLayout } from './layout';
import { RollRenderer } from './render';
import { toCSV, toJSON, toDXF, download } from './export';
import { buildDemoMidi } from './demo';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const num = (id: string) => parseFloat($<HTMLInputElement>(id).value);

const SPEC_FIELDS: (keyof RollSpec)[] = [
  'lowNote', 'highNote', 'holesPerInch', 'paperWidthMm', 'sideMarginMm',
  'holeWidthMm', 'tempoMark', 'minBridgeMm', 'minHoleLenMm', 'snapMm',
  'splitPitch', 'dynLevels',
];

let midi: MidiData | null = null;
let layout: RollLayout | null = null;
let midiName = 'roll';

const renderer = new RollRenderer($<HTMLCanvasElement>('roll'));
renderer.onHover(t => { $('status').textContent = t || '就绪'; });
$<HTMLInputElement>('dpi').value = String(Math.round((window.devicePixelRatio || 1) * 96));
function loadPreset(p: '88' | '65') {
  const spec = p === '88' ? PRESET_88 : PRESET_65;
  for (const f of SPEC_FIELDS) {
    const el = $(f) as HTMLInputElement;
    if (el) el.value = String(spec[f]);
  }
}

function readSpec(): RollSpec {
  const base = $<HTMLSelectElement>('preset').value === '88' ? PRESET_88 : PRESET_65;
  const spec = { ...base } as RollSpec;
  for (const f of SPEC_FIELDS) {
    const v = num(f);
    if (Number.isFinite(v)) (spec[f] as number) = v;
  }
  return spec;
}

function relayout() {
  if (!midi) return;
  const t0 = performance.now();
  layout = layoutRoll(midi, readSpec());
  const ms = performance.now() - t0;

  const L = layout;
  $('stats').textContent =
    `音符 ${L.stats.notes} → 孔 ${L.stats.holes}(缩短 ${L.stats.shortened},丢弃 ${L.stats.dropped})\n` +
    `纸速 ${L.paperSpeedMmS.toFixed(1)} mm/s · 卷长 ${(L.totalLengthMm / 1000).toFixed(2)} m\n` +
    `力度档 ≈ [${L.dynLevelValues.join(', ')}] · 排版耗时 ${ms.toFixed(0)} ms`;
  $('warnings').textContent = L.warnings.join('\n');
  renderer.setLayout(L);
  $('status').textContent = `排版完成,耗时 ${ms.toFixed(0)} ms`;
}

// ---- 事件 ----
$('preset').addEventListener('change', () => {
  loadPreset($<HTMLSelectElement>('preset').value as '88' | '65');
  relayout();
});
for (const f of SPEC_FIELDS) {
  const el = $(f);
  if (el) el.addEventListener('change', relayout);
}
$('btn-relayout').addEventListener('click', relayout);

$('file').addEventListener('change', async () => {
  const input = $('file') as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  try {
    midi = parseMidi(await file.arrayBuffer());
    midiName = file.name.replace(/\.[^.]+$/, '');
    $('midi-info').textContent =
      `${midi.name} · ${midi.notes.length} 音符 · ${midi.pedals.length} 段踏板 · ${midi.durationSec.toFixed(1)} 秒`;
    relayout();
  } catch (e) {
    $('midi-info').textContent = `解析失败:${(e as Error).message}`;
  }
});

$('btn-demo').addEventListener('click', () => {
  try {
    midi = parseMidi(buildDemoMidi());
    midiName = 'demo';
    $('midi-info').textContent =
      `示例曲 · ${midi.notes.length} 音符 · ${midi.pedals.length} 段踏板 · ${midi.durationSec.toFixed(1)} 秒`;
    relayout();
  } catch (e) {
    $('midi-info').textContent = `示例曲生成失败:${(e as Error).message}`;
  }
});

$('btn-fit').addEventListener('click', () => renderer.fitWidth());
$('btn-actual').addEventListener('click', () => {
  renderer.screenDpi = num('dpi') || 96;
  renderer.actualSize();
});
$('btn-zoom-in').addEventListener('click', () => {
  const c = $('roll');
  renderer.zoomAt(1.3, c.clientWidth / 2, c.clientHeight / 2);
});
$('btn-zoom-out').addEventListener('click', () => {
  const c = $('roll');
  renderer.zoomAt(1 / 1.3, c.clientWidth / 2, c.clientHeight / 2);
});
$('dpi').addEventListener('change', () => {
  renderer.screenDpi = num('dpi') || 96;
});
$('btn-csv').addEventListener('click', () => layout && download(`${midiName}.csv`, toCSV(layout), 'text/csv'));
$('btn-json').addEventListener('click', () => layout && download(`${midiName}.json`, toJSON(layout), 'application/json'));
$('btn-dxf').addEventListener('click', () => layout && download(`${midiName}.dxf`, toDXF(layout), 'application/dxf'));

loadPreset('88');
