/* ═══════════════════════════════════════════════════════════════
   deviation.js — Deviation gauge, direction indicator, auto-correct
   
   Computes real-world cross-track error from:
   - Path manager pixel deviation
   - Calibration px→m conversion
   
   Renders the deviation gauge using Canvas 2D API.
   Triggers auto-correction when threshold is exceeded.
═══════════════════════════════════════════════════════════════ */
'use strict';

const DeviationEngine = (() => {

  // ── State ─────────────────────────────────────────────────────
  let _xteM      = 0;    // cross-track error in meters (signed)
  let _atePx     = 0;    // along-track (pixels)
  let _side      = 'none';
  let _correcting = false;
  let _threshM   = 2.0; // auto-correct threshold (meters)
  let _gaugeCtx, _gaugeCanvas;

  // Smoothing
  let _xteSmoothed = 0;
  const SMOOTH_K   = 0.15;

  // ── Init ──────────────────────────────────────────────────────
  function init() {
    _gaugeCanvas = $('dev-gauge');
    if (_gaugeCanvas) _gaugeCtx = _gaugeCanvas.getContext('2d');
  }

  // ── Update (called every frame) ───────────────────────────────
  function update(xtePixels, atePixels, side) {
    // Convert pixel deviation to meters using calibration
    const cal = Calibration.getState();
    _xteM = cal.calibrated && cal.pixelsPerMeter
          ? xtePixels / cal.pixelsPerMeter
          : xtePixels * 0.002; // rough fallback: 1px ≈ 2mm at 1.5m alt

    _atePx = atePixels;
    _side  = side;

    // Smooth the displayed value
    _xteSmoothed = lerp(_xteSmoothed, _xteM, SMOOTH_K);

    // Update UI
    _updateHUD();
    _checkAutoCorrect();
    if (_gaugeCtx) _drawGauge();
  }

  function setThreshold(m) { _threshM = m; }
  function getXteM()       { return _xteSmoothed; }

  // ── HUD updates ───────────────────────────────────────────────
  function _updateHUD() {
    const absM = Math.abs(_xteSmoothed);
    const dir  = _side;

    // Top HUD
    const devEl = $('val-dev');
    if (devEl) {
      devEl.textContent = fmt(absM, 2);
      const tile = $('hud-dev');
      if (tile) tile.classList.toggle('alert', absM > _threshM);
    }

    // Status bar correction indicator
    const corrEl = $('sb-corr');
    if (corrEl) {
      if (dir === 'none' || absM < 0.05) {
        corrEl.textContent = 'ON PATH';
        corrEl.className = 'sb-val corr-val none';
      } else if (dir === 'left') {
        corrEl.textContent = '← CORRECT RIGHT';
        corrEl.className = 'sb-val corr-val right';
      } else {
        corrEl.textContent = '→ CORRECT LEFT';
        corrEl.className = 'sb-val corr-val left';
      }
    }

    // Deviation panel stats
    const xteEl  = $('stat-xte');
    const ateEl  = $('stat-ate');
    const corrLbl = $('stat-corr');
    const dirLabel = $('dir-label');
    const dirArrow = $('dir-arrow');

    if (xteEl) xteEl.textContent = `${fmt(_xteSmoothed, 2)} m`;
    if (ateEl) {
      const cal = Calibration.getState();
      const atM = cal.calibrated && cal.pixelsPerMeter ? _atePx / cal.pixelsPerMeter : 0;
      ateEl.textContent = `${fmt(atM, 2)} m`;
    }

    if (corrLbl) {
      corrLbl.textContent = dir === 'none' ? 'NONE' :
                            dir === 'left' ? 'STEER RIGHT ›' : '‹ STEER LEFT';
      corrLbl.style.color = dir === 'none' ? 'var(--c-ok)' : 'var(--c-warn)';
    }

    if (dirLabel) {
      if (dir === 'none' || absM < 0.05) {
        dirLabel.textContent = 'ON PATH';
        dirLabel.className = 'dir-label';
      } else if (dir === 'left') {
        dirLabel.textContent = '← DRIFTED LEFT';
        dirLabel.className = 'dir-label left';
      } else {
        dirLabel.textContent = 'DRIFTED RIGHT →';
        dirLabel.className = 'dir-label right';
      }
      if (absM > _threshM) {
        dirLabel.className += ' warning';
      }
    }

    if (dirArrow) {
      dirArrow.style.color = dir === 'none' ? 'var(--c-ok)' :
                             absM > _threshM ? 'var(--c-danger)' : 'var(--c-warn)';
      dirArrow.textContent  = dir === 'none' ? '▲' :
                              dir === 'left' ? '▶ →' : '← ◀';
    }

    // Warning banner
    const banner = $('warning-banner');
    const warnText = $('warning-text');
    if (banner && warnText) {
      if (absM > _threshM) {
        banner.classList.remove('hidden');
        const side = dir === 'left' ? 'LEFT → CORRECT RIGHT' : 'RIGHT → CORRECT LEFT';
        warnText.textContent = `⚠ DEVIATION ${fmt(absM,2)}m — DRONE DRIFTED ${side}`;
      } else {
        banner.classList.add('hidden');
      }
    }
  }

  // ── Auto-correct logic ────────────────────────────────────────
  function _checkAutoCorrect() {
    const absM = Math.abs(_xteSmoothed);
    if (!Settings.get('autoCorrect')) return;
    if (!PathManager.isFollowing()) return;

    if (absM > _threshM && !_correcting) {
      _correcting = true;
      _sendCorrection();
    } else if (absM < _threshM * 0.4 && _correcting) {
      _correcting = false;
      MAVLink.log('TX', 'POSITION_TARGET_GLOBAL_INT HOLD');
      toast('✓ Path correction complete', 'ok', 2000);
      $('sb-auto').textContent  = 'CORRECTING…';
    }

    $('sb-auto').textContent  = _correcting ? '● CORRECTING' : Settings.get('autoCorrect') ? 'ON' : 'OFF';
    $('sb-auto').style.color  = _correcting ? 'var(--c-warn)' : '';
  }

  function _sendCorrection() {
    const cal = Calibration.getState();
    const maxAngleDeg = Settings.get('maxAngle') || 15;

    // Calculate correction angle proportional to deviation
    const corrAngle = clamp(Math.abs(_xteSmoothed) * 3, 0, maxAngleDeg);
    const dir = _side === 'left' ? 'RIGHT' : 'LEFT';

    MAVLink.log('TX', `SET_POSITION_TARGET_LOCAL_NED vx=${dir==='RIGHT'?'+':'-'}${fmt(corrAngle*0.05,2)} vy=0`);
    MAVLink.log('TX', `CMD_CONDITION_YAW ${dir==='RIGHT' ? corrAngle : -corrAngle} rel=1`);
    toast(`⟳ Auto-correcting ${dir} (${fmt(corrAngle,1)}°)`, 'warn', 2000);
    $('sb-cmd').textContent = `CORRECT_${dir}`;
  }

  // ── Gauge rendering ───────────────────────────────────────────
  function _drawGauge() {
    const cvs = _gaugeCanvas, ctx = _gaugeCtx;
    const W = cvs.width, H = cvs.height;
    ctx.clearRect(0, 0, W, H);

    const cx   = W / 2;
    const cy   = H / 2;
    const maxM = 5; // ±5 meters full scale
    const barH = H * 0.75;
    const barW = 14;

    // Background track
    const trackX = cx - barW / 2;
    const trackY = cy - barH / 2;

    // Gradient background track
    const bgGrad = ctx.createLinearGradient(0, trackY, 0, trackY + barH);
    bgGrad.addColorStop(0,   'rgba(255,58,92,0.3)');
    bgGrad.addColorStop(0.5, 'rgba(0,229,255,0.08)');
    bgGrad.addColorStop(1,   'rgba(255,58,92,0.3)');
    ctx.fillStyle = bgGrad;
    _roundRect(ctx, trackX, trackY, barW, barH, 7);
    ctx.fill();

    // Track border
    ctx.strokeStyle = 'rgba(0,229,255,0.15)';
    ctx.lineWidth = 1;
    _roundRect(ctx, trackX, trackY, barW, barH, 7);
    ctx.stroke();

    // Tick marks
    ctx.font = '8px JetBrains Mono, monospace';
    ctx.textAlign = 'right';
    for (let i = -maxM; i <= maxM; i++) {
      const yPos  = trackY + barH / 2 - (i / maxM) * (barH / 2);
      const isMaj = i % 1 === 0;
      const tickW = isMaj ? 6 : 3;

      ctx.fillStyle = i === 0 ? 'rgba(0,229,255,0.5)' : 'rgba(255,255,255,0.15)';
      ctx.fillRect(trackX - tickW - 2, yPos - 0.5, tickW, 1);

      if (Math.abs(i) <= maxM) {
        ctx.fillStyle = i === 0 ? 'rgba(0,229,255,0.7)' : 'rgba(200,200,200,0.4)';
        ctx.fillText(Math.abs(i), trackX - tickW - 5, yPos + 3);
      }
    }

    // Threshold zones (red shading)
    const threshFrac = _threshM / maxM;
    const threshPx   = threshFrac * (barH / 2);
    ctx.fillStyle = 'rgba(255,58,92,0.12)';
    ctx.fillRect(trackX, trackY, barW, threshPx); // top danger zone
    ctx.fillRect(trackX, trackY + barH - threshPx, barW, threshPx); // bottom danger zone

    // Threshold lines
    ctx.strokeStyle = 'rgba(255,58,92,0.5)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(trackX - 4, cy - threshPx);
    ctx.lineTo(trackX + barW + 4, cy - threshPx);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(trackX - 4, cy + threshPx);
    ctx.lineTo(trackX + barW + 4, cy + threshPx);
    ctx.stroke();
    ctx.setLineDash([]);

    // Active bar (filled region from center to current XTE)
    const xteClamp = clamp(_xteSmoothed, -maxM, maxM);
    const barLen   = Math.abs(xteClamp / maxM) * (barH / 2);
    const barY     = xteClamp >= 0 ? cy - barLen : cy;
    const barGrad  = ctx.createLinearGradient(0, cy, 0, barY + (xteClamp >= 0 ? 0 : barLen));
    barGrad.addColorStop(0,   'rgba(0,229,255,0.6)');
    barGrad.addColorStop(1,   Math.abs(_xteSmoothed) > _threshM ? 'rgba(255,58,92,0.9)' : 'rgba(0,229,255,0.2)');
    ctx.fillStyle = barGrad;
    ctx.fillRect(trackX, Math.min(barY, cy), barW, barLen);

    // Needle / indicator marker
    const needleY = cy - (xteClamp / maxM) * (barH / 2);
    ctx.save();
    ctx.fillStyle = Math.abs(_xteSmoothed) > _threshM ? '#ff3a5c' : '#00e5ff';
    ctx.shadowColor = ctx.fillStyle;
    ctx.shadowBlur  = 8;
    // Diamond shape
    ctx.beginPath();
    ctx.moveTo(cx, needleY - 5);
    ctx.lineTo(cx + 8, needleY);
    ctx.lineTo(cx, needleY + 5);
    ctx.lineTo(cx - 8, needleY);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // Center zero line
    ctx.strokeStyle = 'rgba(0,229,255,0.4)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(trackX - 6, cy);
    ctx.lineTo(trackX + barW + 6, cy);
    ctx.stroke();

    // Value readout
    ctx.fillStyle = Math.abs(_xteSmoothed) > _threshM ? '#ff3a5c' : '#00e5ff';
    ctx.font = 'bold 11px JetBrains Mono, monospace';
    ctx.textAlign = 'center';
    ctx.fillText(`${fmt(Math.abs(_xteSmoothed), 2)}m`, cx + 40, cy + 4);

    // Labels
    ctx.fillStyle = 'rgba(0,229,255,0.4)';
    ctx.font = '8px JetBrains Mono, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('L', cx + 40, trackY + 10);
    ctx.fillText('R', cx + 40, trackY + barH - 2);
  }

  function _roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r);
    ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h);
    ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
  }

  function getMetrics() {
    return { xte: _xteSmoothed, ate: _ateM, side: _side };
  }

  return { init, update, setThreshold, getXteM, getMetrics };
})();
