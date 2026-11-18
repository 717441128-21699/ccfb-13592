// Canvas 渲染:纸卷俯视图,支持缩放/平移/1:1 打印比例,只画可视区域内的孔。
import type { RollLayout, HoleKind } from './layout';

const COLORS: Record<HoleKind, string> = {
  note: '#1a1a1a',
  dynBass: '#b3541e',
  dynTreble: '#1e6fb3',
  pedal: '#3d8b37',
};

export class RollRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private layout: RollLayout | null = null;
  // 视口:scale = 屏幕像素/毫米,offsetX/Y = 纸面原点(左上角)在屏幕上的位置
  scale = 4;
  offsetX = 40;
  offsetY = 40;
  screenDpi = 96; // 用于 1:1 显示,可由用户校准
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private hoverInfo: ((text: string) => void) | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.bindEvents();
    new ResizeObserver(() => this.draw()).observe(canvas.parentElement!);
  }

  setLayout(layout: RollLayout) {
    this.layout = layout;
    this.fitWidth();
  }

  onHover(cb: (text: string) => void) { this.hoverInfo = cb; }

  /** 适配纸宽 */
  fitWidth() {
    if (!this.layout) return;
    const w = this.canvas.parentElement!.clientWidth;
    this.scale = (w - 80) / this.layout.spec.paperWidthMm;
    this.offsetX = 40;
    this.offsetY = 40;
    this.draw();
  }

  /** 1:1:屏幕上 1 毫米 = 真实 1 毫米(按校准后的屏幕 DPI) */
  actualSize() {
    this.scale = this.screenDpi / 25.4;
    this.draw();
  }

  zoomAt(factor: number, cx: number, cy: number) {
    const ns = Math.min(200, Math.max(0.2, this.scale * factor));
    const k = ns / this.scale;
    this.offsetX = cx - (cx - this.offsetX) * k;
    this.offsetY = cy - (cy - this.offsetY) * k;
    this.scale = ns;
    this.draw();
  }

  private bindEvents() {
    const c = this.canvas;
    c.addEventListener('mousedown', e => {
      this.dragging = true;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
    });
    window.addEventListener('mouseup', () => (this.dragging = false));
    window.addEventListener('mousemove', e => {
      if (this.dragging) {
        this.offsetX += e.clientX - this.lastX;
        this.offsetY += e.clientY - this.lastY;
        this.lastX = e.clientX;
        this.lastY = e.clientY;
        this.draw();
      } else if (this.hoverInfo && this.layout) {
        const mx = e.clientX - c.getBoundingClientRect().left;
        const my = e.clientY - c.getBoundingClientRect().top;
        this.hoverInfo(this.hitTest(mx, my));
      }
    });
    c.addEventListener('wheel', e => {
      e.preventDefault();
      const r = c.getBoundingClientRect();
      this.zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });
  }

  private hitTest(px: number, py: number): string {
    if (!this.layout) return '';
    const xMm = (px - this.offsetX) / this.scale;
    const yMm = (py - this.offsetY) / this.scale;
    // 二分定位 y 附近的孔
    const holes = this.layout.holes;
    let lo = 0, hi = holes.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (holes[mid].yMm <= yMm) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    for (let i = Math.max(0, ans - 200); i <= Math.min(holes.length - 1, ans + 1); i++) {
      const h = holes[i];
      if (h.yMm > yMm) break;
      if (yMm >= h.yMm && yMm <= h.yMm + h.lenMm &&
          xMm >= h.xMm - h.widthMm / 2 && xMm <= h.xMm + h.widthMm / 2) {
        const t = this.layout.tracks[h.track];
        return `${t.label} | y=${h.yMm.toFixed(1)}mm 长=${h.lenMm.toFixed(1)}mm ${h.label ?? ''}`;
      }
    }
    return `x=${xMm.toFixed(1)}mm y=${yMm.toFixed(1)}mm`;
  }

  draw() {
    const parent = this.canvas.parentElement!;
    const dpr = window.devicePixelRatio || 1;
    const w = parent.clientWidth, h = parent.clientHeight;
    if (this.canvas.width !== w * dpr || this.canvas.height !== h * dpr) {
      this.canvas.width = w * dpr;
      this.canvas.height = h * dpr;
      this.canvas.style.width = w + 'px';
      this.canvas.style.height = h + 'px';
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#2b2b2b';
    ctx.fillRect(0, 0, w, h);
    if (!this.layout) return;

    const L = this.layout;
    const s = this.scale;
    const px = (mm: number) => this.offsetX + mm * s;
    const py = (mm: number) => this.offsetY + mm * s;

    // 纸面
    ctx.fillStyle = '#f5edd8';
    ctx.fillRect(px(0), py(0), L.spec.paperWidthMm * s, L.totalLengthMm * s);
    ctx.strokeStyle = '#8a7d5a';
    ctx.strokeRect(px(0), py(0), L.spec.paperWidthMm * s, L.totalLengthMm * s);

    // 可视范围(毫米)
    const y0 = (0 - this.offsetY) / s - 5;
    const y1 = (h - this.offsetY) / s + 5;

    // 轨道参考线(放大到一定程度才画)
    if (s > 6) {
      ctx.strokeStyle = 'rgba(0,0,0,0.08)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const t of L.tracks) {
        ctx.moveTo(px(t.xMm), Math.max(0, py(y0)));
        ctx.lineTo(px(t.xMm), Math.min(h, py(y1)));
      }
      ctx.stroke();
    }

    // 孔(只画可视区,二分找到起始位置)
    const holes = L.holes;
    let lo = 0, hi = holes.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (holes[mid].yMm + holes[mid].lenMm < y0) lo = mid + 1; else hi = mid;
    }
    const minPx = 0.6; // 太小的孔至少画这么点,保证可见
    for (let i = lo; i < holes.length; i++) {
      const hole = holes[i];
      if (hole.yMm > y1) break;
      const x = px(hole.xMm - hole.widthMm / 2);
      const y = py(hole.yMm);
      const hw = Math.max(minPx, hole.widthMm * s);
      const hh = Math.max(minPx, hole.lenMm * s);
      ctx.fillStyle = COLORS[hole.kind];
      // 圆角长孔
      const r = Math.min(hw / 2, hh / 2);
      ctx.beginPath();
      ctx.roundRect(x, y, hw, hh, r);
      ctx.fill();
    }

    // 左侧标尺(每 100mm 一条)
    ctx.fillStyle = '#ddd';
    ctx.strokeStyle = '#666';
    ctx.font = '11px monospace';
    ctx.textAlign = 'right';
    const stepMm = s > 2 ? 100 : 500;
    const startMark = Math.max(0, Math.floor(y0 / stepMm) * stepMm);
    for (let m = startMark; m <= Math.min(y1, L.totalLengthMm); m += stepMm) {
      const yy = py(m);
      ctx.beginPath();
      ctx.moveTo(px(0) - 8, yy);
      ctx.lineTo(px(0), yy);
      ctx.stroke();
      ctx.fillText(`${m}`, px(0) - 12, yy + 3);
    }
  }
}
