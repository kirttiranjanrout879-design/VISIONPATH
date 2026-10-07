/* ═══════════════════════════════════════════════════════════════
   camera.js — Real Raspberry Pi CSI Camera Stream Manager
   Streams MJPEG from Raspberry Pi (http://10.89.89.85:8080/stream.mjpg)
   and monitors camera status via GET /health with CORS support.
   
   Architecture:
   • Source 'pi'    → MJPEG <img> stream directly mounted to HTML
   • Source 'webcam'→ getUserMedia laptop webcam
   • Source 'sim'   → Simulation canvas
   
   Health check:
   • GET http://10.89.89.85:8080/health (expects HTTP 200 and {"status":"ok"})
   • Stream displayed directly in <img> element with src = http://10.89.89.85:8080/stream.mjpg
═══════════════════════════════════════════════════════════════ */
'use strict';

const Camera = (() => {

  let _source          = 'pi';   // 'pi' | 'webcam' | 'sim'
  let _stream          = null;   // MediaStream (webcam only)
  let _videoEl         = null;   // <video> element
  let _piImgEl         = null;   // <img> element for MJPEG
  let _overlayCardEl   = null;

  // Stream health metrics
  let _camOnline       = false;
  let _camError        = null;
  let _streamUrl       = '';
  let _healthUrl       = '';

  // Retry / watchdog state
  let _retryTimer      = null;
  let _retryAttempts   = 0;
  let _healthPollTimer = null;

  // ── Helper to construct exact camera URLs ─────────────────────
  function _getUrls() {
    const host = (typeof CONFIG !== 'undefined' && CONFIG.CAMERA_HOST) 
      ? CONFIG.CAMERA_HOST 
      : (typeof Settings !== 'undefined' ? Settings.getCameraHost() : '10.89.89.85');
      
    const port = (typeof CONFIG !== 'undefined' && CONFIG.CAMERA_PORT) 
      ? CONFIG.CAMERA_PORT 
      : (typeof Settings !== 'undefined' ? Settings.getCameraPort() : 8080);
      
    let path = (typeof CONFIG !== 'undefined' && CONFIG.CAMERA_STREAM_PATH) 
      ? CONFIG.CAMERA_STREAM_PATH 
      : (typeof Settings !== 'undefined' ? Settings.getCameraStreamPath() : '/stream.mjpg');
      
    if (!path.startsWith('/')) path = '/' + path;

    const cameraHealthUrl = `http://${host}:${port}/health`;
    const cameraStreamUrl = `http://${host}:${port}${path}`;

    return { host, port, path, cameraHealthUrl, cameraStreamUrl };
  }

  // ── Initialization ────────────────────────────────────────────
  function init() {
    _videoEl = $('cam-video');
    _piImgEl = $('pi-cam-stream');
    _ensureOverlayCard();

    // Periodic health check polling every 4 seconds
    if (_healthPollTimer) clearInterval(_healthPollTimer);
    _healthPollTimer = setInterval(_checkHealthPoll, 4000);
  }

  // ── Source Selection ──────────────────────────────────────────
  function setSource(src) {
    _source = src;
    _stopCurrent();

    // Update UI button label
    const btn = $('btn-cam-source');
    if (btn) {
      if (src === 'pi')          btn.textContent = '📷 SOURCE: PI CSI CAM';
      else if (src === 'webcam') btn.textContent = '📷 SOURCE: LAPTOP WEBCAM';
      else                       btn.textContent = '📷 SOURCE: SIMULATION';
    }

    if (src === 'webcam') {
      _startWebcam();
    } else if (src === 'pi') {
      _retryAttempts = 0;
      _startPiStream();
    } else {
      // Simulation mode
      _showSim(true);
      _setCameraBadge('ONLINE (SIM)', 'online');
      _hideOverlayCard();
    }
  }

  // ── Stop current source cleanly ───────────────────────────────
  function _stopCurrent() {
    if (_retryTimer) { 
      clearTimeout(_retryTimer); 
      _retryTimer = null; 
    }

    // Stop webcam tracks
    if (_stream) {
      _stream.getTracks().forEach(t => t.stop());
      _stream = null;
    }

    // Stop webcam video element
    if (_videoEl) {
      _videoEl.srcObject = null;
      _videoEl.src = '';
      _videoEl.style.display = 'none';
    }

    // Hide Pi image element
    if (_piImgEl) {
      _piImgEl.onload  = null;
      _piImgEl.onerror = null;
      _piImgEl.style.display = 'none';
    }

    _showSim(false);
    _camOnline = false;
    _hideOverlayCard();
  }

  // ── Raspberry Pi CSI Camera Stream & Health Check ────────────
  async function _startPiStream() {
    if (_source !== 'pi') return;

    _showSim(false);

    if (!_piImgEl) _piImgEl = $('pi-cam-stream');
    if (!_piImgEl) {
      MAVLink.log('ERR', 'pi-cam-stream element missing from DOM!');
      return;
    }

    const { host, port, cameraHealthUrl, cameraStreamUrl } = _getUrls();
    _healthUrl = cameraHealthUrl;
    _streamUrl = cameraStreamUrl;

    _setCameraBadge('CONNECTING…', 'pending');
    _showOverlayCard(
      'CONNECTING TO PI CAMERA…',
      `Checking: <code>${cameraHealthUrl}</code><br>Stream: <code>${cameraStreamUrl}</code>`
    );

    // ── Step 1: Health check via GET /health ──
    let healthSuccess = false;
    try {
      const res = await fetch(cameraHealthUrl, { signal: AbortSignal.timeout(3500) });
      if (res.ok) {
        const data = await res.json();
        if (data && (data.status === 'ok' || data.camera === 'online')) {
          healthSuccess = true;
          _camOnline = true;
          _camError  = null;
          _retryAttempts = 0;
          _setCameraBadge('ONLINE', 'online');
          _hideOverlayCard();
          MAVLink.log('SYS', `Pi Camera Health OK: status=${data.status}, camera=${data.camera}`);
        }
      }
    } catch (healthErr) {
      MAVLink.log('WARN', `Pi Camera health check error: ${healthErr.message}`);
    }

    // ── Step 2: Display MJPEG stream using HTML <img> element ──
    // Do NOT fetch /stream.mjpg. The browser <img> handles multipart streaming directly.
    _piImgEl.style.display = 'block';

    _piImgEl.onload = () => {
      _camOnline = true;
      _camError  = null;
      _setCameraBadge('ONLINE', 'online');
      _hideOverlayCard();
    };

    _piImgEl.onerror = () => {
      if (_source !== 'pi') return;
      _onPiError();
    };

    // Mount stream URL to <img> element
    if (_piImgEl.src !== cameraStreamUrl) {
      _piImgEl.src = cameraStreamUrl;
    }

    // If health check succeeded, ensure ONLINE state immediately
    if (healthSuccess) {
      _camOnline = true;
      _setCameraBadge('ONLINE', 'online');
      _hideOverlayCard();
    }
  }

  // ── Handle Stream / Image Loading Error ───────────────────────
  function _onPiError() {
    if (_source !== 'pi') return;

    _camOnline = false;
    const { host, port, cameraStreamUrl } = _getUrls();

    _retryAttempts++;
    const delay = Math.min(10000, 2000 * Math.pow(1.4, _retryAttempts - 1));

    _camError = `Pi Camera unreachable at ${cameraStreamUrl}`;
    _setCameraBadge('OFFLINE', 'offline');

    _showOverlayCard(
      'PI CAMERA OFFLINE',
      `Cannot reach <code>${cameraStreamUrl}</code>.<br><br>` +
      `<strong>Check:</strong><br>` +
      `1. Raspberry Pi online at <code>${host}</code>?<br>` +
      `2. Camera server running on port <code>${port}</code>?<br>` +
      `3. Open stream directly in Chrome: <a href="${cameraStreamUrl}" target="_blank" style="color:var(--c-accent)">${cameraStreamUrl}</a><br><br>` +
      `<em>Auto-retrying in ${(delay/1000).toFixed(1)}s… (attempt ${_retryAttempts})</em>`
    );

    MAVLink.log('ERR', `Camera offline -- retrying in ${(delay/1000).toFixed(0)}s`);

    _scheduleRetry(delay);
  }

  function _scheduleRetry(delayMs) {
    if (_retryTimer) clearTimeout(_retryTimer);
    _retryTimer = setTimeout(() => {
      _retryTimer = null;
      if (_source === 'pi') {
        _startPiStream();
      }
    }, delayMs);
  }

  // ── Periodic Health Polling ──────────────────────────────────
  async function _checkHealthPoll() {
    if (_source !== 'pi') return;

    const { cameraHealthUrl, cameraStreamUrl } = _getUrls();
    try {
      const res = await fetch(cameraHealthUrl, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        const data = await res.json();
        if (data && (data.status === 'ok' || data.camera === 'online')) {
          if (!_camOnline) {
            _camOnline = true;
            _camError  = null;
            _setCameraBadge('ONLINE', 'online');
            _hideOverlayCard();
            // Ensure <img> is pointing to the stream
            if (_piImgEl && _piImgEl.src !== cameraStreamUrl) {
              _piImgEl.src = cameraStreamUrl;
              _piImgEl.style.display = 'block';
            }
          }
        }
      }
    } catch (e) {
      // If health check poll fails
    }
  }

  // ── Laptop Webcam ─────────────────────────────────────────────
  function _startWebcam() {
    _showSim(false);
    if (!_videoEl) _videoEl = $('cam-video');

    _setCameraBadge('CONNECTING…', 'pending');
    _showOverlayCard('ACCESSING WEBCAM…', 'Requesting browser camera permission…');
    toast('Accessing laptop webcam…', 'info', 2000);

    navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1920 }, height: { ideal: 1080 }, facingMode: 'environment' },
      audio: false
    })
    .then(stream => {
      _stream = stream;
      _videoEl.srcObject = stream;
      _videoEl.style.display = 'block';
      _camOnline = true;
      _camError  = null;
      _setCameraBadge('ONLINE', 'online');
      _hideOverlayCard();
      toast('📷 Laptop webcam active', 'ok', 2500);
    })
    .catch(err => {
      _camOnline = false;
      _camError  = err.message;
      _setCameraBadge('ERROR', 'offline');
      _showOverlayCard('WEBCAM ERROR', `Permission denied or no camera: ${err.message}`);
    });
  }

  // ── Simulation canvas visibility ──────────────────────────────
  function _showSim(show) {
    const sim = $('sim-canvas');
    if (sim) sim.style.display = show ? 'block' : 'none';
  }

  // ── Camera badge + diagnostics update ────────────────────────
  function _setCameraBadge(text, className) {
    const badge = $('cs-cam');
    if (badge) {
      badge.textContent = text;
      badge.className   = `cs-badge ${className}`;
    }
    const diagCam = $('diag-cam');
    if (diagCam) diagCam.textContent = text;
  }

  // ── Overlay card (shown when camera is offline/connecting) ────
  function _ensureOverlayCard() {
    let card = $('cam-status-card');
    if (!card) {
      card = document.createElement('div');
      card.id = 'cam-status-card';
      card.style.cssText = `
        position: absolute;
        top: 50%; left: 50%;
        transform: translate(-50%, -50%);
        background: rgba(8, 12, 18, 0.96);
        border: 1px solid var(--c-border);
        border-radius: 8px;
        padding: 24px 32px;
        text-align: center;
        max-width: 520px;
        z-index: 5;
        box-shadow: 0 8px 32px rgba(0,0,0,0.9);
        backdrop-filter: blur(12px);
        display: none;
      `;
      const viewport = $('cam-viewport');
      if (viewport) viewport.appendChild(card);
    }
    _overlayCardEl = card;
  }

  function _showOverlayCard(title, detailsHtml) {
    if (!_overlayCardEl) _ensureOverlayCard();
    if (_overlayCardEl) {
      _overlayCardEl.innerHTML = `
        <div style="font-family:var(--font-hud);font-size:14px;color:var(--c-accent);font-weight:700;letter-spacing:1.5px;margin-bottom:12px;">
          ${title}
        </div>
        <div style="font-size:11.5px;color:var(--c-text-dim);line-height:1.8;font-family:var(--font-ui);text-align:left;">
          ${detailsHtml}
        </div>
      `;
      _overlayCardEl.style.display = 'block';
    }
  }

  function _hideOverlayCard() {
    if (_overlayCardEl) _overlayCardEl.style.display = 'none';
  }

  // ── Shutter Flash Animation ────────────────────────────────────
  function triggerShutterFlash() {
    const flashEl = $('shutter-flash');
    if (!flashEl) return;
    flashEl.classList.add('flash');
    setTimeout(() => {
      flashEl.classList.remove('flash');
    }, 120);
  }

  // ── Photo Capture on Raspberry Pi ──────────────────────────────
  async function capturePhoto() {
    triggerShutterFlash();

    const { host, port } = _getUrls();

    // 1. If online in Pi mode
    if (_source === 'pi' || _camOnline) {
      try {
        MAVLink.log('SYS', `Requesting photo capture on Pi (${host}:${port})…`);
        const res = await fetch(`http://${host}:${port}/api/capture/photo`, {
          method: 'POST',
          signal: AbortSignal.timeout(6000)
        });
        if (res.ok) {
          const data = await res.json();
          if (data.success) {
            toast(`📸 Photo saved on Pi: ${data.filename}`, 'ok', 4000);
            MAVLink.log('SYS', `✓ Photo saved to Pi disk: ${data.path} (${Math.round(data.sizeBytes/1024)} KB)`);
            return data;
          }
        }
      } catch (e) {
        MAVLink.log('WARN', `Pi photo capture HTTP failed (${e.message}), trying fallback snapshot…`);
      }
    }

    // 2. Fallback: Local snapshot from canvas or video feed
    try {
      const cvs = document.createElement('canvas');
      const viewport = $('cam-viewport');
      cvs.width = viewport ? viewport.clientWidth : 960;
      cvs.height = viewport ? viewport.clientHeight : 540;
      const ctx = cvs.getContext('2d');

      if (_source === 'webcam' && _videoEl && _videoEl.videoWidth) {
        ctx.drawImage(_videoEl, 0, 0, cvs.width, cvs.height);
      } else {
        const sim = $('sim-canvas');
        if (sim) ctx.drawImage(sim, 0, 0, cvs.width, cvs.height);
      }

      // Draw overlay
      const overlay = $('overlay-canvas');
      if (overlay) ctx.drawImage(overlay, 0, 0, cvs.width, cvs.height);

      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `snapshot_${ts}.jpg`;
      const dataUrl = cvs.toDataURL('image/jpeg', 0.9);
      const a = document.createElement('a');
      a.href = dataUrl;
      a.download = filename;
      a.click();
      toast(`📸 Snapshot saved: ${filename}`, 'ok', 3500);
      return { success: true, filename, local: true };
    } catch (err) {
      toast(`Capture error: ${err.message}`, 'danger');
      return { success: false, error: err.message };
    }
  }

  // ── Video Recording on Raspberry Pi ────────────────────────────
  let _isRecording = false;
  let _recStartTime = 0;
  let _recTimerInterval = null;

  async function toggleVideoRecording() {
    const { host, port } = _getUrls();
    const btn = $('btn-rec-video');
    const badge = $('rec-live-badge');
    const timerEl = $('rec-timer');

    if (!_isRecording) {
      // START RECORDING
      try {
        MAVLink.log('SYS', `Starting video recording on Pi (${host}:${port})…`);
        const res = await fetch(`http://${host}:${port}/api/capture/video/start`, {
          method: 'POST',
          signal: AbortSignal.timeout(5000)
        });
        const data = await res.json();
        if (data.success) {
          _isRecording = true;
          _recStartTime = Date.now();
          if (btn) {
            btn.classList.add('recording');
            btn.textContent = '⏹ STOP REC';
          }
          if (badge) badge.classList.add('active');

          if (_recTimerInterval) clearInterval(_recTimerInterval);
          _recTimerInterval = setInterval(() => {
            const elapsed = Math.floor((Date.now() - _recStartTime) / 1000);
            const m = String(Math.floor(elapsed / 60)).padStart(2, '0');
            const s = String(elapsed % 60).padStart(2, '0');
            if (timerEl) timerEl.textContent = `${m}:${s}`;
          }, 1000);

          toast(`🔴 Recording video to Pi: ${data.filename}`, 'warn', 4000);
          MAVLink.log('SYS', `✓ Video recording active on Pi: ${data.path}`);
          return data;
        } else {
          toast(`Recording failed: ${data.error}`, 'danger');
        }
      } catch (e) {
        toast(`Recording request failed: ${e.message}`, 'danger');
      }
    } else {
      // STOP RECORDING
      try {
        MAVLink.log('SYS', `Stopping video recording on Pi…`);
        const res = await fetch(`http://${host}:${port}/api/capture/video/stop`, {
          method: 'POST',
          signal: AbortSignal.timeout(5000)
        });
        const data = await res.json();

        _isRecording = false;
        if (_recTimerInterval) {
          clearInterval(_recTimerInterval);
          _recTimerInterval = null;
        }
        if (btn) {
          btn.classList.remove('recording');
          btn.textContent = '⏺ REC';
        }
        if (badge) badge.classList.remove('active');

        toast(`⏹ Video saved on Pi: ${data.filename} (${data.durationSeconds || 0}s, ${Math.round((data.sizeBytes||0)/1024)} KB)`, 'ok', 5000);
        MAVLink.log('SYS', `✓ Video saved to Pi: ${data.path}`);
        return data;
      } catch (e) {
        _isRecording = false;
        if (_recTimerInterval) clearInterval(_recTimerInterval);
        if (btn) { btn.classList.remove('recording'); btn.textContent = '⏺ REC'; }
        if (badge) badge.classList.remove('active');
        toast(`Stop recording error: ${e.message}`, 'danger');
      }
    }
  }

  // ── Fetch Saved Media Gallery from Raspberry Pi ────────────────
  async function fetchCaptures() {
    const { host, port } = _getUrls();
    try {
      const res = await fetch(`http://${host}:${port}/api/captures`, {
        signal: AbortSignal.timeout(5000)
      });
      if (res.ok) {
        const data = await res.json();
        return data.captures || [];
      }
    } catch (e) {
      MAVLink.log('WARN', `Could not fetch gallery: ${e.message}`);
    }
    return [];
  }

  // ── Delete Capture from Raspberry Pi ───────────────────────────
  async function deleteCapture(filename) {
    const { host, port } = _getUrls();
    try {
      const res = await fetch(`http://${host}:${port}/api/captures/${encodeURIComponent(filename)}`, {
        method: 'DELETE',
        signal: AbortSignal.timeout(5000)
      });
      if (res.ok) {
        toast(`Deleted ${filename}`, 'warn', 2500);
        return true;
      }
    } catch (e) {
      toast(`Delete failed: ${e.message}`, 'danger');
    }
    return false;
  }

  // ── Public API ────────────────────────────────────────────────
  function getSource() { return _source; }
  function isOnline()  { return _camOnline; }
  function getStats() {
    return {
      source:         _source,
      online:         _camOnline,
      retryAttempts:  _retryAttempts,
      error:          _camError,
      url:            _streamUrl,
      healthUrl:      _healthUrl,
      recording:      _isRecording
    };
  }

  return {
    init,
    setSource,
    getSource,
    isOnline,
    getStats,
    capturePhoto,
    toggleVideoRecording,
    fetchCaptures,
    deleteCapture,
    triggerShutterFlash
  };
})();
