// 导出:给数控冲床的孔位坐标文件(CSV / JSON / DXF)。
import type { RollLayout } from './layout';

export function toCSV(L: RollLayout): string {
  const lines = ['track,kind,x_mm,y_mm,length_mm,width_mm,label'];
  for (const h of L.holes) {
    lines.push([
      h.track, h.kind,
      h.xMm.toFixed(3), h.yMm.toFixed(3), h.lenMm.toFixed(3), h.widthMm.toFixed(3),
      h.label ?? '',
    ].join(','));
  }
  return lines.join('\n');
}

export function toJSON(L: RollLayout): string {
  return JSON.stringify({
    spec: L.spec,
    paperSpeedMmS: L.paperSpeedMmS,
    totalLengthMm: L.totalLengthMm,
    dynLevelValues: L.dynLevelValues,
    tracks: L.tracks,
    holes: L.holes,
  }, null, 2);
}

/** 简易 DXF(R12):每个孔输出为一个实心矩形(两条 LWPOLYLINE 太贵,用 SOLID) */
export function toDXF(L: RollLayout): string {
  const out: string[] = [
    '0', 'SECTION', '2', 'HEADER',
    '9', '$INSUNITS', '70', '4', // 单位:毫米
    '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES',
  ];
  const layerOf = (kind: string) =>
    kind === 'note' ? 'NOTES' : kind === 'pedal' ? 'PEDAL' : 'DYNAMICS';
  for (const h of L.holes) {
    const x0 = h.xMm - h.widthMm / 2, x1 = h.xMm + h.widthMm / 2;
    const y0 = -h.yMm, y1 = -(h.yMm + h.lenMm); // DXF y 向上,纸面向下
    out.push(
      '0', 'SOLID', '8', layerOf(h.kind),
      '10', x0.toFixed(3), '20', y0.toFixed(3), '30', '0',
      '11', x1.toFixed(3), '21', y0.toFixed(3), '31', '0',
      '12', x0.toFixed(3), '22', y1.toFixed(3), '32', '0',
      '13', x1.toFixed(3), '23', y1.toFixed(3), '33', '0',
    );
  }
  out.push('0', 'ENDSEC', '0', 'EOF');
  return out.join('\n');
}

export function download(filename: string, content: string, mime = 'text/plain') {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
