/* ═══════════════════════════════════════════════════════════════
   topDownMap.js — 2D Top-Down (Birds-Eye) Metric Ground Map
   Renders real-time drone displacement, active trajectory,
   exact segment distances, and heading orientation in local NED space.
═══════════════════════════════════════════════════════════════ */
'use strict';

const TopDownMap = (() => {
  let _canvas  = null;
  let _ctx     = null;
  let _visible = true;
  let _trail   = [];    // [{x, y}] historic drone positions
  let _maxTrail = 80;

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

  function resetTrail() {
    _trail = [];
  }

  function render(waypoints, activeIdx, xteMeters, droneHeading, droneMetricPos) {
    if (!_visible || !_ctx || !_canvas) return;

    const W = _canvas.width;
    const H = _canvas.height;
    const ctx = _ctx;

    // Clear background
    ctx.fillStyle = 'rgba(8, 12, 20, 0.94)';
    ctx.fillRect(0, 0, W, H);

    // Map origin / drone starting reference point (lower-center)
    const originX = W / 2;
    const originY = H * 0.82;

    // Scale: Pixels per real-world meter on the mini-map (e.g., 18 px = 1 meter)
    const scale = 18; // px / meter

    // Current drone position in local metric coordinates
    const dPos = droneMetricPos || (PathManager.getDronePos ? PathManager.getDronePos() : { x: 0, y: 0 });
    const droneMapX = originX + (dPos.x * scale);
    const droneMapY = originY - (dPos.y * scale);

    // Record trail
    if (_trail.length === 0 || dist2d(_trail[_trail.length-1].x, _trail[_trail.length-1].y, droneMapX, droneMapY) > 2) {
      _trail.push({ x: droneMapX, y: droneMapY });
      if (_trail.length > _maxTrail) _trail.shift();
    }

    // ── 1. Draw Range Rings & Metric Grid ────────────────────────
    const rings = [1, 2, 4, 8]; // meters
    ctx.strokeStyle = 'rgba(0, 229, 255, 0.12)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);

    rings.forEach(r => {
      const radius = r * scale;
      ctx.beginPath();
      ctx.arc(originX, originY, radius, 0, Math.PI * 2);
      ctx.stroke();

      // Range labels
      ctx.fillStyle = 'rgba(0, 229, 255, 0.45)';
      ctx.font = '8px JetBrains Mono, monospace';
      ctx.textAlign = 'left';
      ctx.fillText(`${r}m`, originX + radius + 2, originY - 2);
    });
    ctx.setLineDash([]);

    // Origin Axes
    ctx.strokeStyle = 'rgba(0, 229, 255, 0.2)';
    ctx.beginPath();
    ctx.moveTo(originX, 0); ctx.lineTo(originX, H);
    ctx.moveTo(0, originY); ctx.lineTo(W, originY);
    ctx.stroke();

    // ── 2. Draw Drone Breadcrumb Trail ───────────────────────────
    if (_trail.length > 1) {
      ctx.beginPath();
      ctx.strokeStyle = 'rgba(0, 255, 153, 0.35)';
      ctx.lineWidth = 1.5;
      _trail.forEach((pt, i) => {
        if (i === 0) ctx.moveTo(pt.x, pt.y);
        else ctx.lineTo(pt.x, pt.y);
      });
      ctx.stroke();
    }

    // ── 3. Draw Path Waypoints & Connecting Segments ─────────────
    if (waypoints && waypoints.length > 0) {
      const groundPoints = waypoints.map((wp, idx) => {
        const mapX = originX + (wp.metricX * scale);
        const mapY = originY - (wp.metricY * scale);
        return {
          x: mapX,
          y: mapY,
          label: wp.label,
          final: wp.final,
          reached: wp.reached,
          dist: wp.distFromPrev,
          turn: wp.turnAngleDeg,
          idx
        };
      });

      // Connecting Path Lines
      ctx.beginPath();
      ctx.strokeStyle = '#00e5ff';
      ctx.lineWidth = 2;
      ctx.shadowColor = '#00e5ff';
      ctx.shadowBlur = 6;

      // From origin to WP-1
      ctx.moveTo(originX, originY);
      groundPoints.forEach((pt) => {
        ctx.lineTo(pt.x, pt.y);
      });
      ctx.stroke();
      ctx.shadowBlur = 0;

      // Draw active segment line from drone directly to active waypoint
      if (PathManager.isFollowing() && activeIdx < groundPoints.length) {
        const activePt = groundPoints[activeIdx];
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(droneMapX, droneMapY);
        ctx.lineTo(activePt.x, activePt.y);
        ctx.strokeStyle = '#00ff99';
        ctx.lineWidth = 2;
        ctx.setLineDash([3, 3]);
        ctx.shadowColor = '#00ff99';
        ctx.shadowBlur = 8;
        ctx.stroke();
        ctx.restore();
      }

      // Waypoint Nodes
      groundPoints.forEach((pt, i) => {
        const isActive = (i === activeIdx && PathManager.isFollowing());
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, isActive ? 6 : 4.5, 0, Math.PI * 2);
        ctx.fillStyle = pt.reached ? '#6c757d' : pt.final ? '#ff3a5c' : (isActive ? '#00ff99' : '#00e5ff');
        ctx.fill();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1;
        ctx.stroke();

        // Node Distance & Label
        ctx.fillStyle = isActive ? '#00ff99' : '#a0aec0';
        ctx.font = '8px JetBrains Mono, monospace';
        ctx.textAlign = 'center';
        const labelText = pt.final ? 'LAND' : `W${i+1} (${fmt(pt.dist, 1)}m)`;
        ctx.fillText(labelText, pt.x, pt.y - 7);
      });
    }

    // ── 4. Draw Live Moving Drone Marker at (droneMapX, droneMapY)
    ctx.save();
    ctx.translate(droneMapX, droneMapY);

    // Rotate to live heading
    const hdgRad = deg2rad(droneHeading || 0);
    ctx.rotate(hdgRad);

    // Forward heading ray
    ctx.strokeStyle = 'rgba(0, 255, 153, 0.6)';
    ctx.lineWidth = 1.2;
    ctx.setLineDash([2, 2]);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, -18);
    ctx.stroke();
    ctx.setLineDash([]);

    // Hexacopter / Drone Icon
    ctx.fillStyle = PathManager.isFollowing() ? '#00ff99' : '#00e5ff';
    ctx.beginPath();
    ctx.moveTo(0, -10);
    ctx.lineTo(7, 8);
    ctx.lineTo(0, 4);
    ctx.lineTo(-7, 8);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.2;
    ctx.shadowColor = PathManager.isFollowing() ? '#00ff99' : '#00e5ff';
    ctx.shadowBlur = 8;
    ctx.stroke();

    ctx.restore();

    // ── 5. Map Title & Telemetry Overlay ─────────────────────────
    ctx.fillStyle = 'rgba(0, 229, 255, 0.9)';
    ctx.font = '700 8px Orbitron, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('2D METRIC TRACK (NED)', 8, 14);

    ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
    ctx.font = '8px JetBrains Mono, monospace';
    ctx.fillText(`POS: ${fmt(dPos.x, 2)}m, ${fmt(dPos.y, 2)}m | HDG: ${fmt(droneHeading || 0, 0)}°`, 8, H - 8);
  }

  function isVisible() { return _visible; }

  return { init, toggle, render, isVisible, resetTrail };
})();
