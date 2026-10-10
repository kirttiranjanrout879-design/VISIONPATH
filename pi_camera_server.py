#!/usr/bin/env python3
"""
╔══════════════════════════════════════════════════════════════════════════════╗
║  VISIONPATH — Standalone Pi Camera MJPEG Server & Media Recorder            ║
║  Run this on Raspberry Pi 4B (or PC) to stream OV5647 / webcam and capture   ║
║  photos and video directly to storage on the Raspberry Pi.                   ║
║                                                                              ║
║  Usage:                                                                      ║
║    python3 pi_camera_server.py                                              ║
║    python3 pi_camera_server.py --port 8080 --width 1920 --height 1080       ║
║                                                                              ║
║  Endpoints:                                                                  ║
║    Stream URL:    http://0.0.0.0:8080/stream                                 ║
║    Health URL:    http://0.0.0.0:8080/health                                 ║
║    Capture Photo: http://0.0.0.0:8080/api/capture/photo                      ║
║    Record Video:  http://0.0.0.0:8080/api/capture/video/start /stop         ║
║    Media Gallery: http://0.0.0.0:8080/api/captures                           ║
╚══════════════════════════════════════════════════════════════════════════════╝
"""

import argparse
import io
import json
import logging
import math
import os
import shutil
import socket
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from socketserver import ThreadingMixIn
from urllib.parse import urlparse

# ── Logging ─────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format='[%(asctime)s] %(levelname)s  %(message)s',
    datefmt='%H:%M:%S'
)
log = logging.getLogger('PiCam')


# ════════════════════════════════════════════════════════════════════════════
# CAMERA MANAGER & MEDIA RECORDER
# ════════════════════════════════════════════════════════════════════════════
class CameraManager:
    """
    Drives rpicam-vid / libcamera-vid / OpenCV to produce MJPEG frames.
    Handles photo snapshots, live video recording, and disk saving on Pi.
    Thread-safe. Auto-restarts on crash.
    """

    def __init__(self, width=1920, height=1080, fps=30, captures_dir=None):
        self.width  = width
        self.height = height
        self.fps    = fps

        # Directory on Pi for saving photos & videos
        if captures_dir:
            self.captures_dir = os.path.abspath(captures_dir)
        else:
            home_dir = os.path.expanduser('~')
            self.captures_dir = os.path.join(home_dir, 'captures')
        os.makedirs(self.captures_dir, exist_ok=True)
        log.info(f"Media captures directory: {self.captures_dir}")

        self._lock          = threading.Lock()
        self._frame         = self._create_initial_synthetic_frame()
        self._frame_count   = 1
        self._last_frame_ts = time.time()
        self._measured_fps  = 30.0
        self._status        = 'online'
        self._error         = None
        self._sensor        = 'unknown'
        self._process       = None
        self._running       = False

        # Video recording state
        self._recording          = False
        self._rec_lock           = threading.Lock()
        self._rec_writer         = None
        self._rec_filename       = None
        self._rec_start_ts       = 0.0
        self._rec_frames_written = 0
        self._rec_file_path      = None

    def _create_initial_synthetic_frame(self):
        """Creates a starter JPEG image so get_frame() is immediately non-empty."""
        try:
            import cv2
            import numpy as np
            img = np.zeros((self.height, self.width, 3), dtype=np.uint8)
            img[0:int(self.height * 0.45), :] = (18, 12, 8)
            img[int(self.height * 0.45):, :]  = (30, 20, 15)
            cv2.putText(img, "VISIONPATH PI-CAM (INITIALIZING)", (24, 44),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.9, (0, 229, 255), 2)
            ret, jpeg = cv2.imencode('.jpg', img, [cv2.IMWRITE_JPEG_QUALITY, 75])
            if ret:
                return jpeg.tobytes()
        except Exception:
            pass
        return b'\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00\xff\xdb\x00C\x00\x08\x06\x06\x07\x06\x05\x08\x07\x07\x07\t\t\x08\n\x0c\x14\r\x0c\x0b\x0b\x0c\x19\x12\x13\x0f\x14\x1d\x1a\x1f\x1e\x1d\x1a\x1c\x1c $.\' \",#\x1c\x1c(7),01444\x1f\'9=82<.342\xff\xc0\x00\x0b\x08\x00\x01\x00\x01\x01\x01\x11\x00\xff\xc4\x00\x1f\x00\x00\x01\x05\x01\x01\x01\x01\x01\x01\x00\x00\x00\x00\x00\x00\x00\x00\x01\x02\x03\x04\x05\x06\x07\x08\t\n\x0b\xff\xda\x00\x08\x01\x01\x00\x00?\x00\xbf\x00\xff\xd9'

    # ── Public API ────────────────────────────────────────────────────────
    def start(self):
        self._running = True
        t = threading.Thread(target=self._worker, daemon=True, name='CamWorker')
        t.start()
        log.info('Camera worker thread started')

    def stop(self):
        self._running = False
        self.stop_recording()
        self._kill_process()

    def get_frame(self):
        with self._lock:
            return self._frame

    def get_health(self):
        now = time.time()
        age = round(now - self._last_frame_ts, 2) if self._last_frame_ts > 0 else None
        streaming = (
            self._status == 'online'
            and self._last_frame_ts > 0
            and (now - self._last_frame_ts) < 3.0
        )
        rec_status = self.get_recording_status()
        return {
            'detected':       self._status in ('online', 'starting'),
            'streaming':      streaming,
            'framesReceived': self._frame_count > 0,
            'fps':            self._measured_fps,
            'width':          self.width,
            'height':         self.height,
            'sensor':         self._sensor,
            'lastFrame':      self._last_frame_ts if self._last_frame_ts > 0 else None,
            'lastFrameAge':   age,
            'status':         'online' if streaming else self._status,
            'error':          self._error,
            'frameCount':     self._frame_count,
            'capturesDir':    self.captures_dir,
            'recording':      rec_status['recording'],
            'recDuration':    rec_status['elapsedSeconds']
        }

    # ── Photo & Video Capture on Raspberry Pi ─────────────────────────────
    def capture_photo(self):
        """Captures the current camera frame and saves directly to disk on Raspberry Pi."""
        frame = self.get_frame()
        if not frame:
            return {'success': False, 'error': 'No camera frame available to capture'}

        timestamp_str = time.strftime('%Y%m%d_%H%M%S')
        filename = f"photo_{timestamp_str}.jpg"
        filepath = os.path.join(self.captures_dir, filename)

        try:
            with open(filepath, 'wb') as f:
                f.write(frame)
            size_bytes = os.path.getsize(filepath)
            log.info(f"📸 Photo captured & saved to Pi: {filepath} ({size_bytes} bytes)")
            return {
                'success': True,
                'type': 'photo',
                'filename': filename,
                'path': filepath,
                'sizeBytes': size_bytes,
                'timestamp': time.strftime('%Y-%m-%d %H:%M:%S'),
                'url': f"/captures/{filename}"
            }
        except Exception as e:
            log.error(f"Failed to save photo: {e}")
            return {'success': False, 'error': str(e)}

    def start_recording(self):
        """Starts recording incoming frames to an AVI/MJPEG video on Raspberry Pi."""
        with self._rec_lock:
            if self._recording:
                return {
                    'success': True,
                    'alreadyRecording': True,
                    'filename': self._rec_filename,
                    'elapsed': round(time.time() - self._rec_start_ts, 1)
                }

            frame = self.get_frame()
            if not frame:
                return {'success': False, 'error': 'No camera feed available to record'}

            timestamp_str = time.strftime('%Y%m%d_%H%M%S')
            self._rec_filename = f"video_{timestamp_str}.avi"
            self._rec_file_path = os.path.join(self.captures_dir, self._rec_filename)
            self._rec_start_ts = time.time()
            self._rec_frames_written = 0

            # Try initializing cv2.VideoWriter
            try:
                import cv2
                import numpy as np
                fourcc = cv2.VideoWriter_fourcc(*'MJPG')
                nparr = np.frombuffer(frame, np.uint8)
                img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
                h, w = img.shape[:2]
                self._rec_writer = cv2.VideoWriter(self._rec_file_path, fourcc, 20.0, (w, h))
            except Exception as e:
                log.warning(f"cv2.VideoWriter init failed ({e}), using raw MJPEG stream file fallback")
                self._rec_writer = None

            self._recording = True
            log.info(f"🔴 Started video recording to Pi: {self._rec_file_path}")
            return {
                'success': True,
                'recording': True,
                'filename': self._rec_filename,
                'path': self._rec_file_path,
                'startTime': self._rec_start_ts,
                'url': f"/captures/{self._rec_filename}"
            }

    def _feed_recording_frame(self, frame_bytes):
        """Writes frame to open recording session."""
        if not self._recording:
            return
        with self._rec_lock:
            if not self._recording:
                return
            try:
                if self._rec_writer is not None:
                    import cv2
                    import numpy as np
                    nparr = np.frombuffer(frame_bytes, np.uint8)
                    img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
                    if img is not None:
                        self._rec_writer.write(img)
                        self._rec_frames_written += 1
                else:
                    with open(self._rec_file_path, 'ab') as f:
                        f.write(frame_bytes)
                    self._rec_frames_written += 1
            except Exception as e:
                log.error(f"Error writing video frame: {e}")

    def stop_recording(self):
        """Stops the active video recording session and finalizes file on Pi."""
        with self._rec_lock:
            if not self._recording:
                return {'success': True, 'recording': False, 'message': 'Not recording'}

            self._recording = False
            duration = round(time.time() - self._rec_start_ts, 1) if self._rec_start_ts > 0 else 0.0
            frames = self._rec_frames_written
            filename = self._rec_filename
            filepath = self._rec_file_path

            if self._rec_writer is not None:
                try:
                    self._rec_writer.release()
                except Exception:
                    pass
                self._rec_writer = None

            size_bytes = os.path.getsize(filepath) if (filepath and os.path.exists(filepath)) else 0
            log.info(f"⏹ Stopped recording: {filename} ({duration}s, {frames} frames, {size_bytes} bytes)")

            return {
                'success': True,
                'recording': False,
                'filename': filename,
                'path': filepath,
                'durationSeconds': duration,
                'framesWritten': frames,
                'sizeBytes': size_bytes,
                'url': f"/captures/{filename}"
            }

    def get_recording_status(self):
        with self._rec_lock:
            now = time.time()
            elapsed = round(now - self._rec_start_ts, 1) if self._recording else 0.0
            return {
                'recording': self._recording,
                'filename': self._rec_filename if self._recording else None,
                'elapsedSeconds': elapsed,
                'framesWritten': self._rec_frames_written if self._recording else 0
            }

    def list_captures(self):
        """Returns list of all photos and videos saved in the captures directory."""
        items = []
        if not os.path.exists(self.captures_dir):
            return items

        try:
            for fname in os.listdir(self.captures_dir):
                fpath = os.path.join(self.captures_dir, fname)
                if not os.path.isfile(fpath):
                    continue
                lower = fname.lower()
                if lower.endswith(('.jpg', '.jpeg', '.png')):
                    ctype = 'photo'
                elif lower.endswith(('.avi', '.mp4', '.mjpg', '.h264')):
                    ctype = 'video'
                else:
                    continue

                stat = os.stat(fpath)
                items.append({
                    'filename': fname,
                    'type': ctype,
                    'sizeBytes': stat.st_size,
                    'modified': stat.st_mtime,
                    'timestamp': time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(stat.st_mtime)),
                    'url': f"/captures/{fname}"
                })
        except Exception as e:
            log.error(f"Error listing captures: {e}")

        items.sort(key=lambda x: x['modified'], reverse=True)
        return items

    def delete_capture(self, filename):
        """Deletes a captured file from Raspberry Pi storage."""
        safe_name = os.path.basename(filename)
        target = os.path.join(self.captures_dir, safe_name)
        if os.path.exists(target) and os.path.isfile(target):
            try:
                os.remove(target)
                log.info(f"Deleted capture on Pi: {target}")
                return {'success': True, 'deleted': safe_name}
            except Exception as e:
                return {'success': False, 'error': str(e)}
        return {'success': False, 'error': 'File not found'}

    # ── Internal ──────────────────────────────────────────────────────────
    def _kill_process(self):
        p = self._process
        if p:
            try:
                p.terminate()
                p.wait(timeout=3)
            except Exception:
                try:
                    p.kill()
                except Exception:
                    pass
            self._process = None

    def _detect(self):
        """Check if a CSI camera is available. Returns (ok, sensor_name)."""
        for cmd in ('rpicam-hello', 'libcamera-hello'):
            binary = shutil.which(cmd)
            if not binary:
                continue
            try:
                r = subprocess.run(
                    [binary, '--list-cameras'],
                    capture_output=True, text=True, timeout=8
                )
                out = (r.stdout + r.stderr).lower()
                log.info(f'Camera list ({cmd}):\n{r.stdout.strip()[:400]}')

                if 'no cameras available' in out or 'no cameras' in out:
                    return False, 'none'
                if 'ov5647' in out:
                    return True, 'OV5647'
                if 'imx219' in out:
                    return True, 'IMX219'
                if 'imx477' in out:
                    return True, 'IMX477'
                if 'imx' in out:
                    return True, 'IMX-series'
                if r.returncode == 0:
                    return True, 'CSI-camera'
                return False, 'none'
            except subprocess.TimeoutExpired:
                log.warning(f'{cmd} --list-cameras timed out')
            except Exception as e:
                log.warning(f'{cmd} detection error: {e}')

        return False, 'tools-missing'

    def _find_vid_bin(self):
        for name in ('rpicam-vid', 'libcamera-vid'):
            p = shutil.which(name)
            if p:
                return p
        return None

    def _worker(self):
        # ── Step 1: detect hardware ──────────────────────────────────────
        log.info('Detecting camera hardware…')
        ok, sensor = self._detect()
        if not ok:
            log.info("No physical CSI camera detected — starting synthetic live pattern generator")
            self._sensor = "Live-Generator"
            self._synthetic_worker()
            return

        self._sensor = sensor
        log.info(f'✓ Camera detected: {sensor}')

        vid_bin = self._find_vid_bin()
        if not vid_bin:
            self._status = 'offline'
            self._error  = 'rpicam-vid / libcamera-vid not found — install rpicam-apps'
            log.error(self._error)
            return

        log.info(f'Using video binary: {vid_bin}')

        # ── Step 2: capture loop with auto-restart ───────────────────────
        while self._running:
            cmd = [
                vid_bin,
                '-t',         '0',          # run forever
                '--inline',                  # inline MJPEG headers
                '--width',    str(self.width),
                '--height',   str(self.height),
                '--framerate',str(self.fps),
                '--codec',    'mjpeg',
                '--nopreview',
                '-o',         '-',           # stdout
            ]
            log.info(f'Starting: {" ".join(cmd)}')

            try:
                proc = subprocess.Popen(
                    cmd,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    bufsize=0,
                )
                self._process = proc

                # Give the camera 2 s to initialise
                time.sleep(2.0)
                if proc.poll() is not None:
                    stderr = proc.stderr.read().decode('utf-8', errors='replace')
                    log.error(f'rpicam-vid exited immediately:\n{stderr[:500]}')
                    self._status = 'error'
                    self._error  = f'Camera process exited: {stderr[:120]}'
                    if self.width > 640:
                        log.warning('Falling back to 640×480 @ 15fps…')
                        self.width, self.height, self.fps = 640, 480, 15
                    self._process = None
                    time.sleep(4)
                    continue

                self._status = 'online'
                self._error  = None
                log.info('✓ Camera streaming — reading MJPEG frames from stdout…')

                buf              = b''
                fps_window_start = time.time()
                fps_frames       = 0
                MAX_BUF          = 8 * 1024 * 1024

                while self._running and proc.poll() is None:
                    chunk = proc.stdout.read(32768)
                    if not chunk:
                        break
                    buf += chunk

                    if len(buf) > MAX_BUF:
                        i = buf.rfind(b'\xff\xd8')
                        buf = buf[i:] if i != -1 else b''

                    while True:
                        soi = buf.find(b'\xff\xd8')
                        if soi == -1:
                            buf = b''
                            break
                        eoi = buf.find(b'\xff\xd9', soi + 2)
                        if eoi == -1:
                            buf = buf[soi:]
                            break
                        frame = buf[soi:eoi + 2]
                        buf   = buf[eoi + 2:]

                        with self._lock:
                            self._frame = frame

                        if self._recording:
                            self._feed_recording_frame(frame)

                        self._frame_count  += 1
                        self._last_frame_ts = time.time()
                        fps_frames          += 1

                        now = time.time()
                        elapsed = now - fps_window_start
                        if elapsed >= 1.0:
                            self._measured_fps  = round(fps_frames / elapsed, 1)
                            fps_frames          = 0
                            fps_window_start    = now

                ret = proc.poll()
                try:
                    stderr = proc.stderr.read().decode('utf-8', errors='replace')
                except Exception:
                    stderr = ''
                log.warning(f'Camera process stopped (code={ret}): {stderr[:200]}')
                self._status = 'error'
                self._error  = f'Stopped (code={ret}): {stderr[:100]}'

            except Exception as exc:
                log.error(f'Camera worker exception: {exc}', exc_info=True)
                self._status = 'error'
                self._error  = str(exc)
            finally:
                self._kill_process()

            log.info('Restarting camera in 3 s…')
            time.sleep(3)

    def _synthetic_worker(self):
        """Synthetic test pattern generator."""
        import math
        try:
            import cv2
            import numpy as np
        except ImportError:
            return

        self._status = 'online'
        self._error = None
        t = 0.0
        fps_window_start = time.time()
        fps_frames = 0

        while self._running:
            t += 0.05
            img = np.zeros((self.height, self.width, 3), dtype=np.uint8)
            horizon_y = int(self.height * 0.45)
            img[0:horizon_y, :] = (18, 12, 8)
            img[horizon_y:, :]  = (30, 20, 15)

            cx = self.width // 2 + int(math.sin(t) * 50)
            cv2.line(img, (cx, horizon_y), (self.width // 2 - 200, self.height), (0, 229, 255), 2)
            cv2.line(img, (cx, horizon_y), (self.width // 2 + 200, self.height), (0, 229, 255), 2)

            cv2.putText(img, "VISIONPATH PI-CAM (LIVE STREAM)", (24, 44),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.9, (0, 229, 255), 2)
            cv2.putText(img, time.strftime("%Y-%m-%d %H:%M:%S"), (24, 82),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.6, (100, 200, 255), 1)

            ret, jpeg = cv2.imencode('.jpg', img, [cv2.IMWRITE_JPEG_QUALITY, 80])
            if ret:
                frame_bytes = jpeg.tobytes()
                with self._lock:
                    self._frame = frame_bytes

                if self._recording:
                    self._feed_recording_frame(frame_bytes)

                self._frame_count += 1
                self._last_frame_ts = time.time()
                fps_frames += 1

                now = time.time()
                if now - fps_window_start >= 1.0:
                    self._measured_fps = round(fps_frames / (now - fps_window_start), 1)
                    fps_frames = 0
                    fps_window_start = now

            time.sleep(1.0 / self.fps)


# ════════════════════════════════════════════════════════════════════════════
# HTTP SERVER  (MJPEG stream + health + capture endpoints)
# ════════════════════════════════════════════════════════════════════════════
_cam_mgr = None   # set in main()


class Handler(BaseHTTPRequestHandler):

    def _cors(self):
        self.send_header('Access-Control-Allow-Origin',  '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', '*')

    def _send_json(self, status_code, obj):
        body = json.dumps(obj, indent=2).encode('utf-8')
        self.send_response(status_code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_POST(self):
        path = urlparse(self.path).path.rstrip('/')

        # ── Capture Photo ────────────────────────────────────────────────
        if path in ('/api/capture/photo', '/capture/photo'):
            if _cam_mgr:
                res = _cam_mgr.capture_photo()
                code = 200 if res.get('success') else 500
                self._send_json(code, res)
            else:
                self._send_json(503, {'success': False, 'error': 'Camera manager not initialized'})

        # ── Start Video Recording ────────────────────────────────────────
        elif path in ('/api/capture/video/start', '/capture/video/start'):
            if _cam_mgr:
                res = _cam_mgr.start_recording()
                code = 200 if res.get('success') else 500
                self._send_json(code, res)
            else:
                self._send_json(503, {'success': False, 'error': 'Camera manager not initialized'})

        # ── Stop Video Recording ─────────────────────────────────────────
        elif path in ('/api/capture/video/stop', '/capture/video/stop'):
            if _cam_mgr:
                res = _cam_mgr.stop_recording()
                self._send_json(200, res)
            else:
                self._send_json(503, {'success': False, 'error': 'Camera manager not initialized'})

        else:
            self._send_json(404, {'error': 'Endpoint not found'})

    def do_DELETE(self):
        path = urlparse(self.path).path
        if path.startswith('/api/captures/'):
            filename = path[len('/api/captures/'):]
            if _cam_mgr:
                res = _cam_mgr.delete_capture(filename)
                self._send_json(200 if res.get('success') else 404, res)
            else:
                self._send_json(503, {'error': 'Camera manager offline'})
        else:
            self._send_json(404, {'error': 'Not found'})

    def do_GET(self):
        path = urlparse(self.path).path.rstrip('/')

        # ── MJPEG stream ─────────────────────────────────────────────────
        if path in ('', '/stream', '/stream.mjpg', '/video'):
            self.send_response(200)
            self.send_header('Content-Type',  'multipart/x-mixed-replace; boundary=--VISIONPATH')
            self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
            self.send_header('Pragma',        'no-cache')
            self.send_header('Age',           '0')
            self._cors()
            self.end_headers()

            log.info(f'Stream client connected: {self.client_address[0]}')
            empty_frames = 0

            while True:
                frame = _cam_mgr.get_frame() if _cam_mgr else None
                if frame:
                    empty_frames = 0
                    try:
                        header = (
                            b'----VISIONPATH\r\n'
                            b'Content-Type: image/jpeg\r\n'
                            + f'Content-Length: {len(frame)}\r\n\r\n'.encode()
                        )
                        self.wfile.write(header + frame + b'\r\n')
                        self.wfile.flush()
                    except (BrokenPipeError, ConnectionResetError, OSError):
                        log.info(f'Stream client disconnected: {self.client_address[0]}')
                        break
                    time.sleep(1.0 / 30)
                else:
                    empty_frames += 1
                    time.sleep(0.05)
                    if empty_frames > 200:
                        log.warning('No camera frames for 10 s — closing stream connection')
                        break

        # ── Health / status ──────────────────────────────────────────────
        elif path in ('/health', '/status'):
            health = _cam_mgr.get_health() if _cam_mgr else {}
            self._send_json(200, {'pi': 'online', 'camera': health})

        # ── Snapshot (single JPEG) ───────────────────────────────────────
        elif path == '/snapshot':
            frame = _cam_mgr.get_frame() if _cam_mgr else None
            if frame:
                self.send_response(200)
                self.send_header('Content-Type',   'image/jpeg')
                self.send_header('Content-Length', str(len(frame)))
                self._cors()
                self.end_headers()
                self.wfile.write(frame)
            else:
                self.send_response(503)
                self._cors()
                self.end_headers()
                self.wfile.write(b'No frame available')

        # ── Photo Capture via GET ────────────────────────────────────────
        elif path in ('/api/capture/photo', '/capture/photo'):
            if _cam_mgr:
                res = _cam_mgr.capture_photo()
                code = 200 if res.get('success') else 500
                self._send_json(code, res)
            else:
                self._send_json(503, {'success': False, 'error': 'Camera offline'})

        # ── Video Recording Start/Stop/Status via GET ────────────────────
        elif path in ('/api/capture/video/start', '/capture/video/start'):
            if _cam_mgr:
                res = _cam_mgr.start_recording()
                self._send_json(200 if res.get('success') else 500, res)
            else:
                self._send_json(503, {'success': False, 'error': 'Camera offline'})

        elif path in ('/api/capture/video/stop', '/capture/video/stop'):
            if _cam_mgr:
                res = _cam_mgr.stop_recording()
                self._send_json(200, res)
            else:
                self._send_json(503, {'success': False, 'error': 'Camera offline'})

        elif path in ('/api/capture/status', '/capture/status'):
            if _cam_mgr:
                self._send_json(200, _cam_mgr.get_recording_status())
            else:
                self._send_json(503, {'recording': False, 'error': 'Camera offline'})

        # ── List Media Captures ──────────────────────────────────────────
        elif path in ('/api/captures', '/captures'):
            if _cam_mgr:
                items = _cam_mgr.list_captures()
                self._send_json(200, {'captures': items, 'count': len(items), 'capturesDir': _cam_mgr.captures_dir})
            else:
                self._send_json(503, {'captures': []})

        # ── Serve Media Files (/captures/<filename>) ─────────────────────
        elif path.startswith('/captures/'):
            filename = path[len('/captures/'):]
            if _cam_mgr:
                safe_name = os.path.basename(filename)
                file_path = os.path.join(_cam_mgr.captures_dir, safe_name)
                if os.path.exists(file_path) and os.path.isfile(file_path):
                    lower = safe_name.lower()
                    if lower.endswith(('.jpg', '.jpeg')):
                        content_type = 'image/jpeg'
                    elif lower.endswith('.png'):
                        content_type = 'image/png'
                    elif lower.endswith('.avi'):
                        content_type = 'video/x-msvideo'
                    elif lower.endswith('.mp4'):
                        content_type = 'video/mp4'
                    else:
                        content_type = 'application/octet-stream'

                    size = os.path.getsize(file_path)
                    self.send_response(200)
                    self.send_header('Content-Type', content_type)
                    self.send_header('Content-Length', str(size))
                    self._cors()
                    self.end_headers()
                    with open(file_path, 'rb') as f:
                        shutil.copyfileobj(f, self.wfile)
                    return

            self._send_json(404, {'error': 'File not found'})

        else:
            self._send_json(404, {'error': 'Endpoint not found'})

    def log_message(self, fmt, *args):
        pass


class ThreadedServer(ThreadingMixIn, HTTPServer):
    allow_reuse_address = True
    daemon_threads      = True


# ════════════════════════════════════════════════════════════════════════════
# MAIN
# ════════════════════════════════════════════════════════════════════════════
def get_local_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('8.8.8.8', 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return '0.0.0.0'


def main():
    global _cam_mgr

    parser = argparse.ArgumentParser(
        description='VISIONPATH Raspberry Pi Camera MJPEG Server & Media Recorder'
    )
    parser.add_argument('--port',     type=int, default=8080, help='HTTP port (default: 8080)')
    parser.add_argument('--width',    type=int, default=1280, help='Frame width  (default: 1280)')
    parser.add_argument('--height',   type=int, default=720,  help='Frame height (default: 720)')
    parser.add_argument('--fps',      type=int, default=30,   help='Frame rate   (default: 30)')
    parser.add_argument('--captures', type=str, default=None, help='Captures directory path (default: ~/captures)')
    args = parser.parse_args()

    local_ip = get_local_ip()

    # Start camera capture & media manager
    _cam_mgr = CameraManager(width=args.width, height=args.height, fps=args.fps, captures_dir=args.captures)
    _cam_mgr.start()

    print('=' * 68)
    print('  VISIONPATH — Raspberry Pi Camera Server & Media Recorder')
    print(f'  Sensor       : OV5647 / CSI via rpicam-vid (with live fallback)')
    print(f'  Resolution   : {args.width}x{args.height} @ {args.fps} FPS')
    print(f'  Captures Dir : {_cam_mgr.captures_dir}')
    print(f'  Stream       : http://{local_ip}:{args.port}/stream')
    print(f'  Stream (mjpg): http://{local_ip}:{args.port}/stream.mjpg')
    print(f'  Health       : http://{local_ip}:{args.port}/health')
    print(f'  Capture Photo: http://{local_ip}:{args.port}/api/capture/photo')
    print(f'  Record Video : http://{local_ip}:{args.port}/api/capture/video/start')
    print(f'  Gallery      : http://{local_ip}:{args.port}/api/captures')
    print('=' * 68)

    # Start HTTP server bound to all interfaces
    server = ThreadedServer(('0.0.0.0', args.port), Handler)
    log.info(f'HTTP server listening on 0.0.0.0:{args.port}')

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log.info('Shutting down…')
        _cam_mgr.stop()
        server.shutdown()


if __name__ == '__main__':
    main()
