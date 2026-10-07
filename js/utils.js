/* ═══════════════════════════════════════════════════════════════
   utils.js — Shared helpers
═══════════════════════════════════════════════════════════════ */
'use strict';

/** Clamp a value between min and max */
function clamp(val, min, max) { return Math.min(Math.max(val, min), max); }

/** Linear interpolation */
function lerp(a, b, t) { return a + (b - a) * t; }

/** Convert degrees to radians */
function deg2rad(d) { return d * Math.PI / 180; }

/** Convert radians to degrees */
function rad2deg(r) { return r * 180 / Math.PI; }

/** Format seconds as HH:MM:SS */
function formatTime(s) {
  const h = Math.floor(s / 3600).toString().padStart(2, '0');
  const m = Math.floor((s % 3600) / 60).toString().padStart(2, '0');
  const sec = Math.floor(s % 60).toString().padStart(2, '0');
  return `${h}:${m}:${sec}`;
}

/** Format a number to fixed decimal places or dash if null/NaN */
function fmt(n, dec = 2) {
  if (n === null || n === undefined || isNaN(n) || n === '') return '—';
  return parseFloat(n).toFixed(dec);
}

/** Show a toast notification */
function toast(msg, type = 'info', duration = 3000) {
  const c = document.getElementById('toast-container');
  if (!c) return;
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  c.appendChild(el);
  setTimeout(() => {
    el.classList.add('fade');
    setTimeout(() => el.remove(), 300);
  }, duration);
}

/** Distance between two 2D points */
function dist2d(ax, ay, bx, by) {
  return Math.sqrt((bx - ax) ** 2 + (by - ay) ** 2);
}

/**
 * Cross-track error (signed): positive = right of path, negative = left of path
 * @param {number} px - point x
 * @param {number} py - point y
 * @param {number} ax - path start x
 * @param {number} ay - path start y
 * @param {number} bx - path end x
 * @param {number} by - path end y
 * @returns {number} signed cross-track distance (pixels)
 */
function crossTrack(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1e-9) return 0;
  return ((dy * px - dx * py + bx * ay - by * ax) / len);
}

/**
 * Along-track distance (projection onto segment)
 */
function alongTrack(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-9) return 0;
  return ((px - ax) * dx + (py - ay) * dy) / Math.sqrt(len2);
}

/** Get element by id shorthand */
const $ = id => document.getElementById(id);

/** Get current timestamp string */
function nowTs() {
  const d = new Date();
  return `${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}:${d.getSeconds().toString().padStart(2,'0')}.${d.getMilliseconds().toString().padStart(3,'0')}`;
}
