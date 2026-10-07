/* ═══════════════════════════════════════════════════════════════
   Settings — Persistent configuration store with localStorage
   Centralized network and system configuration for VISIONPATH
   
   NOTE: Network defaults are seeded from CONFIG (config.js).
   CONFIG is the single source of truth for hardware addresses.
═══════════════════════════════════════════════════════════════ */
'use strict';

const Settings = (() => {
  const _STORAGE_KEY = 'visionpath_settings_v4';

  // Seed defaults from CONFIG if available, otherwise use hardcoded values
  const _cfgPiIp      = (typeof CONFIG !== 'undefined') ? CONFIG.PI_IP           : '10.89.89.85';
  const _cfgCamHost   = (typeof CONFIG !== 'undefined') ? CONFIG.CAMERA_HOST     : '10.89.89.85';
  const _cfgCamPort   = (typeof CONFIG !== 'undefined') ? CONFIG.CAMERA_PORT     : 8080;
  const _cfgCamPath   = (typeof CONFIG !== 'undefined') ? CONFIG.CAMERA_STREAM_PATH : '/stream.mjpg';
  const _cfgWsHost    = (typeof CONFIG !== 'undefined') ? CONFIG.MAVLINK_WS_HOST : '127.0.0.1';
  const _cfgWsPort    = (typeof CONFIG !== 'undefined') ? CONFIG.MAVLINK_WS_PORT : 8081;

  const _defaults = {
    wsHost:           _cfgWsHost,    // 127.0.0.1 (Localhost bridge) or 10.89.89.85 (Pi)
    wsPort:           _cfgWsPort,    // Port 8081 -- WebSocket telemetry
    piHost:           _cfgPiIp,      // 10.89.89.85 (Raspberry Pi hardware IP)
    camHost:          _cfgCamHost,   // 10.89.89.85 (Dedicated Pi Camera stream host, never localhost)
    camPort:          _cfgCamPort,   // Port 8080 -- camera_server.py
    camPath:          _cfgCamPath,   // /stream.mjpg
    heartbeatTimeout: 3.0,           // seconds before MAVLink marked OFFLINE
    corrThresh:       2.0,           // meters
    maxAngle:         15,            // degrees
    approachSpeed:    1.5,           // m/s
    descentRate:      0.3,           // m/s
    hoverTime:        3,             // s
    scanLines:        true,
    autoCorrect:      false,         // safety first
    showPrediction:   true,
    camSource:        'pi',          // default to real Pi Camera
    camRes:           '1280x720',
  };

  let _vals = { ..._defaults };

  // Load saved preferences from localStorage
  try {
    const saved = localStorage.getItem(_STORAGE_KEY);
    if (saved) {
      _vals = { ..._defaults, ...JSON.parse(saved) };
    }
  } catch (e) {
    console.warn('Could not read localStorage for settings:', e);
  }

  // Ensure camera host is always the real Pi IP (never 127.0.0.1/localhost)
  if (!_vals.camHost || _vals.camHost === '127.0.0.1' || _vals.camHost === 'localhost') {
    _vals.camHost = _cfgCamHost;
  }

  function get(k) {
    return _vals[k] !== undefined ? _vals[k] : _defaults[k];
  }

  function set(k, v) {
    _vals[k] = v;
    _save();
  }

  function _save() {
    try {
      localStorage.setItem(_STORAGE_KEY, JSON.stringify(_vals));
    } catch (e) {
      console.warn('Could not save settings to localStorage:', e);
    }
  }

  // Centralized URL and endpoint getters
  function getWsHost() {
    return (get('wsHost') || (typeof CONFIG !== 'undefined' ? CONFIG.MAVLINK_WS_HOST : '127.0.0.1')).trim();
  }

  function getWsPort() {
    return parseInt(get('wsPort') || 8081);
  }

  function getWsUrl() {
    return `ws://${getWsHost()}:${getWsPort()}`;
  }

  function getCameraHost() {
    const h = (get('camHost') || (typeof CONFIG !== 'undefined' ? CONFIG.CAMERA_HOST : '10.89.89.85')).trim();
    return (h === '127.0.0.1' || h === 'localhost') ? '10.89.89.85' : h;
  }

  function getPiHost() {
    return getCameraHost();
  }

  function getCameraPort() {
    return parseInt(get('camPort') || (typeof CONFIG !== 'undefined' ? CONFIG.CAMERA_PORT : 8080));
  }

  function getCameraStreamPath() {
    let p = (get('camPath') || (typeof CONFIG !== 'undefined' ? CONFIG.CAMERA_STREAM_PATH : '/stream.mjpg')).trim();
    if (!p.startsWith('/')) p = '/' + p;
    return p;
  }

  function getCameraStreamUrl() {
    return `http://${getCameraHost()}:${getCameraPort()}${getCameraStreamPath()}`;
  }

  function getCameraHealthUrl() {
    return `http://${getCameraHost()}:${getCameraPort()}/health`;
  }

  function loadFromUI() {
    _vals.wsHost           = ($('conn-host')?.value || $('set-ws-host')?.value || _vals.wsHost).trim();
    _vals.wsPort           = parseInt($('conn-port')?.value || $('set-ws-port')?.value || _vals.wsPort);
    _vals.camHost          = ($('conn-cam-host')?.value || _vals.camHost || _cfgCamHost).trim();
    _vals.camPort          = parseInt($('conn-cam-port')?.value || $('set-cam-port')?.value || _vals.camPort);
    _vals.camPath          = ($('conn-cam-path')?.value || $('set-cam-path')?.value || _vals.camPath || '/stream.mjpg').trim();
    _vals.heartbeatTimeout = parseFloat($('set-hb-timeout')?.value) || 3.0;
    _vals.corrThresh       = parseFloat($('set-thresh')?.value)    || 2.0;
    _vals.maxAngle         = parseFloat($('set-max-angle')?.value) || 15;
    _vals.approachSpeed    = parseFloat($('set-speed')?.value)     || 1.5;
    _vals.descentRate      = parseFloat($('set-descent')?.value)   || 0.3;
    _vals.hoverTime        = parseFloat($('set-hover')?.value)     || 3;
    _vals.scanLines        = $('set-scanlines')?.checked  ?? true;
    _vals.autoCorrect      = $('set-autocorrect')?.checked ?? false;
    _vals.showPrediction   = $('set-prediction')?.checked  ?? true;
    _vals.camSource        = $('set-cam-src')?.value || 'pi';
    _vals.camRes           = $('set-cam-res')?.value || '1280x720';
    _save();
  }

  function syncToUI() {
    const connHost = $('conn-host');
    if (connHost) connHost.value = _vals.wsHost;
    const connPort = $('conn-port');
    if (connPort) connPort.value = _vals.wsPort;
    const connCamPort = $('conn-cam-port');
    if (connCamPort) connCamPort.value = _vals.camPort;
    const connCamPath = $('conn-cam-path');
    if (connCamPath) connCamPath.value = _vals.camPath || '/stream.mjpg';
    
    const setHost = $('set-ws-host') || $('set-pi-host');
    if (setHost) setHost.value = _vals.wsHost;
    const setWsPort = $('set-ws-port');
    if (setWsPort) setWsPort.value = _vals.wsPort;
    const setCamPort = $('set-cam-port');
    if (setCamPort) setCamPort.value = _vals.camPort;
    const setCamPath = $('set-cam-path');
    if (setCamPath) setCamPath.value = _vals.camPath || '/stream.mjpg';
    const setCamUrl = $('set-cam-url');
    if (setCamUrl) setCamUrl.value = getCameraStreamUrl();
    const setHb = $('set-hb-timeout');
    if (setHb) setHb.value = _vals.heartbeatTimeout;
  }

  return {
    get,
    set,
    loadFromUI,
    syncToUI,
    getWsHost,
    getWsPort,
    getWsUrl,
    getPiHost,
    getCameraHost,
    getCameraPort,
    getCameraStreamPath,
    getCameraStreamUrl,
    getCameraHealthUrl,
    defaults: _defaults
  };
})();
