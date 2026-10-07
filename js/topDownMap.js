/* ═══════════════════════════════════════════════════════════════
   topDownMap.js — 2D Top-Down (Birds-Eye) Metric Path Reconstruction
   Transforms perspective camera coordinates into local metric ground plane.
═══════════════════════════════════════════════════════════════ */
'use strict';

const TopDownMap = (() => {
  let _canvas  = null;
  let _ctx     = null;
  let _visible = true;

  function init(canvasEl) {
    _canvas = canvasEl;
    if (_canvas) _ctx = _canvas.getContext('2d');
  }

  function toggle() {
    _visible = !_visible;
    const container = $('pip-map-container');
    if (container) {
      container.style.display = _visible ? 'flex' : 'none';
    }
    const btn = $('btn-toggle-map');
    if (btn) btn.classList.toggle('active', _visible);
    return _visible;
  }

  function render(waypoints, activeIdx, xteMeters, droneHeading) {
    if (!_visible || !_ctx || !_canvas) return;

    const W = _canvas.width;
    const H = _canvas.height;
    const ctx = _ctx;

    // Clear background
    ctx.fillStyle = 'rgba(8, 12, 18, 0.92)';
    ctx.fillRect(0, 0, W, H);

    // Center coordinates: Drone is positioned at lower-center
    const cx = W / 2;
    const cy = H * 0.78;

    // Scale: Pixels per real-world meter on the mini-map (e.g., 20 px = 1 meter)
    const scale = 18; // px / meter

    // ── 1. Draw Range Rings & Metric Grid ────────────────────────
    const rings = [1, 2, 4, 8]; // meters
    ctx.strokeStyle = 'rgba(0, 229, 255, 0.15)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);

    rings.forEach(r => {
      const radius = r * scale;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.stroke();

      // Range labels
      ctx.fillStyle = 'rgba(0, 229, 255, 0.45)';
      ctx.font = '8px JetBrains Mono, monospace';
      ctx.textAlign = 'left';
      ctx.fillText(`${r}m`, cx + radius + 2, cy - 2);
    });
    ctx.setLineDash([]);

    // Grid Axes
    ctx.strokeStyle = 'rgba(0, 229, 255, 0.25)';
    ctx.beginPath();
    ctx.moveTo(cx, 0); ctx.lineTo(cx, H);
    ctx.moveTo(0, cy); ctx.lineTo(W, cy);
    ctx.stroke();

    // ── 2. Project & Draw Path Waypoints ─────────────────────────
    if (waypoints && waypoints.length > 0) {
      const cal = Calibration.getState();
      const pxPerM = cal.pixelsPerMeter > 0 ? cal.pixelsPerMeter : 100;
      const overlayW = 960;
      const overlayH = 540;

      // Convert screen pixels to relative ground meters (X: lateral, Y: forward distance)
      const groundPoints = waypoints.map((wp, idx) => {
        // Lateral offset from screen center
        const dxPx = wp.x - (overlayW / 2);
        // Perspective distance from bottom of screen (inverted Y)
        const dyPx = (overlayH * 0.82) - wp.y;

        // Metric coordinates relative to drone
        const xMetric = dxPx / pxPerM;
        // Non-linear perspective compression correction for forward view
        const yMetric = Math.max(0.2, (dyPx / pxPerM) * 1.8);

        // Map to canvas coordinates
        const mapX = cx + (xMetric * scale);
        const mapY = cy - (yMetric * scale);

        return { x: mapX, y: mapY, label: wp.label, final: wp.final, reached: wp.reached, idx };
      });

      // Draw Path connecting line
      ctx.beginPath();
      ctx.strokeStyle = '#00e5ff';
      ctx.lineWidth = 2;
      ctx.shadowColor = '#00e5ff';
      ctx.shadowBlur = 6;
      groundPoints.forEach((pt, i) => {
        if (i === 0) ctx.moveTo(pt.x, pt.y);
        else ctx.lineTo(pt.x, pt.y);
      });
      ctx.stroke();
      ctx.shadowBlur = 0;

      // Draw Waypoint Nodes
      groundPoints.forEach((pt, i) => {
        const isActive = (i === activeIdx);
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, isActive ? 5 : 4, 0, Math.PI * 2);
        ctx.fillStyle = pt.final ? '#ff3a5c' : (isActive ? '#00e5ff' : '#00b0ff');
        ctx.fill();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1;
        ctx.stroke();

        // Node label
        ctx.fillStyle = isActive ? '#00e5ff' : '#8fa8c0';
        ctx.font = '8px JetBrains Mono, monospace';
        ctx.textAlign = 'center';
        ctx.fillText(pt.final ? 'LAND' : `W${i+1}`, pt.x, pt.y - 7);
      });
    }

    // ── 3. Draw Drone Marker at Center ───────────────────────────
    ctx.save();
    ctx.translate(cx, cy);

    // Cross-track error indicator line
    if (Math.abs(xteMeters) > 0.05) {
      const xtePx = xteMeters * scale;
      ctx.strokeStyle = Math.abs(xteMeters) > 2.0 ? '#ff3a5c' : '#ff9100';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(xtePx, 0);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Hexacopter / Drone Icon
    ctx.fillStyle = '#00e5ff';
    ctx.beginPath();
    ctx.moveTo(0, -9);
    ctx.lineTo(7, 7);
    ctx.lineTo(0, 4);
    ctx.lineTo(-7, 7);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.restore();

    // Map Title Badge
    ctx.fillStyle = 'rgba(0, 229, 255, 0.8)';
    ctx.font = '700 8px Orbitron, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('2D LOCAL METRIC MAP (NED)', 8, 14);
  }

  function isVisible() { return _visible; }

  return { init, toggle, render, isVisible };
})();
