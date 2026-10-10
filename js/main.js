/* ═══════════════════════════════════════════════════════════════
   main.js — Application bootstrap & main loop orchestrator
   
   Initialization order:
   1. Boot splash animation
   2. Init all modules
   3. Start simulation
   4. Start MAVLink telemetry
   5. Wire up UI events
   6. Run main render loop
═══════════════════════════════════════════════════════════════ */
'use strict';

// ── Boot splash ────────────────────────────────────────────────
const BOOT_STEPS = [
  'Loading vision engine…',
  'Initializing calibration module…',
  'Starting MAVLink interface…',
  'Connecting camera pipeline…',
  'Loading path manager…',
  'Starting HUD renderer…',
  'System ready.',
];

let _startTime = Date.now();
let _uptime    = 0;
let _mainRafId = null;

// Run boot sequence then start app
window.addEventListener('load', () => {
  const bar    = $('boot-bar');
  const status = $('boot-status');
  let step = 0;

  const interval = setInterval(() => {
    if (step < BOOT_STEPS.length) {
      status.textContent = BOOT_STEPS[step];
      bar.style.width    = `${((step + 1) / BOOT_STEPS.length) * 100}%`;
      step++;
    } else {
      clearInterval(interval);
      setTimeout(_launch, 500);
    }
  }, 280);
});

function _launch() {
  // Fade out splash
  const splash = $('boot-splash');
  splash.classList.add('fade-out');
  setTimeout(() => splash.classList.add('hidden'), 600);

  // Show app
  const app = $('app');
  app.classList.remove('hidden');
  requestAnimationFrame(() => app.classList.add('visible'));

  // ── Init modules ──────────────────────────────────────────────
  _initCanvasSizes();

  MAVLink.init();
  HUD.init();
  DeviationEngine.init();
  Camera.init();
  TopDownMap.init($('pip-map-canvas'));

  // Init simulation
  Simulation.init($('sim-canvas'));
  Simulation.start();

  // Init path manager with overlay canvas
  const overlay = $('overlay-canvas');
  PathManager.init(overlay, _onWaypointsChanged);

  // Start telemetry & recording stream
  MAVLink.onTelemetry(telem => {
    HUD.updateTelemetry(telem);
    const dev = DeviationEngine.getMetrics ? DeviationEngine.getMetrics() : { xte: 0, ate: 0, side: 0 };
    FlightRecorder.recordSample(telem, dev, PathManager.getActiveIdx());
  });

  // Sync saved Settings values into UI fields before auto-connecting
  Settings.syncToUI();

  // Auto-start MAVLink connection using saved/default host (localhost:8081 default)
  const initHost = (typeof Settings.getWsHost === 'function') ? Settings.getWsHost() : (Settings.get('wsHost') || '127.0.0.1');
  const initPort = Settings.get('wsPort') || 8081;
  MAVLink.connect(initHost, initPort);

  // Auto-start Pi camera (real MJPEG stream from 10.89.89.85:8080)
  Camera.setSource('pi');

  // Wire all UI events
  _wireEvents();

  // Populate default calibration result
  Calibration.updateFromInputs();
  Calibration.calibrate();

  // Status bar time
  _updateClock();
  setInterval(_updateClock, 1000);

  // Start main loop
  _mainLoop();

  toast(`VISIONPATH GCS Ready — MAVLink: ${initHost}:${initPort} | Camera: 10.89.89.85:8080`, 'ok', 4000);
  MAVLink.log('SYS', `System initialized — connecting to MAVLink Bridge at ws://${initHost}:${initPort}`);
}

// ── Main render loop ──────────────────────────────────────────
let _loopFrame = 0;
let _lastFrameTime = performance.now();

function _mainLoop(now) {
  _loopFrame++;
  const curTime = (typeof now === 'number') ? now : performance.now();
  const dt = Math.min(0.1, (curTime - _lastFrameTime) / 1000) || 0.016;
  _lastFrameTime = curTime;
  _uptime = (Date.now() - _startTime) / 1000;

  // ── 1. Telemetry State Sync ─────────────────────────────────
  let telem = MAVLink.getTelem ? MAVLink.getTelem() : {};
  if (Simulation.isRunning() && (!MAVLink.isMavlinkOnline() || telem.heading === null)) {
    const simDrone = Simulation.getDrone();
    telem = {
      alt: (simDrone.alt || 150) / 100,
      airspeed: 0.0,
      speed: 0.0,
      heading: simDrone.yaw || 0,
      pitch: simDrone.pitch || 0,
      roll: simDrone.roll || 0,
      battery: simDrone.batt || 88,
      mode: 'ALT_HOLD',
      armed: true
    };
    HUD.updateTelemetry(telem);
  }

  // ── 2. Update PathManager Navigation & Progress ─────────────
  const navEvent = PathManager.updateNavigation(dt, telem);
  if (navEvent) {
    _onWaypointsChanged(PathManager.getWaypoints(), PathManager.getActiveIdx());
  }

  // ── 3. Drone screen position (center-bottom with dynamic drift) ──
  const overlay = $('overlay-canvas');
  const overlayW = overlay ? overlay.width : 960;
  const overlayH = overlay ? overlay.height : 540;
  const droneX = overlayW / 2;
  const droneY = overlayH * 0.82;

  // ── 4. Path deviation computation ───────────────────────────
  const dev = PathManager.getDeviation(droneX, droneY);
  DeviationEngine.update(dev.xte, dev.ate, dev.side);

  // ── 5. Draw Dynamic AR Path & Drone Overlay ─────────────────
  PathManager.draw(droneX, droneY);

  // ── 6. Draw 2D Top-Down Metric Ground Map (PIP) ─────────────
  const wps = PathManager.getWaypoints();
  const ai  = PathManager.getActiveIdx();
  const droneMetricPos = PathManager.getDronePos();
  TopDownMap.render(wps, ai, dev.xteM || 0, telem.heading || 0, droneMetricPos);

  // ── 7. Draw Scale ruler ─────────────────────────────────────
  if (_loopFrame % 30 === 0) HUD.drawScaleRuler();

  // ── 8. Update waypoint info bar ─────────────────────────────
  const cibWp  = $('cib-wp');
  const cibNwp = $('cib-nwp');
  if (cibWp)  cibWp.textContent  = wps.length > 0 ? `${ai + 1}/${wps.length}` : '—/—';
  if (cibNwp && wps.length > 0 && ai < wps.length) {
    const nextWp = wps[Math.min(ai, wps.length - 1)];
    const distRem = (dev.distRem !== undefined && dev.distRem > 0) ? dev.distRem : nextWp.distFromPrev;
    const turnStr = (nextWp.turnAngleDeg !== undefined)
      ? ` • ${nextWp.turnAngleDeg > 2 ? '+' : ''}${fmt(nextWp.turnAngleDeg, 0)}°`
      : '';
    cibNwp.textContent = `${fmt(distRem, 1)} m${turnStr}`;
  } else if (cibNwp) cibNwp.textContent = '— m';

  // ── 9. Sim-to-overlay sync (deviation feed from sim) ────────
  if (Simulation.isRunning()) {
    const pathOff = Simulation.getPathOffset();
    const el = $('val-dev');
    if (el && !PathManager.isFollowing()) {
      el.textContent = fmt(Math.abs(pathOff * 0.002), 2);
    }
  }

  _mainRafId = requestAnimationFrame(_mainLoop);
}

// ── Canvas sizing ──────────────────────────────────────────────
function _initCanvasSizes() {
  _resizeCanvases();
  window.addEventListener('resize', _resizeCanvases);
}

function _resizeCanvases() {
  const viewport = $('cam-viewport');
  if (!viewport) return;
  const rect = viewport.getBoundingClientRect();
  const W = Math.floor(rect.width);
  const H = Math.floor(rect.height);

  [$('sim-canvas'), $('overlay-canvas')].forEach(cvs => {
    if (cvs) { cvs.width = W; cvs.height = H; }
  });

  Calibration.setImageSize(W, H);
  PathManager.resize(W, H);
}

// ── Waypoint list renderer with exact Distance & Turn fields ───
function _onWaypointsChanged(wps, activeIdx) {
  const list = $('wp-list');
  if (!list) return;
  list.innerHTML = '';

  if (wps.length === 0) {
    list.innerHTML = '<div style="color:var(--c-text-muted);font-size:10px;text-align:center;padding:12px">No waypoints. Use DRAW PATH tab to click and place waypoints on the camera feed.</div>';
    $('path-status-badge').className = '';
    $('psb-label').textContent = 'NO PATH DEFINED';
    return;
  }

  wps.forEach((wp, i) => {
    const item = document.createElement('div');
    const isAct = (i === activeIdx && PathManager.isFollowing());
    item.className = `wp-item${isAct ? ' active' : ''}${wp.reached ? ' reached' : ''}${wp.final ? ' final' : ''}`;
    
    const turnVal = wp.turnAngleDeg || 0;
    const turnClass = turnVal > 2 ? 'right' : turnVal < -2 ? 'left' : 'straight';
    const turnText = turnVal > 2 ? `↷ +${fmt(turnVal, 0)}° R` : turnVal < -2 ? `↶ ${fmt(turnVal, 0)}° L` : '▲ 0° STR';

    item.innerHTML = `
      <div class="wp-num">${i + 1}</div>
      <div class="wp-info">
        <div class="wp-header-row">
          <span class="wp-label">${wp.label}${wp.final ? ' 🛬' : ''}</span>
          <span class="wp-turn-badge ${turnClass}" title="Turn angle relative to path heading">${turnText}</span>
        </div>
        <div class="wp-metric-row">
          <label class="wp-dist-label" title="Exact measured distance to this waypoint">
            <span>Dist:</span>
            <input type="number" step="0.1" min="0.2" max="100" class="wp-dist-input" value="${fmt(wp.distFromPrev || 2.0, 2)}"
                   onchange="PathManager.setWaypointDistance(${i}, this.value)"
                   onclick="event.stopPropagation()" />
            <span>m</span>
          </label>
          <span class="wp-hdg-tag">HDG ${fmt(wp.targetHeading || 0, 0)}°</span>
          <button class="wp-fly-btn" title="Send this waypoint distance to Raspberry Pi & Pixhack" onclick="event.stopPropagation(); PathManager.executeWaypointIndex(${i})">▶ FLY</button>
        </div>
      </div>
      <button class="wp-del" title="Remove Waypoint" onclick="event.stopPropagation(); PathManager.removeWaypoint(${i})">✕</button>
    `;
    list.appendChild(item);
  });

  // Update path badge
  const badge = $('path-status-badge');
  const badgeLbl = $('psb-label');
  if (PathManager.isFollowing()) {
    badge.className = 'active';
    badgeLbl.textContent = `FOLLOWING — WP ${activeIdx + 1}/${wps.length}`;
  } else {
    badge.className = '';
    badgeLbl.textContent = `PATH DEFINED — ${wps.length} WP`;
  }

  // WP info bar
  $('cib-wp').textContent = `${activeIdx + 1}/${wps.length}`;
}


// ── Clock & uptime ─────────────────────────────────────────────
function _updateClock() {
  const t = new Date();
  const ts = `${t.getHours().toString().padStart(2,'0')}:${t.getMinutes().toString().padStart(2,'0')}:${t.getSeconds().toString().padStart(2,'0')}`;
  const timeEl = $('sb-time');
  if (timeEl) timeEl.textContent = ts;
  const uptEl = $('sb-uptime');
  if (uptEl) uptEl.textContent = formatTime(Math.floor((Date.now() - _startTime) / 1000));
}

// ══════════════════════════════════════════════════════════════
//  UI Event Wiring
// ══════════════════════════════════════════════════════════════
function _wireEvents() {

  // ── Tab switching ──────────────────────────────────────────
  document.querySelectorAll('.cam-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.cam-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const mode = tab.dataset.tab;
      PathManager.setDrawMode(mode === 'draw');
      if (mode === 'follow') {
        toast('PATH FOLLOW mode', 'info', 1500);
      } else if (mode === 'calibrate') {
        toast('CALIBRATE mode — place reference object', 'info', 2000);
      } else if (mode === 'draw') {
        toast('DRAW mode — click on camera feed to place waypoints', 'info', 2500);
      }
    });
  });

  // ── Camera controls ─────────────────────────────────────────
  $('btn-cam-source').addEventListener('click', () => {
    const src = Camera.getSource();
    const next = src === 'pi' ? 'webcam' : src === 'webcam' ? 'sim' : 'pi';
    Camera.setSource(next);
    toast(`Camera: ${next.toUpperCase()}`, 'info');
    if ($('set-cam-src')) $('set-cam-src').value = next;
  });

  $('btn-clear-path').addEventListener('click', () => {
    PathManager.clearAll();
    _onWaypointsChanged([], 0);
    toast('Path cleared', 'warn');
  });

  // ── Flight Recorder & 2D Map ────────────────────────────────
  const btnRec = $('btn-rec');
  if (btnRec) {
    btnRec.addEventListener('click', () => FlightRecorder.toggle());
  }

  const btnMap = $('btn-toggle-map');
  if (btnMap) {
    btnMap.addEventListener('click', () => {
      const vis = TopDownMap.toggle();
      toast(vis ? '2D Metric Map ON' : '2D Metric Map HIDDEN', 'info', 1500);
    });
  }

  $('btn-export').addEventListener('click', () => {
    const wps = PathManager.getWaypoints();
    const json = JSON.stringify({ waypoints: wps, calibration: Calibration.getState() }, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const a    = document.createElement('a');
    a.href     = URL.createObjectURL(blob);
    a.download = `visionpath_${Date.now()}.json`;
    a.click();
    toast('✓ Path exported', 'ok');
  });

  $('btn-demo').addEventListener('click', () => {
    if (Simulation.isRunning()) {
      Simulation.stop();
      toast('Demo simulation stopped', 'warn');
      $('btn-demo').classList.remove('active');
    } else {
      Simulation.start();
      toast('Demo simulation started', 'ok');
      $('btn-demo').classList.add('active');
    }
  });

  // ── Waypoints ───────────────────────────────────────────────
  $('btn-add-wp').addEventListener('click', () => {
    // Add at center of camera
    const o = $('overlay-canvas');
    PathManager.addWaypoint(o.width / 2 + (Math.random() - 0.5) * 60, o.height * (0.3 + Math.random() * 0.4));
    _onWaypointsChanged(PathManager.getWaypoints(), PathManager.getActiveIdx());
  });

  $('btn-start-follow').addEventListener('click', () => {
    PathManager.startFollow();
    _onWaypointsChanged(PathManager.getWaypoints(), PathManager.getActiveIdx());
  });

  $('btn-pause-follow').addEventListener('click', () => {
    PathManager.pauseFollow();
    _onWaypointsChanged(PathManager.getWaypoints(), PathManager.getActiveIdx());
  });

  const btnDirect = $('btn-send-direct-dist');
  if (btnDirect) {
    btnDirect.addEventListener('click', () => {
      const distInput = $('direct-cmd-dist');
      const turnInput = $('direct-cmd-turn');
      const dist = distInput ? parseFloat(distInput.value) : 2.0;
      const turn = turnInput ? parseFloat(turnInput.value) : 0.0;
      if (isNaN(dist) || dist <= 0) {
        toast('Please enter a valid distance (> 0m)', 'warn');
        return;
      }
      MAVLink.setMode('GUIDED');
      MAVLink.log('TX', `DIRECT WP DISTANCE: dist=${dist}m turn=${turn}°`);
      MAVLink.sendGuidedWaypoint(dist, turn, 1.39);
      toast(`🚀 Sent Waypoint Command (${dist}m, ${turn}°) to Pi & Pixhack!`, 'info', 3000);
    });
  }

  // ── Calibration ──────────────────────────────────────────────
  $('btn-calibrate').addEventListener('click', () => {
    Calibration.updateFromInputs();
    Calibration.calibrate();
    DeviationEngine.setThreshold(Settings.get('corrThresh'));
  });

  $('btn-open-cal-wizard').addEventListener('click', () => {
    $('modal-cal-wizard').classList.remove('hidden');
    _initWizardCam();
  });

  $('close-cal-wizard').addEventListener('click', () => {
    $('modal-cal-wizard').classList.add('hidden');
  });

  // ── Photo / Video Capture on Raspberry Pi ────────────────────
  const btnSnap = $('btn-snap-photo');
  if (btnSnap) {
    btnSnap.addEventListener('click', () => Camera.capturePhoto());
  }

  const btnVideoRec = $('btn-rec-video');
  if (btnVideoRec) {
    btnVideoRec.addEventListener('click', () => Camera.toggleVideoRecording());
  }

  // ── Saved Media Gallery Modal ────────────────────────────────
  const btnGallery = $('btn-open-gallery');
  if (btnGallery) {
    btnGallery.addEventListener('click', () => {
      $('modal-gallery').classList.remove('hidden');
      _renderGallery();
    });
  }

  const closeGal = $('close-gallery');
  if (closeGal) {
    closeGal.addEventListener('click', () => $('modal-gallery').classList.add('hidden'));
  }

  const btnRefreshGal = $('btn-refresh-gallery');
  if (btnRefreshGal) {
    btnRefreshGal.addEventListener('click', () => _renderGallery());
  }

  // ── Quick Host Switcher (Pi vs Localhost) ────────────────────
  const btnQuickPi = $('btn-quick-pi');
  if (btnQuickPi) {
    btnQuickPi.addEventListener('click', () => {
      const hostInput = $('conn-host');
      if (hostInput) hostInput.value = '10.89.89.85';
      toast('Host set to Raspberry Pi: 10.89.89.85', 'info', 2000);
    });
  }

  const btnQuickLocal = $('btn-quick-local');
  if (btnQuickLocal) {
    btnQuickLocal.addEventListener('click', () => {
      const hostInput = $('conn-host');
      if (hostInput) hostInput.value = '127.0.0.1';
      toast('Host set to Localhost: 127.0.0.1', 'info', 2000);
    });
  }

  // ── Connection ───────────────────────────────────────────────
  $('btn-connect').addEventListener('click', () => {
    const host = ($('conn-host').value || '127.0.0.1').trim();
    const port = parseInt($('conn-port').value || '8081');
    const camPort = parseInt($('conn-cam-port').value || '8080');
    const camPath = ($('conn-cam-path')?.value || '/stream.mjpg').trim();
    Settings.set('wsHost', host);
    Settings.set('wsPort', port);
    Settings.set('camPort', camPort);
    Settings.set('camPath', camPath);
    MAVLink.connect(host, port);
    Camera.setSource('pi');
    $('btn-disconnect').disabled = false;
    $('btn-connect').disabled    = true;
    toast(`⚡ Connecting to MAVLink at ${host}:${port} | Camera: 10.89.89.85:${camPort}${camPath}`, 'info', 3500);
  });

  $('btn-disconnect').addEventListener('click', () => {
    MAVLink.disconnect();
    Camera.setSource('sim');
    ['cs-mav','cs-cam','cs-pi'].forEach(id => { $(id).textContent='OFFLINE'; $(id).className='cs-badge offline'; });
    $('btn-disconnect').disabled = true;
    $('btn-connect').disabled    = false;
    toast('Disconnected link', 'warn');
  });

  // ── ARM / RTL / LAND ─────────────────────────────────────────
  $('btn-arm').addEventListener('click', () => {
    const t = MAVLink.getTelem();
    if (t.armed) MAVLink.disarm(); else MAVLink.arm();
  });
  $('btn-rtl').addEventListener('click', () => MAVLink.rtl());
  $('btn-land').addEventListener('click', () => MAVLink.land());

  // ── Settings modal ───────────────────────────────────────────
  $('btn-settings').addEventListener('click', () => $('modal-settings').classList.remove('hidden'));
  $('close-settings').addEventListener('click', () => $('modal-settings').classList.add('hidden'));

  $('btn-save-settings').addEventListener('click', () => {
    Settings.loadFromUI();
    DeviationEngine.setThreshold(Settings.get('corrThresh'));
    $('sb-thresh').textContent = `${fmt(Settings.get('corrThresh'),2)} m`;
    $('sb-auto').textContent   = Settings.get('autoCorrect') ? 'ON' : 'OFF';

    // Scan lines toggle
    const scanEl = $('scan-lines');
    if (scanEl) scanEl.style.display = Settings.get('scanLines') ? '' : 'none';

    // Camera source
    Camera.setSource(Settings.get('camSource'));
    $('modal-settings').classList.add('hidden');
    toast('✓ Settings saved', 'ok');
  });

  // ── Keyboard shortcuts ───────────────────────────────────────
  window.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT') return;
    switch (e.key) {
      case 'd': // draw mode
        $('tab-draw').click(); break;
      case 'f': // follow mode
        $('tab-follow').click(); break;
      case 'c': // calibrate tab
        $('tab-calibrate').click(); break;
      case 'p': // photo capture
        Camera.capturePhoto(); break;
      case 'v': // video recording toggle
        Camera.toggleVideoRecording(); break;
      case ' ':
        e.preventDefault();
        if (PathManager.isFollowing()) PathManager.pauseFollow();
        else PathManager.startFollow();
        break;
      case 'Escape':
        document.querySelectorAll('.modal-backdrop').forEach(m => m.classList.add('hidden'));
        break;
    }
  });

  // ── Close modals on backdrop click ───────────────────────────
  document.querySelectorAll('.modal-backdrop').forEach(m => {
    m.addEventListener('click', e => { if (e.target === m) m.classList.add('hidden'); });
  });

  // ── Wizard cam canvas init ───────────────────────────────────
  const wizCam = $('wiz-cam');
  if (wizCam) {
    wizCam.addEventListener('click', e => {
      const rect = wizCam.getBoundingClientRect();
      const x = (e.clientX - rect.left) * (wizCam.width / rect.width);
      const y = (e.clientY - rect.top)  * (wizCam.height / rect.height);
      Calibration.setWizardMark(x, y);

      // Draw marker on wizard canvas
      const ctx = wizCam.getContext('2d');
      _drawWizardMark(ctx, wizCam.width, wizCam.height, x, y);
      $('wiz-mark-info').textContent = `Marked at (${Math.round(x)}, ${Math.round(y)}) — pixel offset from center: ${Math.round(Math.abs(x - wizCam.width/2))}px`;
      $('wiz-btn-2').disabled = false;
    });
  }
}

// ── Render Saved Media Gallery ─────────────────────────────────
async function _renderGallery() {
  const grid = $('gallery-grid');
  const stats = $('gallery-stats');
  if (!grid) return;

  stats.textContent = 'Loading captures from Raspberry Pi…';
  grid.innerHTML = '<div class="gallery-empty">Fetching media list from Raspberry Pi…</div>';

  const host = Settings.getPiHost();
  const camPort = Settings.getCameraPort();
  const items = await Camera.fetchCaptures();

  if (items.length === 0) {
    stats.textContent = `0 items found on Raspberry Pi (${host}:${camPort})`;
    grid.innerHTML = `
      <div class="gallery-empty">
        No photos or videos saved yet on Raspberry Pi (${host}).<br><br>
        Click <strong>📸 PHOTO</strong> or <strong>⏺ REC</strong> on the camera toolbar to capture media!
      </div>
    `;
    return;
  }

  const photosCount = items.filter(i => i.type === 'photo').length;
  const videosCount = items.filter(i => i.type === 'video').length;
  stats.textContent = `${items.length} total captures on Pi (${photosCount} photos, ${videosCount} videos)`;
  grid.innerHTML = '';

  items.forEach(item => {
    const card = document.createElement('div');
    card.className = 'media-card';
    const mediaUrl = `http://${host}:${camPort}${item.url}`;
    const sizeKb = Math.round((item.sizeBytes || 0) / 1024);
    const sizeStr = sizeKb > 1024 ? `${(sizeKb/1024).toFixed(1)} MB` : `${sizeKb} KB`;

    card.innerHTML = `
      <div class="media-thumb-wrap">
        ${item.type === 'photo'
          ? `<img class="media-thumb" src="${mediaUrl}" alt="${item.filename}" loading="lazy" onerror="this.src='data:image/svg+xml;utf8,<svg xmlns=\\'http://www.w3.org/2000/svg\\' width=\\'100\\' height=\\'100\\'><rect fill=\\'%23111\\' width=\\'100\\' height=\\'100\\'/><text fill=\\'%2300e5ff\\' x=\\'50%\\' y=\\'50%\\' text-anchor=\\'middle\\'>IMAGE</text></svg>'"/>`
          : `<div class="media-video-icon">🎥</div>`
        }
        <span class="media-badge ${item.type}">${item.type}</span>
      </div>
      <div class="media-info">
        <div class="media-name" title="${item.filename}">${item.filename}</div>
        <div class="media-meta">
          <span>${item.timestamp || '—'}</span>
          <span>${sizeStr}</span>
        </div>
        <div class="media-actions">
          <a class="media-btn" href="${mediaUrl}" target="_blank" download="${item.filename}">⬇ Save</a>
          <button class="media-btn btn-del" data-name="${item.filename}">🗑 Del</button>
        </div>
      </div>
    `;

    const delBtn = card.querySelector('.btn-del');
    if (delBtn) {
      delBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (confirm(`Delete ${item.filename} from Raspberry Pi?`)) {
          const ok = await Camera.deleteCapture(item.filename);
          if (ok) _renderGallery();
        }
      });
    }

    grid.appendChild(card);
  });

}

// ── Wizard camera canvas ───────────────────────────────────────
function _initWizardCam() {
  const wizCam = $('wiz-cam');
  if (!wizCam) return;
  const ctx = wizCam.getContext('2d');
  const W = wizCam.width, H = wizCam.height;

  // Draw a copy of the sim scene as background
  const simCvs = $('sim-canvas');
  if (simCvs && simCvs.width > 0) {
    ctx.drawImage(simCvs, 0, 0, W, H);
  } else {
    ctx.fillStyle = '#0d1420';
    ctx.fillRect(0, 0, W, H);
  }

  // Center crosshair
  ctx.strokeStyle = 'rgba(0,229,255,0.6)';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(W/2,0); ctx.lineTo(W/2,H); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(0,H/2); ctx.lineTo(W,H/2); ctx.stroke();
  ctx.setLineDash([]);

  // Label center
  ctx.fillStyle = 'rgba(0,229,255,0.7)';
  ctx.font = '10px JetBrains Mono, monospace';
  ctx.textAlign = 'center';
  ctx.fillText('DRONE CENTER', W/2, H/2 - 8);
}

function _drawWizardMark(ctx, W, H, x, y) {
  // Redraw background (a quick grey fill for simplicity)
  _initWizardCam();
  // Mark
  ctx.save();
  ctx.strokeStyle = '#ff9100';
  ctx.lineWidth   = 2;
  ctx.shadowColor = '#ff9100';
  ctx.shadowBlur  = 12;
  ctx.beginPath();
  ctx.arc(x, y, 12, 0, Math.PI * 2);
  ctx.stroke();
  // Crosshair on mark
  ctx.beginPath(); ctx.moveTo(x-16,y); ctx.lineTo(x+16,y); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x,y-16); ctx.lineTo(x,y+16); ctx.stroke();
  // Connector to center
  ctx.strokeStyle = 'rgba(255,145,0,0.5)';
  ctx.lineWidth   = 1;
  ctx.setLineDash([4,4]);
  ctx.beginPath(); ctx.moveTo(W/2,H/2); ctx.lineTo(x,y); ctx.stroke();
  // Distance label
  const distPx = Math.abs(x - W/2);
  ctx.setLineDash([]);
  ctx.fillStyle = '#ff9100';
  ctx.font = '9px JetBrains Mono, monospace';
  ctx.textAlign = 'center';
  ctx.fillText(`${Math.round(distPx)}px`, (W/2 + x)/2, (H/2 + y)/2 - 6);
  ctx.restore();
}
