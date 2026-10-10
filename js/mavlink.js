/* ═══════════════════════════════════════════════════════════════
   mavlink.js — Real MAVLink Telemetry Engine & WebSocket Bridge
   Connects to Raspberry Pi Agent over WebSocket (e.g. ws://10.89.89.85:8081).
   Strict requirement: NO fake/demo telemetry.
   Only reports MAVLink ONLINE when real Pixhack heartbeat is received.
═══════════════════════════════════════════════════════════════ */
'use strict';

const MAVLink = (() => {

  // ── Connection & Status States ────────────────────────────────
  let _ws           = null;
  let _wsConnected  = false;
  let _agentOnline  = false;
  let _mavlinkOnline= false;
  let _mavlinkError = null;

  // Seed from CONFIG (config.js) if available
  let _currentHost  = (typeof CONFIG !== 'undefined') ? CONFIG.MAVLINK_WS_HOST : '10.89.89.85';
  let _currentPort  = (typeof CONFIG !== 'undefined') ? CONFIG.MAVLINK_WS_PORT : 8081;
  let _reconnectTimer = null;
  let _reconnectAttempts = 0;
  let _heartbeatCheckTimer = null;
  let _lastHeartbeatMs = 0;
  let _lastStatusPacket = null;

  // Real Pixhack Telemetry Data
  let _telem = {
    sysid:       null,
    compid:      null,
    firmware:    null,
    armed:       false,
    mode:        'ALT_HOLD',
    alt:         null,
    rel_alt:     null,
    speed:       null,
    airspeed:    null,
    heading:     null,
    pitch:       null,
    roll:        null,
    yaw:         null,
    battery:     null,
    battery_v:   null,
    gps_fix:     null,
    gps_sats:    null,
    lat:         null,
    lon:         null,
    local_x:     null,
    local_y:     null,
    local_z:     null,
    vx:          null,
    vy:          null,
    vz:          null,
    rc_channels: []
  };

  let _msgHandlers    = [];
  let _statusHandlers = [];
  let _logEl          = null;

  // ArduCopter mode definitions
  const COPTER_MODES = {
    0:  'STABILIZE',
    1:  'ACRO',
    2:  'ALT_HOLD',
    3:  'AUTO',
    4:  'GUIDED',
    5:  'LOITER',
    6:  'RTL',
    7:  'CIRCLE',
    9:  'LAND',
    11: 'DRIFT',
    13: 'SPORT',
    14: 'FLIP',
    15: 'AUTOTUNE',
    16: 'POSHOLD',
    17: 'BRAKE',
    18: 'THROW',
    19: 'AVOID_ADSB',
    20: 'GUIDED_NOGPS',
    21: 'SMART_RTL',
    22: 'FLOWHOLD',
    23: 'FOLLOW',
    24: 'ZIGZAG',
    25: 'SYSTEMID',
    26: 'AUTOROTATE',
    27: 'AUTO_RTL'
  };

  // ── Initialization ────────────────────────────────────────────
  function init() {
    _logEl = $('mav-log');

    // Periodic Heartbeat Liveness Monitor
    if (_heartbeatCheckTimer) clearInterval(_heartbeatCheckTimer);
    _heartbeatCheckTimer = setInterval(_checkHeartbeatLiveness, 500);
  }

  // ── Connection Management ─────────────────────────────────────
  function connect(host, port) {
    if (host) _currentHost = host.trim();
    if (port) _currentPort = parseInt(port);

    // Save to Settings
    Settings.set('piHost', _currentHost);
    Settings.set('wsPort', _currentPort);

    // Clean up existing WebSocket
    _cleanupWs();

    const wsUrl = `ws://${_currentHost}:${_currentPort}`;
    log('SYS', `Connecting to Pi Agent at ${wsUrl}…`);
    _updateUIStatus();

    try {
      _ws = new WebSocket(wsUrl);

      _ws.onopen = () => {
        _wsConnected = true;
        _reconnectAttempts = 0;
        log('RX', `✓ WebSocket connected to Pi Agent (${_currentHost}:${_currentPort})`);
        _updateUIStatus();
      };

      _ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          _handleIncomingMessage(msg);
        } catch (e) {
          console.warn('Failed to parse WebSocket JSON message:', e);
        }
      };

      _ws.onerror = (err) => {
        _wsConnected = false;
        log('ERR', `WebSocket connection error on ${_currentHost}:${_currentPort}`);
        _updateUIStatus();
      };

      _ws.onclose = (event) => {
        _wsConnected = false;
        _agentOnline = false;
        _mavlinkOnline = false;
        log('SYS', `WebSocket closed (code: ${event.code}). Auto-reconnecting…`);
        _updateUIStatus();
        _scheduleReconnect();
      };

    } catch (e) {
      log('ERR', `Failed to open WebSocket: ${e.message}`);
      _scheduleReconnect();
    }
  }

  function disconnect() {
    if (_reconnectTimer) {
      clearTimeout(_reconnectTimer);
      _reconnectTimer = null;
    }
    _cleanupWs();
    _wsConnected = false;
    _agentOnline = false;
    _mavlinkOnline = false;
    _mavlinkError = 'Disconnected by operator';
    log('SYS', 'Link disconnected by operator.');
    _updateUIStatus();
  }

  function _cleanupWs() {
    if (_ws) {
      _ws.onopen = null;
      _ws.onmessage = null;
      _ws.onerror = null;
      _ws.onclose = null;
      try { _ws.close(); } catch (_) {}
      _ws = null;
    }
  }

  function _scheduleReconnect() {
    if (_reconnectTimer) return;
    _reconnectAttempts++;
    // Exponential backoff: 1.5s, 3s, 5s, max 8s
    const delay = Math.min(8000, 1500 * Math.pow(1.4, _reconnectAttempts - 1));
    _reconnectTimer = setTimeout(() => {
      _reconnectTimer = null;
      log('SYS', `Attempting auto-reconnect (${_reconnectAttempts}) to ${_currentHost}:${_currentPort}…`);
      connect(_currentHost, _currentPort);
    }, delay);
  }

  // ── Message Parsing ───────────────────────────────────────────
  function _handleIncomingMessage(msg) {
    // 1. Health / Status Packet from Pi Agent
    if (msg.type === 'status' || msg.status) {
      _agentOnline = true;
      const data = msg.data || msg.status;
      _lastStatusPacket = data;

      // Status notifications
      _statusHandlers.forEach(fn => fn(data));

      if (data.mavlink === 'online' && data.last_heartbeat) {
        _lastHeartbeatMs = Date.now();
        _mavlinkOnline = true;
        _mavlinkError = null;
      } else if (data.mavlink === 'offline' || data.mavlink === 'error') {
        _mavlinkOnline = false;
        _mavlinkError = data.mavlink_error || 'Pixhack MAVLink stream offline';
      }

      if (data.firmware) _telem.firmware = data.firmware;
      if (data.sysid)    _telem.sysid = data.sysid;
      if (data.compid)   _telem.compid = data.compid;

      _updateUIStatus();
      return;
    }

    // 2. Telemetry Packet from Pixhack
    if (msg.type === 'telemetry' && msg.data) {
      _agentOnline = true;
      _lastHeartbeatMs = Date.now();
      _mavlinkOnline = true;
      _mavlinkError = null;

      const d = msg.data;
      // Copy real fields strictly
      if (d.sysid !== undefined)       _telem.sysid = d.sysid;
      if (d.compid !== undefined)      _telem.compid = d.compid;
      if (d.firmware !== undefined)    _telem.firmware = d.firmware;
      if (d.mode !== undefined)        _telem.mode = d.mode;
      if (d.armed !== undefined)       _telem.armed = !!d.armed;
      if (d.alt !== undefined)         _telem.alt = d.alt;
      if (d.rel_alt !== undefined)     _telem.rel_alt = d.rel_alt;
      if (d.speed !== undefined)       _telem.speed = d.speed;
      if (d.airspeed !== undefined)    _telem.airspeed = d.airspeed;
      if (d.heading !== undefined)     _telem.heading = d.heading;
      if (d.pitch !== undefined)       _telem.pitch = d.pitch;
      if (d.roll !== undefined)        _telem.roll = d.roll;
      if (d.yaw !== undefined)         _telem.yaw = d.yaw;
      if (d.battery !== undefined)     _telem.battery = d.battery;
      if (d.battery_v !== undefined)   _telem.battery_v = d.battery_v;
      if (d.gps_fix !== undefined)     _telem.gps_fix = d.gps_fix;
      if (d.gps_sats !== undefined)    _telem.gps_sats = d.gps_sats;
      if (d.lat !== undefined)         _telem.lat = d.lat;
      if (d.lon !== undefined)         _telem.lon = d.lon;
      if (d.local_x !== undefined)     _telem.local_x = d.local_x;
      if (d.local_y !== undefined)     _telem.local_y = d.local_y;
      if (d.local_z !== undefined)     _telem.local_z = d.local_z;
      if (d.vx !== undefined)          _telem.vx = d.vx;
      if (d.vy !== undefined)          _telem.vy = d.vy;
      if (d.vz !== undefined)          _telem.vz = d.vz;
      if (d.rc_channels !== undefined) _telem.rc_channels = d.rc_channels;

      // Broadcast to HUD subscribers
      _msgHandlers.forEach(fn => fn(_telem));
      _updateUIStatus();
      return;
    }

    // Command Execution Confirmation from Pi / Pixhack
    if (msg.type === 'cmd_ack' || msg.type === 'ack') {
      const act = msg.action || 'COMMAND';
      const status = msg.status || 'OK';
      const dist = (msg.distance !== undefined) ? ` dist=${msg.distance}m` : '';
      const turn = (msg.turn !== undefined) ? ` turn=${msg.turn}°` : '';
      log('RX', `✓ [ACK ${status}] ${act}${dist}${turn}`);
      toast(`✓ Pixhack: ${msg.message || (act + ' ' + status)}`, 'ok', 3500);
      const cmdEl = document.getElementById('sb-cmd');
      if (cmdEl) cmdEl.textContent = `PIX: ${act}${dist}`;
      return;
    }

    // 3. Raw MAVLink packet format support
    if (msg.HEARTBEAT) {
      _lastHeartbeatMs = Date.now();
      _mavlinkOnline = true;
      _mavlinkError = null;
      _telem.armed = !!(msg.HEARTBEAT.base_mode & 128);
      const customMode = msg.HEARTBEAT.custom_mode;
      _telem.mode = COPTER_MODES[customMode] || `MODE_${customMode}`;
      _telem.sysid = msg.HEARTBEAT.sysid || 1;
      _telem.compid = msg.HEARTBEAT.compid || 1;
    }

    if (msg.ATTITUDE) {
      _telem.roll  = rad2deg(msg.ATTITUDE.roll);
      _telem.pitch = rad2deg(msg.ATTITUDE.pitch);
      _telem.yaw   = rad2deg(msg.ATTITUDE.yaw);
      _telem.heading = (_telem.yaw + 360) % 360;
    }

    if (msg.VFR_HUD) {
      _telem.alt      = msg.VFR_HUD.alt;
      _telem.airspeed = msg.VFR_HUD.airspeed;
      _telem.speed    = msg.VFR_HUD.groundspeed;
      if (msg.VFR_HUD.heading !== undefined) _telem.heading = msg.VFR_HUD.heading;
    }

    if (msg.GLOBAL_POSITION_INT) {
      _telem.rel_alt = msg.GLOBAL_POSITION_INT.relative_alt / 1000.0;
      _telem.lat     = msg.GLOBAL_POSITION_INT.lat / 1e7;
      _telem.lon     = msg.GLOBAL_POSITION_INT.lon / 1e7;
      if (msg.GLOBAL_POSITION_INT.vx !== undefined) _telem.vx = msg.GLOBAL_POSITION_INT.vx / 100.0;
      if (msg.GLOBAL_POSITION_INT.vy !== undefined) _telem.vy = msg.GLOBAL_POSITION_INT.vy / 100.0;
      if (msg.GLOBAL_POSITION_INT.vz !== undefined) _telem.vz = msg.GLOBAL_POSITION_INT.vz / 100.0;
    }

    if (msg.LOCAL_POSITION_NED) {
      _telem.local_x = msg.LOCAL_POSITION_NED.x;
      _telem.local_y = msg.LOCAL_POSITION_NED.y;
      _telem.local_z = msg.LOCAL_POSITION_NED.z;
      _telem.vx = msg.LOCAL_POSITION_NED.vx;
      _telem.vy = msg.LOCAL_POSITION_NED.vy;
      _telem.vz = msg.LOCAL_POSITION_NED.vz;
    }

    if (msg.SYS_STATUS) {
      _telem.battery   = msg.SYS_STATUS.battery_remaining;
      _telem.battery_v = msg.SYS_STATUS.voltage_battery / 1000.0;
    }

    if (msg.GPS_RAW_INT) {
      _telem.gps_fix  = msg.GPS_RAW_INT.fix_type;
      _telem.gps_sats = msg.GPS_RAW_INT.satellites_visible;
    }

    _msgHandlers.forEach(fn => fn(_telem));
    _updateUIStatus();
  }

  // ── Heartbeat Liveness Check ──────────────────────────────────
  function _checkHeartbeatLiveness() {
    const timeoutSec = Settings.get('heartbeatTimeout') || 3.0;
    const now = Date.now();

    if (_lastHeartbeatMs > 0 && (now - _lastHeartbeatMs) > (timeoutSec * 1000)) {
      if (_mavlinkOnline) {
        _mavlinkOnline = false;
        _mavlinkError = `Heartbeat lost (${((now - _lastHeartbeatMs)/1000).toFixed(1)}s ago)`;
        log('WARN', `Pixhack MAVLink heartbeat lost: ${_mavlinkError}`);
        _updateUIStatus();
      }
    }
  }

  // ── UI Status Synchronization ─────────────────────────────────
  function _updateUIStatus() {
    // 1. Pi Agent status badge
    const csPi = $('cs-pi');
    if (csPi) {
      if (_wsConnected && _agentOnline) {
        csPi.textContent = 'ONLINE';
        csPi.className   = 'cs-badge online';
      } else if (_wsConnected) {
        csPi.textContent = 'WAITING AGENT';
        csPi.className   = 'cs-badge pending';
      } else {
        csPi.textContent = 'OFFLINE';
        csPi.className   = 'cs-badge offline';
      }
    }

    // 2. MAVLink status badge
    const csMav = $('cs-mav');
    if (csMav) {
      if (_mavlinkOnline) {
        csMav.textContent = 'ONLINE';
        csMav.className   = 'cs-badge online';
        csMav.title       = `Pixhack SysID: ${_telem.sysid || 1} CompID: ${_telem.compid || 1}`;
      } else if (_mavlinkError) {
        csMav.textContent = 'OFFLINE';
        csMav.className   = 'cs-badge offline';
        csMav.title       = _mavlinkError;
      } else {
        csMav.textContent = 'OFFLINE';
        csMav.className   = 'cs-badge offline';
      }
    }

    // 3. Top HUD link dot
    const linkDot = $('link-dot');
    const valLink = $('val-link');
    if (linkDot && valLink) {
      if (_wsConnected && _mavlinkOnline) {
        linkDot.className   = 'link-dot online';
        valLink.textContent = 'ONLINE';
        valLink.style.color = 'var(--c-ok)';
      } else if (_wsConnected) {
        linkDot.className   = 'link-dot pending';
        valLink.textContent = 'NO MAVLINK';
        valLink.style.color = 'var(--c-warn)';
      } else {
        linkDot.className   = 'link-dot';
        valLink.textContent = 'OFFLINE';
        valLink.style.color = 'var(--c-danger)';
      }
    }

    // Diagnostics items if present
    const diagPi = $('diag-pi');
    if (diagPi) diagPi.textContent = (_wsConnected && _agentOnline) ? 'ONLINE' : 'OFFLINE';
    const diagMav = $('diag-mav');
    if (diagMav) diagMav.textContent = _mavlinkOnline ? 'ONLINE' : (_mavlinkError || 'OFFLINE');
    const diagWs = $('diag-ws');
    if (diagWs) diagWs.textContent = _wsConnected ? 'CONNECTED' : 'DISCONNECTED';
    const diagHb = $('diag-hb');
    if (diagHb) {
      if (_lastHeartbeatMs > 0) {
        const age = ((Date.now() - _lastHeartbeatMs) / 1000).toFixed(1);
        diagHb.textContent = `${age}s ago`;
      } else {
        diagHb.textContent = 'NEVER';
      }
    }
  }

  // ── MAVLink Commands (Explicit User Triggered Only) ───────────
  function arm() {
    if (!_wsConnected) { toast('Cannot ARM — WebSocket disconnected', 'danger'); return; }
    log('TX', 'CMD_COMPONENT_ARM_DISARM arm=1');
    _sendWs({ action: 'ARM' });
    toast('⚡ ARM command sent to Pixhack', 'warn', 3000);
  }

  function disarm() {
    if (!_wsConnected) { toast('Cannot DISARM — WebSocket disconnected', 'danger'); return; }
    log('TX', 'CMD_COMPONENT_ARM_DISARM arm=0');
    _sendWs({ action: 'DISARM' });
    toast('🔒 DISARM command sent to Pixhack', 'info', 3000);
  }

  function rtl() {
    if (!_wsConnected) { toast('Cannot send RTL — WebSocket disconnected', 'danger'); return; }
    log('TX', 'CMD_NAV_RETURN_TO_LAUNCH');
    _sendWs({ action: 'CMD_NAV_RETURN_TO_LAUNCH' });
    toast('↩ Return to Launch command sent', 'warn', 4000);
  }

  function land() {
    if (!_wsConnected) { toast('Cannot send LAND — WebSocket disconnected', 'danger'); return; }
    log('TX', 'CMD_NAV_LAND precision=1');
    _sendWs({ action: 'CMD_NAV_LAND' });
    toast('⬇ Precision landing command sent', 'warn', 4000);
  }

  function setMode(modeName) {
    if (!_wsConnected) return;
    log('TX', `SET_MODE ${modeName}`);
    _sendWs({ action: 'SET_MODE', mode: modeName });
  }

  function sendLateralCorrection(vyM_s, vxM_s = 0.5) {
    if (!_wsConnected) return;
    _sendWs({
      action: 'SET_POSITION_TARGET_LOCAL_NED',
      vy: vyM_s,
      vx: vxM_s
    });
  }

  function sendConditionYaw(targetAngleDeg, yawRateDegS = 20, relative = false) {
    if (!_wsConnected) return;
    _sendWs({
      action: 'CMD_CONDITION_YAW',
      angle: targetAngleDeg,
      rate: yawRateDegS,
      relative: !!relative
    });
  }

  function sendGuidedWaypoint(distM, turnDeg = 0.0, speedM_s = 1.39, altM = 0.0) {
    if (!_wsConnected) return;
    _sendWs({
      action: 'NAV_WAYPOINT_REL',
      distance: parseFloat(distM) || 0.0,
      turn: parseFloat(turnDeg) || 0.0,
      speed: parseFloat(speedM_s) || 1.39,
      alt: parseFloat(altM) || 0.0
    });
  }

  function sendPositionTargetLocalNED(vx = 0.0, vy = 0.0, vz = 0.0, x = null, y = null, z = null) {
    if (!_wsConnected) return;
    _sendWs({
      action: 'SET_POSITION_TARGET_LOCAL_NED',
      vx: vx,
      vy: vy,
      vz: vz,
      x: x,
      y: y,
      z: z
    });
  }

  function sendTakeoff(altM = 1.5) {
    if (!_wsConnected) { toast('Cannot Takeoff — WebSocket disconnected', 'danger'); return; }
    log('TX', `CMD_NAV_TAKEOFF alt=${altM}m`);
    _sendWs({ action: 'CMD_NAV_TAKEOFF', alt: altM });
    toast(`🛫 Takeoff command sent (Alt: ${altM}m)`, 'info', 3000);
  }

  function _sendWs(payload) {
    if (_ws && _ws.readyState === WebSocket.OPEN) {
      _ws.send(JSON.stringify(payload));
    }
  }


  // ── Logging ───────────────────────────────────────────────────
  function log(dir, msg) {
    if (!_logEl) return;
    const entry = document.createElement('div');
    entry.className = 'mav-entry';
    entry.innerHTML = `<span class="mav-ts">${nowTs()}</span><span class="mav-dir ${dir.toLowerCase()}">${dir}</span><span class="mav-msg">${msg}</span>`;
    _logEl.appendChild(entry);
    while (_logEl.children.length > 120) _logEl.removeChild(_logEl.firstChild);
    _logEl.scrollTop = _logEl.scrollHeight;
    if (dir === 'TX') {
      const el = $('sb-cmd');
      if (el) el.textContent = msg.slice(0, 28);
    }
  }

  // ── Diagnostics Hardware Test ─────────────────────────────────
  async function runHardwareDiagnostics() {
    const results = {
      test1_pi_reachable:    { pass: false, msg: '' },
      test2_ws_reachable:    { pass: false, msg: '' },
      test3_mavlink_hb:      { pass: false, msg: '' },
      test4_pixhack_fw:      { pass: false, msg: '' },
      test5_camera_detected: { pass: false, msg: '' },
      test6_camera_frames:   { pass: false, msg: '' },
      test7_telemetry:       { pass: false, msg: '' },
    };

    const host = _currentHost;
    const camPort = Settings.get('camPort') || 8080;
    const wsPort  = _currentPort || 8081;

    // TEST 1 — Pi HTTP reachable
    try {
      const res = await fetch(`http://${host}:${camPort}/health`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        const data = await res.json();
        results.test1_pi_reachable = { pass: true, msg: `Pi Agent reachable at http://${host}:${camPort}` };
        
        // TEST 5 — Camera detected from Agent
        if (data.camera === 'online') {
          results.test5_camera_detected = { pass: true, msg: `Camera sensor: ${data.camera_sensor || 'OV5647'} (Online)` };
        } else {
          results.test5_camera_detected = { pass: false, msg: data.camera_error || 'Camera hardware not reporting online' };
        }

        // Pixhack firmware from agent health
        if (data.firmware) {
          results.test4_pixhack_fw = { pass: true, msg: `Firmware: ${data.firmware} (SysID: ${data.sysid || 1})` };
        }
      } else {
        results.test1_pi_reachable = { pass: false, msg: `HTTP status ${res.status} from http://${host}:${camPort}` };
      }
    } catch (e) {
      results.test1_pi_reachable = { pass: false, msg: `Cannot connect to http://${host}:${camPort} (${e.message})` };
    }

    // TEST 2 — WebSocket reachable
    results.test2_ws_reachable = {
      pass: _wsConnected,
      msg: _wsConnected ? `WebSocket active on ws://${host}:${wsPort}` : `WebSocket disconnected on ws://${host}:${wsPort}`
    };

    // TEST 3 — MAVLink heartbeat
    const hbAge = _lastHeartbeatMs > 0 ? ((Date.now() - _lastHeartbeatMs)/1000).toFixed(1) : null;
    results.test3_mavlink_hb = {
      pass: _mavlinkOnline,
      msg: _mavlinkOnline ? `Heartbeat received (age: ${hbAge}s)` : (_mavlinkError || 'No MAVLink heartbeat received')
    };

    // TEST 4 — Pixhack Firmware (if not set by health, check telemetry)
    if (!results.test4_pixhack_fw.pass) {
      if (_telem.firmware || (_mavlinkOnline && _telem.mode)) {
        results.test4_pixhack_fw = {
          pass: true,
          msg: `Pixhack detected: ArduCopter Mode: ${_telem.mode} (SysID: ${_telem.sysid || 1})`
        };
      } else {
        results.test4_pixhack_fw = { pass: false, msg: 'Pixhack firmware not detected — check TELEM1 /dev/ttyS0 @ 57600' };
      }
    }

    // TEST 6 — Camera frames received
    const camStats = Camera.getStats ? Camera.getStats() : { framesReceived: 0, online: false };
    results.test6_camera_frames = {
      pass: camStats.online && camStats.framesReceived > 0,
      msg: camStats.online ? `Frames receiving: ${camStats.framesReceived} frames verified` : 'No video frames received by browser'
    };

    // TEST 7 — Telemetry received
    const hasTelem = _mavlinkOnline && (_telem.alt !== null || _telem.pitch !== null || _telem.battery !== null);
    results.test7_telemetry = {
      pass: hasTelem,
      msg: hasTelem ? `Telemetry active: Alt=${fmt(_telem.alt,1)}m, Roll=${fmt(_telem.roll,1)}°, Batt=${fmt(_telem.battery,0)}%` : 'No telemetry data received'
    };

    return results;
  }

  // ── Subscriptions & Getters ───────────────────────────────────
  function onTelemetry(fn) { _msgHandlers.push(fn); }
  function onStatus(fn)    { _statusHandlers.push(fn); }
  function getTelem()      { return { ..._telem }; }
  function isWsConnected() { return _wsConnected; }
  function isAgentOnline() { return _agentOnline; }
  function isMavlinkOnline(){ return _mavlinkOnline; }
  function getMavlinkError(){ return _mavlinkError; }
  function getLastHeartbeatAge() {
    return _lastHeartbeatMs > 0 ? (Date.now() - _lastHeartbeatMs) / 1000 : null;
  }

  return {
    init,
    connect,
    disconnect,
    isWsConnected,
    isAgentOnline,
    isMavlinkOnline,
    getMavlinkError,
    getLastHeartbeatAge,
    onTelemetry,
    onStatus,
    getTelem,
    arm,
    disarm,
    rtl,
    land,
    setMode,
    sendLateralCorrection,
    sendConditionYaw,
    sendGuidedWaypoint,
    sendPositionTargetLocalNED,
    sendTakeoff,
    log,
    runHardwareDiagnostics
  };
})();

