/* ═══════════════════════════════════════════════════════════════
   calibration.js — Camera calibration & pixel-to-world mapping
   
   Method:
     For a forward-facing (or slightly tilted) camera at altitude H,
     with horizontal FOV φ, and a reference object at real distance D:
     
     GSD (ground sample distance) = (2 * H * tan(φ/2)) / imageWidth
     
     When a reference object at known real-world distance D_real appears
     at pixel offset Δx from center, we can compute scale as:
       pxPerMeter = Δx / D_real
     
     We also use the perspective projection to convert pixel offset to
     real-world lateral distance at the camera's viewing distance.
═══════════════════════════════════════════════════════════════ */
'use strict';

const Calibration = (() => {

  // ── State ──────────────────────────────────────────────────────
  let _state = {
    calibrated: false,
    // Inputs
    fovH:      62.2,   // horizontal FOV in degrees
    altitude:  150,    // AGL in cm
    tilt:      0,      // camera tilt from horizontal (0 = forward-level)
    refDist:   200,    // reference object real distance (cm)
    // Computed
    pixelsPerMeter: null,
    gsdCmPerPx:     null,
    groundWidthM:   null,
    imageWidth:     960,
    imageHeight:    540,
    // Wizard
    wizMarkPx:      null,   // pixel x of marked reference object
    wizMarkPy:      null,
  };

  // ── Public API ────────────────────────────────────────────────
  function getState()  { return { ..._state }; }
  function isCalibrated() { return _state.calibrated; }

  /**
   * Update calibration parameters from UI inputs
   */
  function updateFromInputs() {
    _state.fovH     = parseFloat($('cal-fov').value)      || 62.2;
    _state.altitude = parseFloat($('cal-altitude').value)  || 150;
    _state.tilt     = parseFloat($('cal-tilt').value)     || 0;
    _state.refDist  = parseFloat($('cal-distance').value) || 200;
  }

  /**
   * Perform full calibration calculation.
   * Sets _state.pixelsPerMeter, gsdCmPerPx, groundWidthM.
   *
   * @param {number} [overrideWidth]  - optional image pixel width
   * @param {number} [overrideRefPx]  - optional reference pixel offset from centre (wizard)
   * @param {number} [overrideRefM]   - optional reference real distance (m) (wizard)
   */
  function calibrate(overrideWidth, overrideRefPx, overrideRefM) {
    const W = overrideWidth || _state.imageWidth;
    const H = overrideRefM !== undefined ? null : _state.altitude / 100; // metres
    const fovRad = deg2rad(_state.fovH);

    // GSD method: horizontal ground coverage at current altitude
    // groundWidth = 2 * H * tan(fovH/2)
    if (H !== null) {
      _state.groundWidthM = 2 * H * Math.tan(fovRad / 2);
      _state.gsdCmPerPx   = (_state.groundWidthM * 100) / W;
      _state.pixelsPerMeter = W / _state.groundWidthM;
    }

    // Wizard override: directly measured pixel offset → real distance
    if (overrideRefPx !== undefined && overrideRefM !== undefined && overrideRefPx > 0) {
      _state.pixelsPerMeter = overrideRefPx / overrideRefM;
      _state.gsdCmPerPx     = 100 / _state.pixelsPerMeter;
      _state.groundWidthM   = W / _state.pixelsPerMeter;
    }

    _state.calibrated = true;
    _updateUI();
    toast('✓ Calibration applied', 'ok');
    return _state;
  }

  /** Convert pixel offset (from image centre) to real-world lateral distance (m) */
  function pxToMeters(px) {
    if (!_state.calibrated || !_state.pixelsPerMeter) return 0;
    return px / _state.pixelsPerMeter;
  }

  /** Convert real-world lateral distance (m) to pixel offset from center */
  function metersToPx(m) {
    if (!_state.calibrated || !_state.pixelsPerMeter) return 0;
    return m * _state.pixelsPerMeter;
  }

  function setImageSize(w, h) {
    _state.imageWidth  = w;
    _state.imageHeight = h;
  }

  function setWizardMark(px, py) {
    _state.wizMarkPx = px;
    _state.wizMarkPy = py;
  }

  // ── UI updates ─────────────────────────────────────────────────
  function _updateUI() {
    const s = _state;
    $('cr-pxm').textContent = s.pixelsPerMeter ? fmt(s.pixelsPerMeter, 2) + ' px/m' : '—';
    $('cr-gsd').textContent = s.gsdCmPerPx     ? fmt(s.gsdCmPerPx, 3) + ' cm/px' : '—';
    $('cr-gw').textContent  = s.groundWidthM   ? fmt(s.groundWidthM, 2) + ' m' : '—';

    const calEl   = $('cib-cal');
    const fovEl   = $('cib-fov');
    const scaleEl = $('cib-scale');

    if (calEl)   { calEl.textContent = s.calibrated ? 'CALIBRATED' : 'UNCALIBRATED'; calEl.className = 'cib-val ' + (s.calibrated ? 'cal' : 'uncal'); }
    if (fovEl)   fovEl.textContent = fmt(s.fovH, 1) + '°';
    if (scaleEl) scaleEl.textContent = s.pixelsPerMeter ? fmt(s.pixelsPerMeter, 1) + ' px/m' : '—';
  }

  return { getState, isCalibrated, updateFromInputs, calibrate, pxToMeters, metersToPx, setImageSize, setWizardMark };
})();

// ══ Wizard helpers (called from inline HTML onclick for simplicity) ══
let _wizardStep = 1;

function wizardNext() {
  if (_wizardStep === 2) {
    const cal = Calibration.getState();
    if (!cal.wizMarkPx) return; // not marked yet
  }
  if (_wizardStep === 3) {
    // Calculate
    const refDistM  = (parseFloat($('wiz-dist').value) || 200) / 100;
    const altM      = (parseFloat($('wiz-alt').value)  || 150) / 100;
    const cal       = Calibration.getState();
    const markPx    = cal.wizMarkPx;
    // pixel distance from image centre
    const wizCvs    = $('wiz-cam');
    const halfW     = wizCvs.width / 2;
    const offsetPx  = Math.abs(markPx - halfW);

    // Apply to calibration
    Calibration.updateFromInputs();
    const s = Calibration.calibrate(wizCvs.width, offsetPx, refDistM);

    // Show results
    const resEl = $('wiz-result');
    resEl.innerHTML = `
      <div class="wiz-result-row"><span>Pixels per meter</span><span>${fmt(s.pixelsPerMeter, 2)} px/m</span></div>
      <div class="wiz-result-row"><span>Ground Sample Distance</span><span>${fmt(s.gsdCmPerPx, 3)} cm/px</span></div>
      <div class="wiz-result-row"><span>Ground Width at Altitude</span><span>${fmt(s.groundWidthM, 2)} m</span></div>
      <div class="wiz-result-row"><span>Reference Distance</span><span>${fmt(refDistM * 100, 0)} cm</span></div>
      <div class="wiz-result-row"><span>Pixel Offset</span><span>${fmt(offsetPx, 1)} px</span></div>
    `;
  }

  // Advance step
  $(`wiz-step-${_wizardStep}`).classList.remove('active');
  document.querySelectorAll('.wstep')[_wizardStep - 1].classList.add('done');
  _wizardStep++;
  $(`wiz-step-${_wizardStep}`).classList.add('active');
  document.querySelectorAll('.wstep')[_wizardStep - 1].classList.add('active');
}

function wizardApply() {
  $('modal-cal-wizard').classList.add('hidden');
  _wizardStep = 1;
  // reset wizard steps UI
  document.querySelectorAll('.wstep').forEach((el, i) => {
    el.classList.remove('active', 'done');
    if (i === 0) el.classList.add('active');
  });
  document.querySelectorAll('.wiz-panel').forEach((el, i) => {
    el.classList.toggle('active', i === 0);
  });
  toast('✓ Calibration wizard complete', 'ok');
}
