/* ═══════════════════════════════════════════════════════════════
   pathManager.js — Metric Waypoint Navigation, Visual AR Projection,
   Real-Time Motion Tracking & Exact Distance/Turn Command Generation
═══════════════════════════════════════════════════════════════ */
'use strict';

const PathManager = (() => {

  // ── State ────────────────────────────────────────────────────
  let _waypoints = [];     // [{x, y, metricX, metricY, distFromPrev, turnAngleDeg, targetHeading, label, reached, final}]
  let _activeIdx = 0;      // index of next waypoint to reach
  let _following = false;
  let _drawMode  = false;
  let _canvas, _ctx;
  let _onWpUpdate = null;  // callback when waypoints change

  // Live Drone Metric Position in Local World Space (NED: x=East/Lateral, y=North/Forward)
  let _dronePos = { x: 0.0, y: 0.0, z: 1.5 };
  let _initialHeading = 0.0;
  let _headingInitialized = false;
  let _lastFollowCmdTime = 0;
  let _pulseFrame = 0;
  let _refLat = null;
  let _refLon = null;
  let _refLocalX = null;
  let _refLocalY = null;
  let _targetAlt = 1.5;

  // ── Init ─────────────────────────────────────────────────────
  function init(overlayCanvas, onWpUpdate) {
    _canvas = overlayCanvas;
    if (_canvas) _ctx = _canvas.getContext('2d');
    _onWpUpdate = onWpUpdate;
    if (_canvas) _canvas.addEventListener('click', _handleClick);
  }

  function setDrawMode(enabled) {
    _drawMode = enabled;
    if (_canvas) {
      _canvas.style.pointerEvents = enabled ? 'all' : 'none';
      _canvas.classList.toggle('draw-mode', enabled);
    }
  }

  function isDrawMode()  { return _drawMode; }
  function isFollowing() { return _following; }
  function getWaypoints() { return _waypoints.slice(); }
  function getActiveIdx() { return _activeIdx; }
  function getDronePos()  { return { ..._dronePos }; }
  function setDronePos(x, y, z) {
    _dronePos.x = x;
    _dronePos.y = y;
    if (z !== undefined) _dronePos.z = z;
  }
  function resetDronePos() {
    _dronePos = { x: 0.0, y: 0.0, z: 1.5 };
  }

  // ── Coordinate Conversions (Screen Pixels <-> Ground Metric) ─
  function _screenToMetric(px, py) {
    const W = _canvas ? _canvas.width : 960;
    const H = _canvas ? _canvas.height : 540;
    const cal = Calibration.getState();
    const pxPerM = (cal.calibrated && cal.pixelsPerMeter) ? cal.pixelsPerMeter : (W / 4.0);

    // Lateral offset from screen center
    const dxPx = px - (W / 2);
    // Perspective forward distance from bottom baseline (drone is at H * 0.82)
    const dyPx = (H * 0.82) - py;

    const metricX = dxPx / pxPerM;
    // Perspective compression mapping for forward-facing camera
    const metricY = Math.max(0.3, (dyPx / pxPerM) * 1.55);

    return { x: metricX, y: metricY };
  }

  function _metricToScreen(mx, my) {
    const W = _canvas ? _canvas.width : 960;
    const H = _canvas ? _canvas.height : 540;
    const cal = Calibration.getState();
    const pxPerM = (cal.calibrated && cal.pixelsPerMeter) ? cal.pixelsPerMeter : (W / 4.0);

    const px = (W / 2) + (mx * pxPerM);
    const py = (H * 0.82) - ((my / 1.55) * pxPerM);
    return { x: px, y: py };
  }

  // ── Waypoint Calculation (Exact Distances & Turn Angles) ──────
  function _recalcMetrics() {
    let currentX = 0.0;
    let currentY = 0.0;
    let prevBearing = 0.0;

    _waypoints.forEach((wp, i) => {
      // If waypoint doesn't have metric coordinates yet, compute from pixel
      if (wp.metricX === undefined || wp.metricY === undefined) {
        const m = _screenToMetric(wp.x, wp.y);
        wp.metricX = m.x;
        wp.metricY = m.y;
      }

      // Distance from previous point (or drone origin for WP-1)
      const dx = wp.metricX - currentX;
      const dy = wp.metricY - currentY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      wp.distFromPrev = Math.max(0.1, dist);

      // Segment bearing relative to initial forward axis
      const bearing = Math.atan2(dx, dy) * (180 / Math.PI);
      wp.bearing = bearing;

      // Relative turn angle from previous leg
      const turn = (i === 0) ? bearing : normalizeAngleDeg(bearing - prevBearing);
      wp.turnAngleDeg = turn;

      // Target absolute compass heading
      wp.targetHeading = wrap360(_initialHeading + bearing);

      // Advance
      currentX = wp.metricX;
      currentY = wp.metricY;
      prevBearing = bearing;
    });

    _refreshFinalFlag();
  }

  // ── Set Waypoint Exact Distance or Turn ───────────────────────
  function setWaypointDistance(idx, newDistM) {
    if (idx < 0 || idx >= _waypoints.length) return;
    const d = parseFloat(newDistM);
    if (isNaN(d) || d <= 0.05) return;

    const prevX = (idx === 0) ? 0.0 : _waypoints[idx - 1].metricX;
    const prevY = (idx === 0) ? 0.0 : _waypoints[idx - 1].metricY;
    const wp = _waypoints[idx];

    // Current angle
    const dx = wp.metricX - prevX;
    const dy = wp.metricY - prevY;
    const currentDist = Math.sqrt(dx * dx + dy * dy) || 1.0;
    const unitX = dx / currentDist;
    const unitY = dy / currentDist;

    // Rescale to new exact distance
    wp.metricX = prevX + (unitX * d);
    wp.metricY = prevY + (unitY * d);
    wp.distFromPrev = d;

    // Update screen pixel coordinates
    const scr = _metricToScreen(wp.metricX, wp.metricY);
    wp.x = scr.x;
    wp.y = scr.y;

    _recalcMetrics();
    _notifyUpdate();
    toast(`WP-${idx + 1} distance updated to ${fmt(d, 2)} m`, 'info', 1500);
  }

  function setWaypointTurn(idx, newTurnDeg) {
    if (idx < 0 || idx >= _waypoints.length) return;
    const t = parseFloat(newTurnDeg);
    if (isNaN(t)) return;

    const prevX = (idx === 0) ? 0.0 : _waypoints[idx - 1].metricX;
    const prevY = (idx === 0) ? 0.0 : _waypoints[idx - 1].metricY;
    const prevBearing = (idx === 0) ? 0.0 : _waypoints[idx - 1].bearing;
    const newBearing = prevBearing + t;

    const wp = _waypoints[idx];
    const dist = wp.distFromPrev || 2.0;

    const rad = deg2rad(newBearing);
    wp.metricX = prevX + (Math.sin(rad) * dist);
    wp.metricY = prevY + (Math.cos(rad) * dist);

    const scr = _metricToScreen(wp.metricX, wp.metricY);
    wp.x = scr.x;
    wp.y = scr.y;

    _recalcMetrics();
    _notifyUpdate();
    toast(`WP-${idx + 1} turn set to ${fmt(t, 1)}°`, 'info', 1500);
  }

  // ── Waypoint CRUD ────────────────────────────────────────────
  function addWaypoint(x, y, label, exactDistM, exactTurnDeg) {
    const idx = _waypoints.length + 1;
    const wpObj = {
      x: x || (_canvas ? _canvas.width / 2 : 480),
      y: y || (_canvas ? _canvas.height * 0.45 : 240),
      label: label || `WP-${idx}`,
      reached: false,
      final: false,
    };

    _waypoints.push(wpObj);
    _recalcMetrics();

    if (exactDistM !== undefined) {
      setWaypointDistance(_waypoints.length - 1, exactDistM);
    }
    if (exactTurnDeg !== undefined) {
      setWaypointTurn(_waypoints.length - 1, exactTurnDeg);
    }

    _notifyUpdate();
  }

  function removeWaypoint(idx) {
    _waypoints.splice(idx, 1);
    if (_activeIdx >= _waypoints.length) _activeIdx = Math.max(0, _waypoints.length - 1);
    _recalcMetrics();
    _notifyUpdate();
  }

  function clearAll() {
    _waypoints = [];
    _activeIdx = 0;
    _following = false;
    resetDronePos();
    _notifyUpdate();
  }

  function startFollow() {
    if (_waypoints.length < 1) { toast('Add at least 1 waypoint first', 'warn'); return; }
    _activeIdx = 0;
    _following = true;
    _waypoints.forEach(w => w.reached = false);

    const telem = MAVLink.getTelem ? MAVLink.getTelem() : {};

    // 1. Auto-arm drone if not armed
    if (!telem.armed) {
      MAVLink.log('TX', '⚡ Auto-arming drone for autonomous path following');
      MAVLink.arm();
    }

    // 2. Flight mode is always ALT_HOLD
    MAVLink.log('TX', 'SET_MODE ALT_HOLD');
    MAVLink.setMode('ALT_HOLD');

    // 3. Target Altitude from blank input box
    const altInput = document.getElementById('target-alt-input');
    const customAlt = altInput && altInput.value ? parseFloat(altInput.value) : NaN;
    if (!isNaN(customAlt) && customAlt > 0.1) {
      _targetAlt = customAlt;
      MAVLink.sendTakeoff(_targetAlt);
      toast(`▶ Auto-armed in ALT_HOLD — climbing to ${_targetAlt}m target alt (5 km/h)`, 'ok', 3500);
    } else {
      toast('▶ Auto-armed in ALT_HOLD — following path at 5 km/h', 'ok', 3500);
    }

    // 4. Sync reference positions for real physical motion tracking
    if (telem.heading !== null && telem.heading !== undefined) {
      _initialHeading = telem.heading;
      _headingInitialized = true;
    }
    _refLat = (telem.lat !== null && telem.lat !== undefined && telem.lat !== 0) ? telem.lat : null;
    _refLon = (telem.lon !== null && telem.lon !== undefined && telem.lon !== 0) ? telem.lon : null;
    _refLocalX = (telem.local_x !== null && telem.local_x !== undefined) ? telem.local_x : null;
    _refLocalY = (telem.local_y !== null && telem.local_y !== undefined) ? telem.local_y : null;
    resetDronePos();

    _recalcMetrics();
    _notifyUpdate();

    // 5. Send first waypoint command at 5 km/h
    _sendActiveWaypointCommand();
  }

  function pauseFollow() {
    _following = false;
    toast('⏸ Path following paused', 'warn');
    MAVLink.log('TX', `CMD_OVERRIDE_GOTO HOLD`);
    MAVLink.sendPositionTargetLocalNED(0, 0, 0);
  }

  // ── Real-time Navigation Update & Command Execution ──────────
  function updateNavigation(dt, telem) {
    _pulseFrame++;

    if (!_headingInitialized && telem && telem.heading !== null) {
      _initialHeading = telem.heading;
      _headingInitialized = true;
      _recalcMetrics();
    }

    const currentHdg = (telem && telem.heading !== null) ? telem.heading : _initialHeading;

    // ── Physical Motion Tracking from Telemetry ─────────────────
    // The drone logo only moves when real physical movement is reported by the drone.
    if (telem) {
      if (telem.local_x !== null && telem.local_x !== undefined &&
          telem.local_y !== null && telem.local_y !== undefined) {
        if (_refLocalX === null || _refLocalY === null) {
          _refLocalX = telem.local_x;
          _refLocalY = telem.local_y;
        }
        _dronePos.x = telem.local_y - _refLocalY; // East (m)
        _dronePos.y = telem.local_x - _refLocalX; // North (m)
      } else if (telem.lat !== null && telem.lon !== null && telem.lat !== undefined && telem.lon !== undefined &&
                 (telem.lat !== 0 || telem.lon !== 0)) {
        if (_refLat === null || _refLon === null) {
          _refLat = telem.lat;
          _refLon = telem.lon;
        }
        const dLatM = (telem.lat - _refLat) * 111319.5;
        const dLonM = (telem.lon - _refLon) * (111319.5 * Math.cos(_refLat * Math.PI / 180));
        _dronePos.x = dLonM;
        _dronePos.y = dLatM;
      } else if (telem.vx !== null && telem.vy !== null && telem.vx !== undefined && telem.vy !== undefined &&
                 (Math.abs(telem.vx) > 0.05 || Math.abs(telem.vy) > 0.05)) {
        _dronePos.x += telem.vy * dt;
        _dronePos.y += telem.vx * dt;
      } else if (telem.speed !== null && telem.speed !== undefined && telem.speed > 0.08) {
        // Real physical ground speed integration from sensors (only when speed > 0.08 m/s)
        const relHdgRad = deg2rad(currentHdg - _initialHeading);
        _dronePos.x += (telem.speed * Math.sin(relHdgRad)) * dt;
        _dronePos.y += (telem.speed * Math.cos(relHdgRad)) * dt;
      }
    }

    // ── Waypoint Reaching Check ─────────────────────────────────
    if (_following && _activeIdx < _waypoints.length) {
      const targetWp = _waypoints[_activeIdx];
      const dx = targetWp.metricX - _dronePos.x;
      const dy = targetWp.metricY - _dronePos.y;
      const distRem = Math.sqrt(dx * dx + dy * dy);

      // Check reaching condition ONLY when physical drone is within 0.45 meters
      if (distRem < 0.45) {
        targetWp.reached = true;
        const isFinal = targetWp.final || (_activeIdx === _waypoints.length - 1);
        _activeIdx++;
        _notifyUpdate();

        if (isFinal) {
          _following = false;
          MAVLink.log('TX', '🏁 CMD_NAV_LAND (Slow Landing — Final WP reached)');
          MAVLink.land();
          toast('🏁 Final waypoint reached — executing slow precision landing!', 'ok', 5000);
          return 'land';
        } else {
          MAVLink.log('TX', `✓ WP-${_activeIdx} reached — navigating to WP-${_activeIdx + 1}`);
          toast(`✓ WP-${_activeIdx} reached — proceeding to WP-${_activeIdx + 1}`, 'ok', 2500);
          _sendActiveWaypointCommand();
          return 'next';
        }
      }

      // Periodic command refresh every 1.5s
      const now = Date.now();
      if (now - _lastFollowCmdTime > 1500) {
        _lastFollowCmdTime = now;
        _sendActiveWaypointCommand();
      }
    }
  }

  function _sendActiveWaypointCommand() {
    if (!_following || _activeIdx >= _waypoints.length) return;
    const targetWp = _waypoints[_activeIdx];
    const dx = targetWp.metricX - _dronePos.x;
    const dy = targetWp.metricY - _dronePos.y;
    const distRem = Math.sqrt(dx * dx + dy * dy);
    const targetBearing = Math.atan2(dx, dy) * (180 / Math.PI);
    const targetHeading = wrap360(_initialHeading + targetBearing);

    const telem = MAVLink.getTelem ? MAVLink.getTelem() : {};
    const curHdg = (telem.heading !== null) ? telem.heading : _initialHeading;
    const relTurn = normalizeAngleDeg(targetHeading - curHdg);

    // 1. Send Turn / Yaw command to flight controller
    MAVLink.log('TX', `CMD_CONDITION_YAW hdg=${fmt(targetHeading, 0)}° (turn ${relTurn > 0 ? '+' : ''}${fmt(relTurn, 1)}°)`);
    MAVLink.sendConditionYaw(targetHeading, 20.0, false);

    // 2. Flight speed strictly set to 5 km/h (5.0 / 3.6 = 1.39 m/s)
    const SPEED_5_KMH = 5.0 / 3.6; // 1.39 m/s
    const forwardSpeed = SPEED_5_KMH;
    const vy = (relTurn > 5) ? 0.3 : (relTurn < -5) ? -0.3 : 0.0;
    MAVLink.log('TX', `SET_POSITION_TARGET_LOCAL_NED dist=${fmt(distRem, 2)}m vx=${fmt(forwardSpeed, 2)}m/s (5 km/h)`);
    MAVLink.sendGuidedWaypoint(distRem, relTurn, forwardSpeed);
  }

  // ── Path Drawing with Dynamic Video Perspective AR Projection ─
  function draw(droneScreenX, droneScreenY) {
    if (!_ctx || !_canvas) return;
    const W = _canvas.width, H = _canvas.height;
    _ctx.clearRect(0, 0, W, H);

    if (_waypoints.length === 0) return;

    const telem = MAVLink.getTelem ? MAVLink.getTelem() : {};
    const currentHdg = (telem.heading !== null) ? telem.heading : _initialHeading;
    const roll = (telem.roll !== null) ? telem.roll : 0.0;
    const pitch = (telem.pitch !== null) ? telem.pitch : 0.0;

    const cal = Calibration.getState();
    const pxPerM = (cal.calibrated && cal.pixelsPerMeter) ? cal.pixelsPerMeter : (W / 4.0);

    // Heading delta relative to path definition frame
    const deltaHdgRad = deg2rad(currentHdg - _initialHeading);
    const cosH = Math.cos(deltaHdgRad);
    const sinH = Math.sin(deltaHdgRad);
    // Compute dynamic drone screen position based on metric coordinates
    const bodyXDrone = (_dronePos.x * cosH) - (_dronePos.y * sinH);
    const bodyYDrone = (_dronePos.x * sinH) + (_dronePos.y * cosH);
    const perspectiveScaleDrone = Math.max(0.15, 1.0 + (bodyYDrone * 0.35));
    const droneX = (W / 2) + (bodyXDrone * pxPerM) / perspectiveScaleDrone;
    const droneY = (H * 0.82) - (bodyYDrone * pxPerM) + (pitch * 1.5);


    // ── 1. Project all waypoints into Camera View relative to drone motion ──
    const projectedPts = _waypoints.map((wp, i) => {
      // Waypoints are fixed in camera frame: use stored screen coordinates directly
      const bodyX = wp.metricX;
      const bodyY = wp.metricY;

      const projX = wp.x;
      const projY = wp.y;

      const isBehind = false;
      const distToDrone = Math.sqrt((wp.metricX - _dronePos.x) ** 2 + (wp.metricY - _dronePos.y) ** 2);

      return {
        x: projX,
        y: projY,
        bodyX, bodyY,
        distToDrone,
        isBehind,
        origWp: wp,
        idx: i
      };
    });

    // ── 2. Draw Dynamic Projected Path Lines ─────────────────────
    // Draw connecting line from drone to active waypoint
    if (_following && _activeIdx < projectedPts.length) {
      const activeProj = projectedPts[_activeIdx];
      if (!activeProj.isBehind) {
        _ctx.save();
        _ctx.beginPath();
        _ctx.moveTo(droneX, droneY);
        _ctx.lineTo(activeProj.x, activeProj.y);
        _ctx.lineWidth = 3;
        _ctx.strokeStyle = '#00ff99';
        _ctx.shadowColor = '#00ff99';
        _ctx.shadowBlur = 12;
        _ctx.setLineDash([6, 6]);
        _ctx.lineDashOffset = -(_pulseFrame * 0.8) % 24;
        _ctx.stroke();
        _ctx.restore();
      }
    }

    // Draw lines between sequential waypoints
    for (let i = 0; i < projectedPts.length - 1; i++) {
      const p1 = projectedPts[i];
      const p2 = projectedPts[i + 1];
      const isActive = (i === _activeIdx);
      const isPast = (i < _activeIdx);

      if (p1.isBehind && p2.isBehind) continue;

      _ctx.save();
      _ctx.beginPath();
      _ctx.moveTo(p1.x, p1.y);
      _ctx.lineTo(p2.x, p2.y);
      _ctx.lineWidth = isActive ? 3.5 : 2.0;
      _ctx.strokeStyle = isPast ? 'rgba(120, 140, 160, 0.35)' :
                         isActive ? '#00ff99' : 'rgba(0, 229, 255, 0.75)';
      _ctx.shadowColor = isActive ? '#00ff99' : '#00e5ff';
      _ctx.shadowBlur = isActive ? 14 : 6;
      _ctx.setLineDash(isPast ? [4, 4] : []);
      _ctx.stroke();
      _ctx.restore();

      // Direction Chevron Arrow
      if (!isPast && !p1.isBehind && !p2.isBehind) {
        _drawArrow(p1.x, p1.y, p2.x, p2.y, isActive ? '#00ff99' : 'rgba(0, 229, 255, 0.8)');
      }
    }

    // ── 3. Draw Projected Waypoint AR Nodes & Distance Badges ─────
    projectedPts.forEach((pt, i) => {
      if (pt.isBehind) return;
      const wp = pt.origWp;
      const isActive = (i === _activeIdx && _following);
      const isReached = wp.reached;
      const isFinal = wp.final;

      // Pulse ring for active waypoint
      if (isActive) {
        const pulseR = 12 + Math.sin(_pulseFrame * 0.15) * 4;
        _ctx.save();
        _ctx.beginPath();
        _ctx.arc(pt.x, pt.y, pulseR, 0, Math.PI * 2);
        _ctx.strokeStyle = 'rgba(0, 255, 153, 0.6)';
        _ctx.lineWidth = 1.5;
        _ctx.stroke();
        _ctx.restore();
      }

      // Waypoint circle
      _ctx.save();
      _ctx.beginPath();
      _ctx.arc(pt.x, pt.y, isActive ? 10 : 8, 0, Math.PI * 2);
      _ctx.fillStyle = isReached ? 'rgba(80, 90, 100, 0.6)' :
                       isFinal   ? 'rgba(255, 58, 92, 0.4)' :
                       isActive  ? 'rgba(0, 255, 153, 0.4)' :
                                   'rgba(0, 229, 255, 0.25)';
      _ctx.fill();
      _ctx.strokeStyle = isReached ? '#6c757d' :
                         isFinal   ? '#ff3a5c' :
                         isActive  ? '#00ff99' : '#00e5ff';
      _ctx.lineWidth = 2;
      _ctx.shadowColor = isActive ? '#00ff99' : '#00e5ff';
      _ctx.shadowBlur = 10;
      _ctx.stroke();
      _ctx.restore();

      // Node Index Number
      _ctx.save();
      _ctx.fillStyle = isReached ? '#a0aec0' : isFinal ? '#ff3a5c' : isActive ? '#00ff99' : '#fff';
      _ctx.font = 'bold 9px JetBrains Mono, monospace';
      _ctx.textAlign = 'center';
      _ctx.textBaseline = 'middle';
      _ctx.fillText(i + 1, pt.x, pt.y);
      _ctx.restore();

      // Floating AR HUD Tag with Exact Distance & Turn
      _ctx.save();
      const tagText = `${wp.label} • ${fmt(pt.distToDrone, 1)}m${wp.turnAngleDeg ? ' • ' + (wp.turnAngleDeg > 0 ? '+' : '') + fmt(wp.turnAngleDeg, 0) + '°' : ''}`;
      _ctx.font = 'bold 9px Orbitron, sans-serif';
      const textW = _ctx.measureText(tagText).width;

      const tagX = pt.x - (textW / 2) - 6;
      const tagY = pt.y - 28;

      // Tag Background
      _ctx.fillStyle = isActive ? 'rgba(0, 20, 15, 0.85)' : 'rgba(8, 14, 24, 0.8)';
      _ctx.strokeStyle = isActive ? '#00ff99' : isFinal ? '#ff3a5c' : 'rgba(0, 229, 255, 0.5)';
      _ctx.lineWidth = 1;
      _roundRect(_ctx, tagX, tagY, textW + 12, 16, 4);
      _ctx.fill();
      _ctx.stroke();

      // Tag Text
      _ctx.fillStyle = isActive ? '#00ff99' : isFinal ? '#ff3a5c' : '#00e5ff';
      _ctx.textAlign = 'center';
      _ctx.fillText(tagText, pt.x, tagY + 11);
      _ctx.restore();
    });

    // ── 4. Draw Dynamic Moving Drone Marker on HUD ────────────────
    _drawDynamicDroneMarker(droneX, droneY, roll, deltaHdgRad);
  }

  function _drawDynamicDroneMarker(cx, cy, rollDeg, deltaHdgRad) {
    if (!_ctx) return;
    _ctx.save();
    _ctx.translate(cx, cy);
    _ctx.rotate(deg2rad(-rollDeg)); // Roll tilt

    // Dynamic rotor spinning animation
    const rotorSpin = (_pulseFrame * 0.4) % (Math.PI * 2);

    // Central Body
    _ctx.beginPath();
    _ctx.arc(0, 0, 11, 0, Math.PI * 2);
    _ctx.fillStyle = 'rgba(0, 229, 255, 0.2)';
    _ctx.fill();
    _ctx.strokeStyle = '#00e5ff';
    _ctx.lineWidth = 2;
    _ctx.shadowColor = '#00e5ff';
    _ctx.shadowBlur = 14;
    _ctx.stroke();

    // 6 Hexacopter Arms
    for (let i = 0; i < 6; i++) {
      const armAngle = (i / 6) * Math.PI * 2;
      const ax = Math.cos(armAngle) * 11, ay = Math.sin(armAngle) * 11;
      const bx = Math.cos(armAngle) * 20, by = Math.sin(armAngle) * 20;

      _ctx.beginPath();
      _ctx.moveTo(ax, ay);
      _ctx.lineTo(bx, by);
      _ctx.lineWidth = 1.8;
      _ctx.strokeStyle = 'rgba(0, 229, 255, 0.7)';
      _ctx.stroke();

      // Rotor disc
      _ctx.beginPath();
      _ctx.arc(bx, by, 6, 0, Math.PI * 2);
      _ctx.strokeStyle = 'rgba(0, 229, 255, 0.35)';
      _ctx.lineWidth = 1;
      _ctx.stroke();

      // Spinning blade line
      const bladeX = Math.cos(rotorSpin + i) * 6;
      const bladeY = Math.sin(rotorSpin + i) * 6;
      _ctx.beginPath();
      _ctx.moveTo(bx - bladeX, by - bladeY);
      _ctx.lineTo(bx + bladeX, by + bladeY);
      _ctx.strokeStyle = '#00e5ff';
      _ctx.lineWidth = 1.2;
      _ctx.stroke();
    }

    // Forward Direction Arrow
    _ctx.beginPath();
    _ctx.moveTo(0, -8);
    _ctx.lineTo(-4, 3);
    _ctx.lineTo(4, 3);
    _ctx.closePath();
    _ctx.fillStyle = '#00ff99';
    _ctx.fill();

    _ctx.restore();
  }

  function _drawArrow(x1, y1, x2, y2, color) {
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    const angle = Math.atan2(y2 - y1, x2 - x1);
    const size = 8;
    _ctx.save();
    _ctx.translate(mx, my);
    _ctx.rotate(angle);
    _ctx.beginPath();
    _ctx.moveTo(-size / 2, -size / 2);
    _ctx.lineTo(size / 2, 0);
    _ctx.lineTo(-size / 2, size / 2);
    _ctx.strokeStyle = color;
    _ctx.lineWidth = 1.5;
    _ctx.stroke();
    _ctx.restore();
  }

  // ── Deviation Calculation ─────────────────────────────────────
  function getDeviation(droneScreenX, droneScreenY) {
    if (!_following || _waypoints.length < 1 || _activeIdx >= _waypoints.length) {
      return { xte: 0, ate: 0, side: 'none', distRem: 0 };
    }

    const prevPt = (_activeIdx === 0) ? { metricX: 0, metricY: 0 } : _waypoints[_activeIdx - 1];
    const targetWp = _waypoints[_activeIdx];

    const dx = targetWp.metricX - prevPt.metricX;
    const dy = targetWp.metricY - prevPt.metricY;
    const segLen = Math.sqrt(dx * dx + dy * dy);

    if (segLen < 0.05) return { xte: 0, ate: 0, side: 'none', distRem: 0 };

    // Cross-track error in metric space
    const px = _dronePos.x - prevPt.metricX;
    const py = _dronePos.y - prevPt.metricY;
    const xteM = ((dy * px - dx * py) / segLen);
    const ateM = ((px * dx + py * dy) / segLen);

    const remDx = targetWp.metricX - _dronePos.x;
    const remDy = targetWp.metricY - _dronePos.y;
    const distRem = Math.sqrt(remDx * remDx + remDy * remDy);

    const cal = Calibration.getState();
    const pxPerM = (cal.calibrated && cal.pixelsPerMeter) ? cal.pixelsPerMeter : 100;

    return {
      xte: xteM * pxPerM,
      xteM: xteM,
      ate: ateM * pxPerM,
      ateM: ateM,
      distRem: distRem,
      side: Math.abs(xteM) < 0.05 ? 'none' : (xteM > 0 ? 'right' : 'left'),
    };
  }

  // ── Click Handler in Draw Mode ────────────────────────────────
  function _handleClick(evt) {
    if (!_drawMode) return;
    const rect = _canvas.getBoundingClientRect();
    const scaleX = _canvas.width  / rect.width;
    const scaleY = _canvas.height / rect.height;
    const x = (evt.clientX - rect.left)  * scaleX;
    const y = (evt.clientY - rect.top)   * scaleY;

    addWaypoint(x, y);
    const idx = _waypoints.length;
    const wp = _waypoints[idx - 1];
    toast(`WP-${idx} placed (${fmt(wp.distFromPrev, 2)}m, turn ${fmt(wp.turnAngleDeg, 0)}°)`, 'info', 1800);
  }

  function _refreshFinalFlag() {
    _waypoints.forEach((w, i) => { w.final = (i === _waypoints.length - 1); });
  }

  function _notifyUpdate() {
    if (_onWpUpdate) _onWpUpdate(_waypoints, _activeIdx);
  }

  function resize(w, h) {
    if (!_canvas) return;
    _canvas.width  = w;
    _canvas.height = h;
    _recalcMetrics();
  }

  return {
    init, setDrawMode, isDrawMode, isFollowing,
    getWaypoints, getActiveIdx, getDronePos, setDronePos, resetDronePos,
    addWaypoint, removeWaypoint, clearAll,
    setWaypointDistance, setWaypointTurn,
    startFollow, pauseFollow,
    updateNavigation, draw, getDeviation, resize,
  };
})();
