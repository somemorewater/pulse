// Hand-rolled canvas chart: home/draw/away probability over sequence.
// No charting dependency — the data is small and the shape is fixed.
const COLORS = { home: '#1d4ed8', draw: '#667085', away: '#b45309' };

export function drawProbChart(canvas, history) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  ctx.font = '11px sans-serif';

  if (!history || history.length === 0) {
    ctx.fillStyle = '#667085';
    ctx.fillText('No snapshots yet — process an event.', 12, H / 2);
    return;
  }

  const padL = 34;
  const padB = 18;
  const padT = 10;
  const plotW = W - padL - 8;
  const plotH = H - padT - padB;
  const seqs = history.map((h) => h.sequence);
  const minS = Math.min(...seqs);
  const maxS = Math.max(...seqs);
  const x = (s) => padL + (maxS === minS ? plotW / 2 : ((s - minS) / (maxS - minS)) * plotW);
  const y = (p) => padT + (1 - Math.min(1, Math.max(0, p))) * plotH;

  ctx.strokeStyle = '#dfe3ea';
  ctx.fillStyle = '#667085';
  [0, 0.25, 0.5, 0.75, 1].forEach((p) => {
    ctx.beginPath();
    ctx.moveTo(padL, y(p));
    ctx.lineTo(W - 8, y(p));
    ctx.stroke();
    ctx.fillText(`${Math.round(p * 100)}%`, 4, y(p) + 4);
  });

  const series = [
    ['home', 'home_prob'],
    ['draw', 'draw_prob'],
    ['away', 'away_prob'],
  ];
  series.forEach(([name, key]) => {
    ctx.strokeStyle = COLORS[name];
    ctx.lineWidth = 2;
    ctx.beginPath();
    history.forEach((h, i) => {
      const px = x(h.sequence);
      const py = y(h[key] ?? 0);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.stroke();
    const last = history[history.length - 1];
    ctx.fillStyle = COLORS[name];
    ctx.beginPath();
    ctx.arc(x(last.sequence), y(last[key] ?? 0), 3, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.lineWidth = 1;

  let lx = padL;
  [['home', COLORS.home], ['draw', COLORS.draw], ['away', COLORS.away]].forEach(([name, c]) => {
    ctx.fillStyle = c;
    ctx.fillRect(lx, H - 13, 10, 10);
    ctx.fillStyle = '#1c2333';
    ctx.fillText(name, lx + 14, H - 4);
    lx += 62;
  });
}
