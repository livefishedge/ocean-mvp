// Simplified mobile UV arrow renderer — draws arrows on top of the existing canvas using
// native canvas 2D strokes (no per-pixel manipulation, no getImageData/putImageData).
// This avoids the Safari freezing issue while still showing current direction.
function drawMobileUvArrowsLite(ctx, dataObj, z, xAxis, yAxis, xAscending, yAscending, yFlip) {
  const d = (dataObj && dataObj.data && !Array.isArray(dataObj.data)) ? dataObj.data : dataObj;
  const u = d?.u || dataObj?.meta?.grid?.u;
  const v = d?.v || dataObj?.meta?.grid?.v;
  if (!is2D(u) || !is2D(v)) return;
  const ny = z.length;
  const nx = z[0].length;

  // Grid → pixel sizes
  const sx = ctx.canvas.width  / Math.max(1, nx - 1);
  const sy = ctx.canvas.height / Math.max(1, ny - 1);

  // Sparse enough to be cheap; dense enough to show the flow
  const step = Math.max(4, Math.floor(Math.sqrt(nx * ny) / 20));

  // Style
  ctx.save();
  ctx.strokeStyle = "rgba(255,255,255,0.55)";
  ctx.lineWidth   = 1.2;
  ctx.lineCap     = "round";
  ctx.lineJoin    = "round";

  for (let row = 0; row < ny; row += step) {
    const srcJ = yFlip ? (ny - 1 - row) : row;
    for (let col = 0; col < nx; col += step) {
      const srcI = xAscending ? col : (nx - 1 - col);
      const uu = u[srcJ]?.[srcI];
      const vv = v[srcJ]?.[srcI];
      if (!isFinite(uu) || !isFinite(vv)) continue;

      // Tail and tip in canvas pixel coords
      const x0 = col * sx;
      const y0 = row * sy;
      const x1 = x0 + uu * sx * 6;   // SCALE=6 keeps arrows short enough
      const y1 = y0 - vv * sy * 6;   // flip vv (lat increases upward in data, canvas y is inverted)

      // Skip near-zero
      const dx = x1 - x0, dy = y1 - y0;
      if (Math.hypot(dx, dy) < 1.5) continue;

      // Shaft
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();

      // Arrowhead
      const angle = Math.atan2(dy, dx);
      const hs    = 5;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x1 - hs * Math.cos(angle - Math.PI / 6),
                y1 - hs * Math.sin(angle - Math.PI / 6));
      ctx.lineTo(x1 - hs * Math.cos(angle + Math.PI / 6),
                y1 - hs * Math.sin(angle + Math.PI / 6));
      ctx.closePath();
      ctx.fillStyle = "rgba(255,255,255,0.55)";
      ctx.fill();
    }
  }
  ctx.restore();
}