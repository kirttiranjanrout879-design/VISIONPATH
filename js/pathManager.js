/* ═══════════════════════════════════════════════════════════════
   pathManager.js — Waypoint storage, path drawing, path follow logic
   
   - Stores array of waypoints (pixel coordinates on overlay canvas)
   - Draws path with perspective-projected overlay
   - Tracks active segment for deviation calculation
   - Manages draw mode interaction (click-to-place waypoints)
═══════════════════════════════════════════════════════════════ */
'use strict';

const PathManager = (() => {

  // ── State ────────────────────────────────────────────────────
  let _waypoints = [];     // [{x, y, label, reached}]
  let _activeIdx = 0;      // index of next waypoint to reach
  let _following = false;
  let _drawMode  = false;
  let _canvas, _ctx;
  let _onWpUpdate = null;  // callback when waypoints change

  // ── Init ─────────────────────────────────────────────────────
  function init(overlayCanvas, onWpUpdate) {
    _canvas = overlayCanvas;
    _ctx    = _canvas.getContext('2d');
    _onWpUpdate = onWpUpdate;
    _canvas.addEventListener('click', _handleClick);
  }

  function setDrawMode(enabled) {
    _drawMode = enabled;
    _canvas.style.pointerEvents = enabled ? 'all' : 'none';
    _canvas.classList.toggle('draw-mode', enabled);
  }

  function isDrawMode()  { return _drawMode; }
  function isFollowing() { return _following; }
  function getWaypoints() { return _waypoints.slice(); }
  function getActiveIdx() { return _activeIdx; }

  // ── Waypoint CRUD ────────────────────────────────────────────
  function addWaypoint(x, y, label) {
    const idx = _waypoints.length + 1;
    _waypoints.push({
      x, y,
      label: label || `WP-${idx}`,
      reached: false,
      final: false,
    });
    _refreshFinalFlag();
    _notifyUpdate();
  }

  function removeWaypoint(idx) {
    _waypoints.splice(idx, 1);
    if (_activeIdx >= _waypoints.length) _activeIdx = Math.max(0, _waypoints.length - 1);
    _refreshFinalFlag();
    _notifyUpdate();
  }

  function clearAll() {
    _waypoints = [];
    _activeIdx = 0;
    _following = false;
    _notifyUpdate();
  }

  function startFollow() {
    if (_waypoints.length < 1) { toast('Add at least 1 waypoint first', 'warn'); return; }
    _activeIdx = 0;
    _following = true;
    _waypoints.forEach(w => w.reached = false);
    _notifyUpdate();
    toast('▶ Path following started', 'ok');
    MAVLink.log('TX', `SET_MODE GUIDED`);
    MAVLink.log('TX', `CMD_DO_GUIDED_MASTER`);
  }

  function pauseFollow() {
    _following = false;
    toast('⏸ Path following paused', 'warn');
    MAVLink.log('TX', `CMD_OVERRIDE_GOTO HOLD`);
  }

  // ── Path drawing (overlay canvas) ────────────────────────────
  function draw(droneScreenX, droneScreenY) {
    const W = _canvas.width, H = _canvas.height;
    if (!_ctx) return;
    _ctx.clearRect(0, 0, W, H);

    if (_waypoints.length === 0) return;

    const pts = _waypoints;
    const centerX = droneScreenX !== undefined ? droneScreenX : W / 2;
    const centerY = droneScreenY !== undefined ? droneScreenY : H * 0.85;

    // ── Draw path lines ───────────────────────────────────────
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const isActive = i === _activeIdx;
      const isPast   = i < _activeIdx;

      _ctx.save();
      _ctx.beginPath();
      _ctx.moveTo(a.x, a.y);
      _ctx.lineTo(b.x, b.y);
      _ctx.lineWidth    = isActive ? 3 : 2;
      _ctx.strokeStyle  = isPast   ? 'rgba(100,100,100,0.4)' :
                          isActive ? '#00ff99' : 'rgba(0,229,255,0.7)';
      _ctx.shadowColor  = isActive ? '#00ff99' : '#00e5ff';
      _ctx.shadowBlur   = isActive ? 12 : 6;
      _ctx.setLineDash(isPast ? [4, 4] : []);
      _ctx.stroke();
      _ctx.restore();

      // Direction arrow
      if (!isPast) {
        _drawArrow(a.x, a.y, b.x, b.y, isActive ? '#00ff99' : 'rgba(0,229,255,0.7)');
      }
    }

    // ── Predict next segment beyond last wp ───────────────────
    if (pts.length >= 2 && Settings.get('showPrediction')) {
      const last  = pts[pts.length - 1];
      const prev  = pts[pts.length - 2];
      const dx    = last.x - prev.x;
      const dy    = last.y - prev.y;
      const len   = Math.sqrt(dx * dx + dy * dy);
      const scale = 60 / (len || 1);
      _ctx.save();
      _ctx.setLineDash([6, 6]);
      _ctx.strokeStyle = 'rgba(168,85,247,0.5)';
      _ctx.lineWidth = 1.5;
      _ctx.shadowColor = '#a855f7';
      _ctx.shadowBlur = 8;
      _ctx.beginPath();
      _ctx.moveTo(last.x, last.y);
      _ctx.lineTo(last.x + dx * scale, last.y + dy * scale);
      _ctx.stroke();
      _ctx.restore();
    }

    // ── Drone position marker ─────────────────────────────────
    _drawDroneMarker(centerX, centerY);

    // ── Draw waypoint nodes ───────────────────────────────────
    pts.forEach((wp, i) => {
      const isActive = i === _activeIdx && _following;
      const isFinal  = wp.final;
      const isReached = wp.reached;

      // Circle fill
      _ctx.save();
      _ctx.beginPath();
      _ctx.arc(wp.x, wp.y, isActive ? 10 : 8, 0, Math.PI * 2);
      _ctx.fillStyle = isReached ? 'rgba(100,100,100,0.5)' :
                       isFinal   ? 'rgba(255,58,92,0.3)' :
                       isActive  ? 'rgba(0,255,153,0.3)' :
                                   'rgba(0,229,255,0.2)';
      _ctx.fill();
      _ctx.strokeStyle = isReached ? 'rgba(100,100,100,0.6)' :
                         isFinal   ? '#ff3a5c' :
                         isActive  ? '#00ff99' :
                                     '#00e5ff';
      _ctx.lineWidth = 2;
      _ctx.shadowColor  = isActive ? '#00ff99' : '#00e5ff';
      _ctx.shadowBlur   = 10;
      _ctx.stroke();
      _ctx.restore();

      // Index label
      _ctx.save();
      _ctx.fillStyle = isReached ? 'rgba(160,160,160,0.6)' :
                       isFinal   ? '#ff3a5c' :
                       isActive  ? '#00ff99' : '#00e5ff';
      _ctx.font      = 'bold 9px JetBrains Mono, monospace';
      _ctx.textAlign = 'center';
      _ctx.textBaseline = 'middle';
      _ctx.fillText(i + 1, wp.x, wp.y);
      _ctx.restore();

      // Name label
      _ctx.save();
      _ctx.fillStyle = 'rgba(200,230,255,0.8)';
      _ctx.font      = '9px Inter, sans-serif';
      _ctx.fillText(wp.label, wp.x + 12, wp.y - 10);
      _ctx.restore();

      // LAND tag on final
      if (isFinal) {
        _ctx.save();
        _ctx.fillStyle = 'rgba(255,58,92,0.9)';
        _ctx.font = 'bold 8px Orbitron, sans-serif';
        _ctx.fillText('LAND', wp.x + 12, wp.y + 12);
        _ctx.restore();
      }
    });

    // ── Cross-track error line (from drone to path) ───────────
    if (_following && _waypoints.length >= 2) {
      const seg = _getCurrentSegment();
      if (seg) {
        const foot = _projectToSegment(centerX, centerY, seg.ax, seg.ay, seg.bx, seg.by);
        if (foot) {
          _ctx.save();
          _ctx.setLineDash([4, 3]);
          _ctx.strokeStyle = 'rgba(255,183,0,0.6)';
          _ctx.lineWidth = 1.5;
          _ctx.beginPath();
          _ctx.moveTo(centerX, centerY);
          _ctx.lineTo(foot.x, foot.y);
          _ctx.stroke();
          // Foot point marker
          _ctx.setLineDash([]);
          _ctx.beginPath();
          _ctx.arc(foot.x, foot.y, 4, 0, Math.PI * 2);
          _ctx.strokeStyle = 'rgba(255,183,0,0.8)';
          _ctx.lineWidth = 2;
          _ctx.stroke();
          _ctx.restore();
        }
      }
    }
  }

  function _drawDroneMarker(x, y) {
    // Hexacopter icon (simplified)
    _ctx.save();
    _ctx.translate(x, y);
    // Body
    _ctx.beginPath();
    _ctx.arc(0, 0, 10, 0, Math.PI * 2);
    _ctx.fillStyle = 'rgba(0,229,255,0.15)';
    _ctx.fill();
    _ctx.strokeStyle = '#00e5ff';
    _ctx.lineWidth = 2;
    _ctx.shadowColor = '#00e5ff';
    _ctx.shadowBlur = 16;
    _ctx.stroke();
    // Rotor arms
    for (let i = 0; i < 6; i++) {
      const angle = (i / 6) * Math.PI * 2;
      const ax_ = Math.cos(angle) * 10, ay_ = Math.sin(angle) * 10;
      const bx_ = Math.cos(angle) * 18, by_ = Math.sin(angle) * 18;
      _ctx.beginPath();
      _ctx.moveTo(ax_, ay_);
      _ctx.lineTo(bx_, by_);
      _ctx.lineWidth = 1.5;
      _ctx.strokeStyle = 'rgba(0,229,255,0.6)';
      _ctx.shadowBlur = 4;
      _ctx.stroke();
      _ctx.beginPath();
      _ctx.arc(bx_, by_, 5, 0, Math.PI * 2);
      _ctx.strokeStyle = 'rgba(0,229,255,0.4)';
      _ctx.lineWidth = 1;
      _ctx.stroke();
    }
    // Direction arrow (up = forward)
    _ctx.beginPath();
    _ctx.moveTo(0, -6);
    _ctx.lineTo(-4, 2);
    _ctx.lineTo(4, 2);
    _ctx.closePath();
    _ctx.fillStyle = '#00e5ff';
    _ctx.fill();
    _ctx.restore();
  }

  function _drawArrow(x1, y1, x2, y2, color) {
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    const angle = Math.atan2(y2 - y1, x2 - x1);
    const size  = 8;
    _ctx.save();
    _ctx.translate(mx, my);
    _ctx.rotate(angle);
    _ctx.beginPath();
    _ctx.moveTo(-size / 2, -size / 2);
    _ctx.lineTo(size / 2,  0);
    _ctx.lineTo(-size / 2, size / 2);
    _ctx.strokeStyle = color;
    _ctx.lineWidth = 1.5;
    _ctx.shadowBlur = 6;
    _ctx.shadowColor = color;
    _ctx.stroke();
    _ctx.restore();
  }

  // ── Deviation calculation ─────────────────────────────────────
  function getDeviation(droneX, droneY) {
    if (!_following || _waypoints.length < 2) return { xte: 0, ate: 0, side: 'none' };
    const seg = _getCurrentSegment();
    if (!seg) return { xte: 0, ate: 0, side: 'none' };

    const xte = crossTrack(droneX, droneY, seg.ax, seg.ay, seg.bx, seg.by);
    const ate = alongTrack(droneX, droneY, seg.ax, seg.ay, seg.bx, seg.by);

    return {
      xte,
      ate,
      side: Math.abs(xte) < 2 ? 'none' : (xte > 0 ? 'right' : 'left'),
    };
  }

  // ── Waypoint reaching ─────────────────────────────────────────
  function checkWaypointReached(droneX, droneY, threshPx) {
    if (!_following || _activeIdx >= _waypoints.length) return false;
    const wp = _waypoints[_activeIdx];
    const d  = dist2d(droneX, droneY, wp.x, wp.y);
    if (d < (threshPx || 40)) {
      _waypoints[_activeIdx].reached = true;
      const isFinal = _waypoints[_activeIdx].final;
      _activeIdx++;
      _notifyUpdate();
      if (isFinal || _activeIdx >= _waypoints.length) {
        _following = false;
        MAVLink.log('TX', 'CMD_NAV_LAND precision=1');
        toast('🏁 Final waypoint reached — initiating precision landing', 'ok', 5000);
        return 'land';
      }
      MAVLink.log('TX', `CMD_NAV_WAYPOINT idx=${_activeIdx}`);
      toast(`✓ WP-${_activeIdx} reached`, 'ok', 2000);
      return 'next';
    }
    return false;
  }

  // ── Helpers ───────────────────────────────────────────────────
  function _getCurrentSegment() {
    if (_activeIdx <= 0 || _activeIdx >= _waypoints.length) {
      // First segment: use first two waypoints
      if (_waypoints.length >= 2 && _activeIdx === 0) {
        return { ax: _waypoints[0].x, ay: _waypoints[0].y, bx: _waypoints[1].x, by: _waypoints[1].y };
      }
      return null;
    }
    const a = _waypoints[_activeIdx - 1];
    const b = _waypoints[_activeIdx];
    return { ax: a.x, ay: a.y, bx: b.x, by: b.y };
  }

  function _projectToSegment(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    if (len2 < 1e-6) return null;
    const t = clamp(((px - ax) * dx + (py - ay) * dy) / len2, 0, 1);
    return { x: ax + t * dx, y: ay + t * dy };
  }

  function _refreshFinalFlag() {
    _waypoints.forEach((w, i) => { w.final = i === _waypoints.length - 1; });
  }

  function _handleClick(evt) {
    if (!_drawMode) return;
    const rect = _canvas.getBoundingClientRect();
    const scaleX = _canvas.width  / rect.width;
    const scaleY = _canvas.height / rect.height;
    const x = (evt.clientX - rect.left)  * scaleX;
    const y = (evt.clientY - rect.top)   * scaleY;
    addWaypoint(x, y);
    toast(`WP-${_waypoints.length} placed`, 'info', 1200);
  }

  function _notifyUpdate() {
    if (_onWpUpdate) _onWpUpdate(_waypoints, _activeIdx);
  }

  // ── Canvas resize ─────────────────────────────────────────────
  function resize(w, h) {
    if (!_canvas) return;
    _canvas.width  = w;
    _canvas.height = h;
  }

  return {
    init, setDrawMode, isDrawMode, isFollowing,
    getWaypoints, getActiveIdx,
    addWaypoint, removeWaypoint, clearAll,
    startFollow, pauseFollow,
    draw, getDeviation, checkWaypointReached, resize,
  };
})();
