/* ═══════════════════════════════════════════════════════════════
   flightRecorder.js — High-frequency Telemetry CSV Logger
   Records flight data at 10 Hz and exports timestamped CSV.
═══════════════════════════════════════════════════════════════ */
'use strict';

const FlightRecorder = (() => {
  let _recording = false;
  let _records   = [];
  let _startTime = 0;
  let _timerId   = null;

  function toggle() {
    if (_recording) {
      stop();
    } else {
      start();
    }
  }

  function start() {
    if (_recording) return;
    _recording = true;
    _records   = [];
    _startTime = Date.now();

    const btn = $('btn-rec');
    if (btn) {
      btn.classList.add('recording');
      btn.innerHTML = '<span class="rec-dot"></span>REC <span id="rec-timer">00:00</span>';
    }

    _timerId = setInterval(_updateTimer, 1000);
    toast('⏺ Telemetry Recording STARTED', 'ok', 2500);
    MAVLink.log('SYS', 'Telemetry flight recording initiated');
  }

  function recordSample(telem, devState, activeWpIdx) {
    if (!_recording) return;

    const relTime = ((Date.now() - _startTime) / 1000).toFixed(2);
    _records.push({
      iso_time:      new Date().toISOString(),
      rel_time_s:    relTime,
      alt_m:         (telem?.alt ?? 0).toFixed(2),
      airspeed_ms:   (telem?.airspeed ?? 0).toFixed(2),
      heading_deg:   (telem?.heading ?? telem?.yaw ?? 0).toFixed(1),
      roll_deg:      (telem?.roll ?? 0).toFixed(1),
      pitch_deg:     (telem?.pitch ?? 0).toFixed(1),
      yaw_deg:       (telem?.yaw ?? 0).toFixed(1),
      battery_pct:   (telem?.battery ?? 0).toFixed(1),
      flight_mode:   telem?.mode ?? 'UNKNOWN',
      armed:         telem?.armed ? 1 : 0,
      xte_m:         (devState?.xte ?? 0).toFixed(3),
      ate_m:         (devState?.ate ?? 0).toFixed(3),
      side:          devState?.side ?? 0,
      active_wp:     activeWpIdx + 1
    });
  }

  function stop() {
    if (!_recording) return;
    _recording = false;

    if (_timerId) {
      clearInterval(_timerId);
      _timerId = null;
    }

    const btn = $('btn-rec');
    if (btn) {
      btn.classList.remove('recording');
      btn.innerHTML = '⏺ REC';
    }

    if (_records.length === 0) {
      toast('Recording stopped — no samples captured', 'warn');
      return;
    }

    const count = _records.length;
    exportCSV();
    toast(`✓ Recorded ${count} telemetry samples — CSV downloaded`, 'ok', 3500);
    MAVLink.log('SYS', `Telemetry log saved: ${count} samples`);
  }

  function exportCSV() {
    if (_records.length === 0) return;

    const headers = [
      'iso_time', 'rel_time_s', 'alt_m', 'airspeed_ms',
      'heading_deg', 'roll_deg', 'pitch_deg', 'yaw_deg',
      'battery_pct', 'flight_mode', 'armed', 'xte_m', 'ate_m', 'side', 'active_wp'
    ];

    let csvContent = headers.join(',') + '\n';
    _records.forEach(row => {
      csvContent += headers.map(h => row[h] ?? '').join(',') + '\n';
    });

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const d    = new Date();
    const ts   = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}_${String(d.getHours()).padStart(2,'0')}${String(d.getMinutes()).padStart(2,'0')}${String(d.getSeconds()).padStart(2,'0')}`;
    link.href     = url;
    link.download = `visionpath_telemetry_${ts}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  function _updateTimer() {
    const timerEl = $('rec-timer');
    if (!timerEl || !_recording) return;
    const elapsed = Math.floor((Date.now() - _startTime) / 1000);
    const m = String(Math.floor(elapsed / 60)).padStart(2, '0');
    const s = String(elapsed % 60).padStart(2, '0');
    timerEl.textContent = `${m}:${s}`;
  }

  function isRecording() { return _recording; }

  return { toggle, start, stop, recordSample, isRecording };
})();
