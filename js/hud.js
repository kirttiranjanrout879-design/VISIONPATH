/* ═══════════════════════════════════════════════════════════════
   hud.js — Attitude indicator canvas renderer + telemetry HUD updater
═══════════════════════════════════════════════════════════════ */
'use strict';

const HUD = (() => {

  let _attCtx, _attCvs;
  let _roll = 0, _pitch = 0, _yaw = 0;

  function init() {
    _attCvs = $('attitude-canvas');
    if (_attCvs) _attCtx = _attCvs.getContext('2d');
  }

  // ── Update from telemetry ──────────────────────────────────────
  function updateTelemetry(t) {
    // Smooth inputs
    _roll  = lerp(_roll,  t.roll,  0.2);
    _pitch = lerp(_pitch, t.pitch, 0.2);
    _yaw   = lerp(_yaw,   t.yaw,   0.15);

    // HUD tiles
    _set('val-alt',   fmt(t.alt, 1));
    _set('val-speed', fmt(t.airspeed, 1));
    _set('val-hdg',   fmt(_yaw, 0));
    _set('val-pitch', fmt(_pitch, 1));
    _set('val-roll',  fmt(_roll, 1));
    _set('val-batt',  fmt(t.battery, 0));
    _set('val-mode',  t.mode);

    // Battery bar
    const battBar = $('batt-bar');
    if (battBar) {
      battBar.style.width = `${clamp(t.battery, 0, 100)}%`;
      battBar.style.opacity = t.battery < 20 ? (Math.sin(Date.now() * 0.005) * 0.5 + 0.75).toString() : '1';
    }

    // Mode badge class
    const modeEl = $('val-mode');
    if (modeEl) {
      modeEl.className = 'tile-value mode-badge';
      if (t.armed && t.mode !== 'DISARMED') modeEl.classList.add('armed');
      if (t.mode === 'GUIDED' || t.mode === 'AUTO') modeEl.classList.add('following');
      if (t.mode === 'LAND' || t.mode === 'RTL')    modeEl.classList.add('landing');
    }

    // ARM button
    const armBtn = $('btn-arm');
    if (armBtn) {
      armBtn.textContent = t.armed ? 'DISARM' : 'ARM';
      armBtn.classList.toggle('armed', t.armed);
    }

    // Info bar altitude
    const cibAlt = $('cib-alt');
    if (cibAlt) cibAlt.textContent = `${fmt(t.alt, 2)} m`;

    // Status bar system status
    const sbSys = $('sb-sys');
    if (sbSys) {
      sbSys.textContent = t.armed
        ? (t.mode === 'LAND' ? 'LANDING' : t.mode === 'RTL' ? 'RTL' : 'FLYING')
        : 'STANDBY';
      sbSys.style.color = t.armed ? 'var(--c-ok)' : 'var(--c-text-dim)';
    }

    // Attitude panel
    _set('att-pitch', `${fmt(_pitch, 1)}°`);
    _set('att-roll',  `${fmt(_roll, 1)}°`);
    _set('att-yaw',   `${fmt(_yaw, 0)}°`);

    // Render attitude ball
    if (_attCtx) _drawAttitude();
  }

  // ── Attitude Indicator (artificial horizon) ───────────────────
  function _drawAttitude() {
    const cvs = _attCvs;
    const ctx = _attCtx;
    const W = cvs.width, H = cvs.height;
    const cx = W / 2, cy = H / 2;
    const R = Math.min(W, H) / 2 - 4;

    ctx.clearRect(0, 0, W, H);

    // Clip to circle
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.clip();

    // Apply roll rotation
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(deg2rad(-_roll));
    ctx.translate(-cx, -cy);

    // Pitch offset (positive pitch = horizon moves down)
    const pitchPx = (_pitch / 90) * R * 1.5;

    // Sky
    const skyGrad = ctx.createLinearGradient(0, cy + pitchPx - R, 0, cy + pitchPx);
    skyGrad.addColorStop(0, '#0a2040');
    skyGrad.addColorStop(1, '#1a4a80');
    ctx.fillStyle = skyGrad;
    ctx.fillRect(0, 0, W, cy + pitchPx);

    // Ground
    const gndGrad = ctx.createLinearGradient(0, cy + pitchPx, 0, cy + pitchPx + R);
    gndGrad.addColorStop(0, '#3a2010');
    gndGrad.addColorStop(1, '#1a0e08');
    ctx.fillStyle = gndGrad;
    ctx.fillRect(0, cy + pitchPx, W, H);

    // Horizon line
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, cy + pitchPx);
    ctx.lineTo(W, cy + pitchPx);
    ctx.stroke();

    // Pitch ladder
    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    ctx.lineWidth = 1;
    ctx.font = '7px JetBrains Mono, monospace';
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    for (let p = -30; p <= 30; p += 10) {
      if (p === 0) continue;
      const py = cy + pitchPx - (p / 90) * R * 1.5;
      const lw = Math.abs(p) === 10 ? 20 : 30;
      ctx.beginPath();
      ctx.moveTo(cx - lw, py);
      ctx.lineTo(cx + lw, py);
      ctx.stroke();
      ctx.fillText(`${p > 0 ? '+' : ''}${p}`, cx + lw + 2, py + 3);
    }

    ctx.restore(); // undo pitch/roll transform

    // Bank angle arc
    const bankRad = deg2rad(-_roll);
    ctx.strokeStyle = 'rgba(255,220,0,0.6)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(cx, cy, R - 8, -Math.PI / 2 - deg2rad(60), -Math.PI / 2 + deg2rad(60));
    ctx.stroke();

    // Bank indicator triangle
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(bankRad);
    ctx.translate(0, -(R - 8));
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(-5, 8);
    ctx.lineTo(5, 8);
    ctx.closePath();
    ctx.fillStyle = 'rgba(255,220,0,0.8)';
    ctx.fill();
    ctx.restore();

    ctx.restore(); // undo clip

    // Fixed aircraft symbol (not rotated)
    ctx.strokeStyle = '#ffdc00';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx - 20, cy);
    ctx.lineTo(cx - 6,  cy);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx + 6,  cy);
    ctx.lineTo(cx + 20, cy);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, 3, 0, Math.PI * 2);
    ctx.strokeStyle = '#ffdc00';
    ctx.stroke();

    // Compass rose (heading)
    ctx.save();
    ctx.translate(cx, cy);
    ctx.font = 'bold 7px Orbitron, monospace';
    ctx.fillStyle = 'rgba(0,229,255,0.8)';
    ctx.textAlign = 'center';
    const dirs = ['N', 'E', 'S', 'W'];
    dirs.forEach((d, i) => {
      const ang = deg2rad(i * 90 - _yaw);
      const rx  = Math.cos(ang - Math.PI / 2) * (R - 6);
      const ry  = Math.sin(ang - Math.PI / 2) * (R - 6);
      ctx.fillText(d, rx, ry + 3);
    });
    ctx.restore();

    // Outer ring
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(0,229,255,0.3)';
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // ── Scale ruler renderer ───────────────────────────────────────
  function drawScaleRuler() {
    const cvs = $('scale-ruler');
    if (!cvs) return;
    const ctx = cvs.getContext('2d');
    const W = cvs.width, H = cvs.height;
    ctx.clearRect(0, 0, W, H);

    const cal = Calibration.getState();
    if (!cal.calibrated || !cal.groundWidthM) return;

    // Draw a scale bar showing real-world distance
    const totalWidthM = cal.groundWidthM;
    // Pick a nice round number
    const niceM = _niceNumber(totalWidthM * 0.4);
    const barLenPx = (niceM / totalWidthM) * W;

    ctx.strokeStyle = 'rgba(0,229,255,0.8)';
    ctx.lineWidth = 2;
    // Main bar
    ctx.beginPath();
    ctx.moveTo(4, H / 2);
    ctx.lineTo(4 + barLenPx, H / 2);
    ctx.stroke();
    // End caps
    [[4, H / 2 - 4, 4, H / 2 + 4], [4 + barLenPx, H / 2 - 4, 4 + barLenPx, H / 2 + 4]].forEach(([x1,y1,x2,y2]) => {
      ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(x2,y2); ctx.stroke();
    });
    // Label
    ctx.fillStyle = 'rgba(0,229,255,0.7)';
    ctx.font = '8px JetBrains Mono, monospace';
    ctx.textAlign = 'left';
    ctx.fillText(`${niceM < 1 ? (niceM * 100).toFixed(0) + 'cm' : niceM.toFixed(0) + 'm'}`, 4 + barLenPx + 4, H / 2 + 3);
  }

  function _niceNumber(x) {
    const exp = Math.floor(Math.log10(x));
    const base = 10 ** exp;
    if (x / base < 2) return base;
    if (x / base < 5) return 2 * base;
    return 5 * base;
  }

  function _set(id, val) {
    const el = $(id);
    if (el) el.textContent = val;
  }

  return { init, updateTelemetry, drawScaleRuler };
})();
