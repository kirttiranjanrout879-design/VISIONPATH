/* ═══════════════════════════════════════════════════════════════
   simulation.js — Realistic animated forward-view scene renderer
   
   Draws a procedural "flying drone" camera view:
   • Vanishing-point road/path perspective
   • Scrolling ground texture with lane markings
   • Sky gradient with subtle horizon haze
   • Depth-of-field vignette effect
   • Simulated drone drift (for deviation testing)
═══════════════════════════════════════════════════════════════ */
'use strict';

const Simulation = (() => {

  let _canvas, _ctx;
  let _running  = false;
  let _frame    = 0;
  let _rafId    = null;

  // ── Drone simulated state ────────────────────────────────────
  let _drone = {
    roll:    0,      // degrees
    pitch:   0,      // degrees
    yaw:     45,     // degrees heading
    alt:     150,    // cm AGL
    speed:   1.2,    // m/s
    drift:   0,      // lateral drift in cm (positive = right)
    driftV:  0.3,    // drift velocity cm/s
    batt:    87,     // %
    lastUpdate: Date.now(),
  };

  // Path sim
  let _pathOffset  = 0;   // horizontal offset of drawn path center (px from image center)
  let _pathOffsetV = 0;

  // ── Init ─────────────────────────────────────────────────────
  function init(canvas) {
    _canvas = canvas;
    _ctx    = canvas.getContext('2d');
  }

  function start() {
    if (_running) return;
    _running = true;
    _loop();
  }

  function stop() {
    _running = false;
    if (_rafId) cancelAnimationFrame(_rafId);
  }

  function isRunning() { return _running; }
  function getDrone()  { return { ..._drone }; }

  // ── Main render loop ─────────────────────────────────────────
  function _loop() {
    if (!_running) return;
    _update();
    _draw();
    _frame++;
    _rafId = requestAnimationFrame(_loop);
  }

  function _update() {
    const now = Date.now();
    const dt  = (now - _drone.lastUpdate) / 1000;
    _drone.lastUpdate = now;

    // Gentle roll oscillation (simulated wind)
    _drone.roll  = 2.5 * Math.sin(_frame * 0.012) + 0.8 * Math.sin(_frame * 0.031);
    _drone.pitch = 1.2 * Math.sin(_frame * 0.008) - 0.5;

    // Drift the path offset (simulates drone moving left/right of path)
    _pathOffsetV += (Math.random() - 0.5) * 0.15;
    _pathOffsetV  = clamp(_pathOffsetV, -1.5, 1.5);
    _pathOffset  += _pathOffsetV * dt * 8;
    _pathOffset   = clamp(_pathOffset, -200, 200);

    // Expose drift to telemetry
    _drone.drift = _pathOffset * 0.5; // rough scale

    // Battery drain
    _drone.batt = Math.max(0, _drone.batt - dt * 0.003);
    _drone.alt  = 150 + 8 * Math.sin(_frame * 0.005);
    _drone.speed = 1.2 + 0.3 * Math.sin(_frame * 0.02);
    _drone.yaw   = 45 + 6 * Math.sin(_frame * 0.003);
  }

  function _draw() {
    const W = _canvas.width, H = _canvas.height;
    const cx = W / 2, cy = H / 2;
    _ctx.clearRect(0, 0, W, H);

    // ── Apply roll transform ──────────────────────────────────
    _ctx.save();
    _ctx.translate(cx, cy);
    _ctx.rotate(deg2rad(_drone.roll));
    _ctx.translate(-cx, -cy);

    _drawSky(W, H);
    _drawGround(W, H);
    _drawPath(W, H);
    _drawHorizonLine(W, H);
    _drawDistanceMarkers(W, H);

    _ctx.restore();

    // ── HUD overlays (not rotated with roll) ──────────────────
    _drawHorizonReference(W, H);
    _drawSpeedAlt(W, H);
  }

  function _drawSky(W, H) {
    const hor = H * 0.42;
    const skyGrad = _ctx.createLinearGradient(0, 0, 0, hor);
    skyGrad.addColorStop(0,   '#0a1220');
    skyGrad.addColorStop(0.4, '#0d2236');
    skyGrad.addColorStop(0.8, '#1a3a5c');
    skyGrad.addColorStop(1,   '#2a5080');
    _ctx.fillStyle = skyGrad;
    _ctx.fillRect(0, 0, W, hor);

    // Sun/glow
    const sunX = W * 0.65, sunY = H * 0.22;
    const sunGrad = _ctx.createRadialGradient(sunX, sunY, 0, sunX, sunY, 120);
    sunGrad.addColorStop(0,   'rgba(255,220,100,0.25)');
    sunGrad.addColorStop(0.4, 'rgba(255,140,50,0.08)');
    sunGrad.addColorStop(1,   'transparent');
    _ctx.fillStyle = sunGrad;
    _ctx.fillRect(0, 0, W, hor);
  }

  function _drawGround(W, H) {
    const hor = H * 0.42;
    const groundGrad = _ctx.createLinearGradient(0, hor, 0, H);
    groundGrad.addColorStop(0,    '#2d4a1e');
    groundGrad.addColorStop(0.15, '#1e3312');
    groundGrad.addColorStop(0.5,  '#151f0d');
    groundGrad.addColorStop(1,    '#0c1208');
    _ctx.fillStyle = groundGrad;
    _ctx.fillRect(0, hor, W, H - hor);

    // Grid lines (perspective)
    const vp = { x: W / 2 + _pathOffset * 0.15, y: hor };
    const numLines = 14;
    _ctx.strokeStyle = 'rgba(80,140,40,0.18)';
    _ctx.lineWidth = 0.8;

    for (let i = 1; i <= numLines; i++) {
      const t    = i / numLines;
      const yPos = hor + (H - hor) * (t * t);
      const spread = (yPos - hor) / (H - hor) * (W * 0.9);
      _ctx.beginPath();
      _ctx.moveTo(vp.x - spread / 2, yPos);
      _ctx.lineTo(vp.x + spread / 2, yPos);
      _ctx.stroke();
    }

    // Longitudinal lines
    _ctx.strokeStyle = 'rgba(80,140,40,0.12)';
    const numVert = 8;
    for (let i = -numVert / 2; i <= numVert / 2; i++) {
      const baseX = W / 2 + i * (W / numVert);
      _ctx.beginPath();
      _ctx.moveTo(vp.x, hor);
      _ctx.lineTo(baseX, H);
      _ctx.stroke();
    }
  }

  function _drawPath(W, H) {
    const hor = H * 0.42;
    const vp  = { x: W / 2 + _pathOffset * 0.15, y: hor };

    // Path road surface
    const roadL  = W / 2 + _pathOffset - 80;
    const roadR  = W / 2 + _pathOffset + 80;
    const roadNL = vp.x - 3;
    const roadNR = vp.x + 3;

    _ctx.save();
    _ctx.beginPath();
    _ctx.moveTo(roadNL, hor);
    _ctx.lineTo(roadNR, hor);
    _ctx.lineTo(roadR,  H);
    _ctx.lineTo(roadL,  H);
    _ctx.closePath();

    const roadGrad = _ctx.createLinearGradient(0, hor, 0, H);
    roadGrad.addColorStop(0,   'rgba(40,50,60,0.3)');
    roadGrad.addColorStop(0.5, 'rgba(50,60,70,0.5)');
    roadGrad.addColorStop(1,   'rgba(60,70,80,0.7)');
    _ctx.fillStyle = roadGrad;
    _ctx.fill();
    _ctx.restore();

    // Edge lines
    _ctx.save();
    _ctx.lineWidth = 2;
    _ctx.strokeStyle = 'rgba(220,220,180,0.6)';
    _ctx.beginPath();
    _ctx.moveTo(roadNL, hor);
    _ctx.lineTo(roadL, H);
    _ctx.stroke();
    _ctx.beginPath();
    _ctx.moveTo(roadNR, hor);
    _ctx.lineTo(roadR, H);
    _ctx.stroke();
    _ctx.restore();

    // Dashed centre line (scrolling)
    const dashOffset = (_frame * 2.5) % 60;
    _ctx.save();
    _ctx.setLineDash([30, 30]);
    _ctx.lineDashOffset = -dashOffset;
    _ctx.strokeStyle = 'rgba(255,220,80,0.7)';
    _ctx.lineWidth = 2;
    _ctx.beginPath();
    _ctx.moveTo(vp.x, hor);
    _ctx.lineTo(W / 2 + _pathOffset, H);
    _ctx.stroke();
    _ctx.restore();
  }

  function _drawHorizonLine(W, H) {
    const hor = H * 0.42;
    const horizGrad = _ctx.createLinearGradient(0, hor - 2, 0, hor + 2);
    horizGrad.addColorStop(0, 'rgba(100,180,255,0.0)');
    horizGrad.addColorStop(0.5, 'rgba(100,200,255,0.3)');
    horizGrad.addColorStop(1, 'rgba(100,180,255,0.0)');
    _ctx.fillStyle = horizGrad;
    _ctx.fillRect(0, hor - 1, W, 3);
  }

  function _drawDistanceMarkers(W, H) {
    const hor = H * 0.42;
    const markers = [
      { dist: '50m', t: 0.3 },
      { dist: '100m', t: 0.55 },
      { dist: '200m', t: 0.75 },
      { dist: '500m', t: 0.9 },
    ];
    _ctx.fillStyle = 'rgba(0,229,255,0.5)';
    _ctx.font = '10px JetBrains Mono, monospace';
    markers.forEach(m => {
      const yPos = hor + (H - hor) * (m.t * m.t);
      const spread = (yPos - hor) / (H - hor) * (W * 0.9);
      const cx_ = W / 2 + _pathOffset * (1 - m.t * m.t);
      // Tick marks
      _ctx.fillStyle = 'rgba(0,229,255,0.4)';
      _ctx.fillRect(cx_ - spread / 2, yPos, 8, 1);
      _ctx.fillRect(cx_ + spread / 2 - 8, yPos, 8, 1);
      // Label
      _ctx.fillStyle = 'rgba(0,229,255,0.6)';
      _ctx.fillText(m.dist, cx_ + spread / 2 + 4, yPos + 4);
    });
  }

  function _drawHorizonReference(W, H) {
    const cy = H * 0.42;
    _ctx.save();
    _ctx.strokeStyle = 'rgba(0,229,255,0.25)';
    _ctx.lineWidth = 1;
    // Horizon ticks
    for (let i = -4; i <= 4; i++) {
      if (i === 0) continue;
      const yOff = i * 18;
      const tickW = i % 2 === 0 ? 60 : 30;
      _ctx.beginPath();
      _ctx.moveTo(W / 2 - tickW / 2, cy + yOff);
      _ctx.lineTo(W / 2 + tickW / 2, cy + yOff);
      _ctx.stroke();
      if (i % 2 === 0) {
        _ctx.fillStyle = 'rgba(0,229,255,0.4)';
        _ctx.font = '9px JetBrains Mono, monospace';
        _ctx.fillText(`${i > 0 ? '+' : ''}${i * 5}°`, W / 2 + tickW / 2 + 4, cy + yOff + 3);
      }
    }
    _ctx.restore();
  }

  function _drawSpeedAlt(W, H) {
    _ctx.save();
    _ctx.font = 'bold 13px JetBrains Mono, monospace';
    _ctx.fillStyle = 'rgba(0,229,255,0.6)';
    // Speed tape (left)
    _ctx.fillText(`SPD ${fmt(_drone.speed, 1)} m/s`, 12, H - 14);
    // Alt tape (right)
    const altStr = `ALT ${fmt(_drone.alt / 100, 2)} m`;
    _ctx.fillText(altStr, W - _ctx.measureText(altStr).width - 12, H - 14);
    _ctx.restore();
  }

  return { init, start, stop, isRunning, getDrone, getPathOffset: () => _pathOffset };
})();
