#!/usr/bin/env python3
"""
================================================================================
VISIONPATH -- Raspberry Pi Camera Server (/home/bk/camera/camera_server.py)
================================================================================
Streams live MJPEG video from Raspberry Pi CSI Camera (OV5647 / rpicam-vid)
and provides health check endpoint with full CORS support.

Endpoints:
  GET /stream.mjpg   - Real-time MJPEG video stream (multipart/x-mixed-replace)
  GET /stream        - Alias for /stream.mjpg
  GET /health        - Health check JSON: {"status": "ok", "camera": "online"}
  OPTIONS /*         - CORS preflight response
================================================================================
"""

import argparse
import io
import json
import logging
import os
import shutil
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from socketserver import ThreadingMixIn
from urllib.parse import urlparse

logging.basicConfig(
    level=logging.INFO,
    format='[%(asctime)s] [%(levelname)s] [PiCamServer] %(message)s',
    datefmt='%H:%M:%S'
)
log = logging.getLogger('PiCamServer')

# ---------------------------------------------------------------------------
# Camera Manager (rpicam-vid / libcamera-vid)
# ---------------------------------------------------------------------------
class CameraStreamer:
    def __init__(self, width=1280, height=720, fps=30):
        self.width = width
        self.height = height
        self.fps = fps
        self._lock = threading.Lock()
        self._frame = None
        self._running = False
        self._process = None
        self._last_frame_ts = 0.0
        self._frame_count = 0
        self._status = 'initializing'

    def start(self):
        self._running = True
        t = threading.Thread(target=self._capture_loop, daemon=True, name='CamCaptureThread')
        t.start()

    def get_frame(self):
        with self._lock:
            return self._frame

    def is_online(self):
        if self._last_frame_ts > 0 and (time.time() - self._last_frame_ts) < 3.0:
            return True
        return False

    def _find_vid_bin(self):
        for name in ('rpicam-vid', 'libcamera-vid'):
            p = shutil.which(name)
            if p:
                return p
        return None

    def _capture_loop(self):
        vid_bin = self._find_vid_bin()
        if not vid_bin:
            log.warning('Neither rpicam-vid nor libcamera-vid found in PATH. Checking fallback locations...')
            for fallback in ('/usr/bin/rpicam-vid', '/usr/bin/libcamera-vid'):
                if os.path.exists(fallback):
                    vid_bin = fallback
                    break

        if not vid_bin:
            log.error('rpicam-vid / libcamera-vid not found! Please install rpicam-apps.')
            self._status = 'error_no_binary'
            return

        log.info(f'Using camera binary: {vid_bin} ({self.width}x{self.height} @ {self.fps}fps)')

        while self._running:
            cmd = [
                vid_bin,
                '-t', '0',
                '--inline',
                '--width', str(self.width),
                '--height', str(self.height),
                '--framerate', str(self.fps),
                '--codec', 'mjpeg',
                '--nopreview',
                '-o', '-'
            ]
            log.info(f'Starting capture: {" ".join(cmd)}')

            try:
                proc = subprocess.Popen(
                    cmd,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    bufsize=0
                )
                self._process = proc
                self._status = 'running'

                buf = b''
                MAX_BUF = 8 * 1024 * 1024

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
                        buf = buf[eoi + 2:]

                        with self._lock:
                            self._frame = frame
                            self._last_frame_ts = time.time()
                            self._frame_count += 1

                ret = proc.poll()
                log.warning(f'Camera process exited with code {ret}')
            except Exception as e:
                log.error(f'Camera capture error: {e}')
            finally:
                if self._process:
                    try:
                        self._process.terminate()
                        self._process.wait(timeout=2)
                    except Exception:
                        try:
                            self._process.kill()
                        except Exception:
                            pass
                    self._process = None

            time.sleep(2)

    def stop(self):
        self._running = False
        if self._process:
            try:
                self._process.kill()
            except Exception:
                pass


# ---------------------------------------------------------------------------
# HTTP Handler with CORS & /health & /stream.mjpg
# ---------------------------------------------------------------------------
cam_streamer = None

class StreamingHandler(BaseHTTPRequestHandler):

    def _send_cors_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, OPTIONS, HEAD')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With')

    def do_OPTIONS(self):
        self.send_response(204)
        self._send_cors_headers()
        self.send_header('Content-Length', '0')
        self.end_headers()

    def do_GET(self):
        parsed_path = urlparse(self.path).path.rstrip('/')

        # ── Health Check ─────────────────────────────────────────────────
        if parsed_path == '/health':
            is_ok = cam_streamer.is_online() if cam_streamer else True
            payload = json.dumps({
                "status": "ok",
                "camera": "online" if is_ok else "starting",
                "fps": cam_streamer.fps if cam_streamer else 30,
                "resolution": f"{cam_streamer.width}x{cam_streamer.height}" if cam_streamer else "1280x720",
                "frames": cam_streamer._frame_count if cam_streamer else 0
            }, indent=2).encode('utf-8')

            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(payload)))
            self._send_cors_headers()
            self.end_headers()
            self.wfile.write(payload)
            return

        # ── Live MJPEG Stream ────────────────────────────────────────────
        if parsed_path in ('', '/stream.mjpg', '/stream', '/video'):
            self.send_response(200)
            self.send_header('Content-Type', 'multipart/x-mixed-replace; boundary=--VISIONPATH')
            self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
            self.send_header('Pragma', 'no-cache')
            self.send_header('Age', '0')
            self._send_cors_headers()
            self.end_headers()

            log.info(f'Stream client connected: {self.client_address[0]}')

            while True:
                frame = cam_streamer.get_frame() if cam_streamer else None
                if frame:
                    try:
                        header = (
                            b'--VISIONPATH\r\n'
                            b'Content-Type: image/jpeg\r\n'
                            + f'Content-Length: {len(frame)}\r\n\r\n'.encode()
                        )
                        self.wfile.write(header + frame + b'\r\n')
                        self.wfile.flush()
                    except (BrokenPipeError, ConnectionResetError, OSError):
                        log.info(f'Stream client disconnected: {self.client_address[0]}')
                        break
                    time.sleep(1.0 / (cam_streamer.fps if cam_streamer else 30))
                else:
                    time.sleep(0.04)
            return

        # ── 404 for unknown endpoints ────────────────────────────────────
        self.send_response(404)
        self.send_header('Content-Type', 'application/json')
        self._send_cors_headers()
        self.end_headers()
        self.wfile.write(json.dumps({"error": "Not Found", "path": self.path}).encode('utf-8'))

    def log_message(self, format, *args):
        # Suppress noisy access logging for stream chunks
        pass


class ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
    allow_reuse_address = True
    daemon_threads = True


def main():
    global cam_streamer

    parser = argparse.ArgumentParser(description='VISIONPATH Raspberry Pi Camera Server')
    parser.add_argument('--port',   type=int, default=8080, help='HTTP port (default: 8080)')
    parser.add_argument('--width',  type=int, default=1280, help='Capture width (default: 1280)')
    parser.add_argument('--height', type=int, default=720,  help='Capture height (default: 720)')
    parser.add_argument('--fps',    type=int, default=30,   help='Framerate (default: 30)')
    args = parser.parse_args()

    cam_streamer = CameraStreamer(width=args.width, height=args.height, fps=args.fps)
    cam_streamer.start()

    server = ThreadedHTTPServer(('0.0.0.0', args.port), StreamingHandler)
    log.info(f'===============================================================')
    log.info(f'  VISIONPATH CAMERA SERVER STARTED on port {args.port}')
    log.info(f'  Stream URL : http://0.0.0.0:{args.port}/stream.mjpg')
    log.info(f'  Health URL : http://0.0.0.0:{args.port}/health')
    log.info(f'===============================================================')

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log.info('Stopping camera server...')
        cam_streamer.stop()
        server.server_close()


if __name__ == '__main__':
    main()
