#!/usr/bin/env python3
"""
═════════════════════════════════════════════════════════════════════════════════
VISIONPATH — Raspberry Pi Companion Bridge
═════════════════════════════════════════════════════════════════════════════════
Runs on the Raspberry Pi 4B mounted on the drone.

Functions:
1. Streams Pi Camera video over HTTP (MJPEG) on port 8080.
2. Bridges Pixhawk 2.4.8 MAVLink telemetry & commands over WebSocket on port 8081.
3. Handles lateral visual auto-correction (SET_POSITION_TARGET_LOCAL_NED).
4. Handles precision landing command (CMD_NAV_LAND) at final waypoint.

Hardware Wiring:
• Pixhawk TELEM2 / TELEM1 ──> Raspberry Pi 4B GPIO 14 (TXD) & GPIO 15 (RXD)
  (/dev/ttyAMA0 or /dev/serial0 at 921600 or 57600 baud)
• Pi Camera V2 / HQ ───────> CSI ribbon cable port on Pi 4B

Installation on Raspberry Pi:
  sudo apt-get update
  sudo apt-get install -y python3-pip python3-opencv python3-picamera
  pip3 install pymavlink websockets asyncio aiohttp

Usage:
  python3 companion_bridge.py --serial /dev/ttyAMA0 --baud 921600 --cam-port 8080 --ws-port 8081
═════════════════════════════════════════════════════════════════════════════════
"""

import argparse
import asyncio
import json
import logging
import math
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from socketserver import ThreadingMixIn

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='[%(asctime)s] [%(levelname)s] %(message)s',
    datefmt='%H:%M:%S'
)
log = logging.getLogger("VisionPathBridge")

# Try importing pymavlink
try:
    from pymavlink import mavutil
    MAVLINK_AVAILABLE = True
except ImportError:
    MAVLINK_AVAILABLE = False
    log.warning("pymavlink not installed. Running in MAVLink SIMULATION mode.")

# Try importing websockets
try:
    import websockets
    WEBSOCKETS_AVAILABLE = True
except ImportError:
    WEBSOCKETS_AVAILABLE = False
    log.error("websockets package required! Install with: pip install websockets")

import os
import shutil
from urllib.parse import urlparse

# Global media captures directory
CAPTURES_DIR = os.path.join(os.path.expanduser("~"), "captures")
os.makedirs(CAPTURES_DIR, exist_ok=True)

# Global frame buffer for MJPEG streaming
current_frame = None
frame_lock = threading.Lock()

# Video recording state
is_recording = False
rec_lock = threading.Lock()
rec_writer = None
rec_filename = None
rec_filepath = None
rec_start_time = 0.0
rec_frames_count = 0


def capture_photo_disk():
    with frame_lock:
        frame = current_frame
    if not frame:
        return {'success': False, 'error': 'No frame available'}
    ts = time.strftime('%Y%m%d_%H%M%S')
    filename = f"photo_{ts}.jpg"
    filepath = os.path.join(CAPTURES_DIR, filename)
    try:
        with open(filepath, 'wb') as f:
            f.write(frame)
        size = os.path.getsize(filepath)
        log.info(f"📸 Photo captured & saved to Pi: {filepath} ({size} bytes)")
        return {
            'success': True,
            'type': 'photo',
            'filename': filename,
            'path': filepath,
            'sizeBytes': size,
            'timestamp': time.strftime('%Y-%m-%d %H:%M:%S'),
            'url': f"/captures/{filename}"
        }
    except Exception as e:
        return {'success': False, 'error': str(e)}


def start_video_rec():
    global is_recording, rec_writer, rec_filename, rec_filepath, rec_start_time, rec_frames_count
    with rec_lock:
        if is_recording:
            return {'success': True, 'recording': True, 'filename': rec_filename, 'elapsed': round(time.time() - rec_start_time, 1)}
        with frame_lock:
            frame = current_frame
        if not frame:
            return {'success': False, 'error': 'No frame available to record'}

        ts = time.strftime('%Y%m%d_%H%M%S')
        rec_filename = f"video_{ts}.avi"
        rec_filepath = os.path.join(CAPTURES_DIR, rec_filename)
        rec_start_time = time.time()
        rec_frames_count = 0

        try:
            import cv2
            import numpy as np
            fourcc = cv2.VideoWriter_fourcc(*'MJPG')
            nparr = np.frombuffer(frame, np.uint8)
            img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
            h, w = img.shape[:2]
            rec_writer = cv2.VideoWriter(rec_filepath, fourcc, 20.0, (w, h))
        except Exception:
            rec_writer = None

        is_recording = True
        log.info(f"🔴 Video recording started on Pi: {rec_filepath}")
        return {'success': True, 'recording': True, 'filename': rec_filename, 'path': rec_filepath, 'url': f"/captures/{rec_filename}"}


def stop_video_rec():
    global is_recording, rec_writer, rec_filename, rec_filepath, rec_start_time, rec_frames_count
    with rec_lock:
        if not is_recording:
            return {'success': True, 'recording': False, 'message': 'Not recording'}
        is_recording = False
        duration = round(time.time() - rec_start_time, 1) if rec_start_time > 0 else 0.0
        frames = rec_frames_count
        fname = rec_filename
        fpath = rec_filepath

        if rec_writer:
            try:
                rec_writer.release()
            except Exception:
                pass
            rec_writer = None

        size = os.path.getsize(fpath) if (fpath and os.path.exists(fpath)) else 0
        log.info(f"⏹ Video recording stopped on Pi: {fname} ({duration}s, {frames} frames, {size} bytes)")
        return {
            'success': True,
            'recording': False,
            'filename': fname,
            'durationSeconds': duration,
            'framesWritten': frames,
            'sizeBytes': size,
            'path': fpath,
            'url': f"/captures/{fname}"
        }


def feed_rec_frame(frame_bytes):
    global rec_frames_count
    if not is_recording:
        return
    with rec_lock:
        if not is_recording:
            return
        try:
            if rec_writer is not None:
                import cv2
                import numpy as np
                nparr = np.frombuffer(frame_bytes, np.uint8)
                img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
                if img is not None:
                    rec_writer.write(img)
                    rec_frames_count += 1
            else:
                with open(rec_filepath, 'ab') as f:
                    f.write(frame_bytes)
                rec_frames_count += 1
        except Exception as e:
            log.error(f"Frame record error: {e}")


def list_saved_captures():
    items = []
    if not os.path.exists(CAPTURES_DIR):
        return items
    try:
        for fname in os.listdir(CAPTURES_DIR):
            fpath = os.path.join(CAPTURES_DIR, fname)
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
        log.error(f"List captures error: {e}")
    items.sort(key=lambda x: x['modified'], reverse=True)
    return items


# ═════════════════════════════════════════════════════════════════
# 1. Camera Capture & HTTP MJPEG Streaming
# ═════════════════════════════════════════════════════════════════
class MJPEGHandler(BaseHTTPRequestHandler):

    def _cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
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
        if path in ('/api/capture/photo', '/capture/photo'):
            res = capture_photo_disk()
            self._send_json(200 if res.get('success') else 500, res)
        elif path in ('/api/capture/video/start', '/capture/video/start'):
            res = start_video_rec()
            self._send_json(200 if res.get('success') else 500, res)
        elif path in ('/api/capture/video/stop', '/capture/video/stop'):
            res = stop_video_rec()
            self._send_json(200, res)
        else:
            self._send_json(404, {'error': 'Endpoint not found'})

    def do_DELETE(self):
        path = urlparse(self.path).path
        if path.startswith('/api/captures/'):
            fname = os.path.basename(path[len('/api/captures/'):])
            fpath = os.path.join(CAPTURES_DIR, fname)
            if os.path.exists(fpath) and os.path.isfile(fpath):
                try:
                    os.remove(fpath)
                    self._send_json(200, {'success': True, 'deleted': fname})
                except Exception as e:
                    self._send_json(500, {'success': False, 'error': str(e)})
            else:
                self._send_json(404, {'error': 'File not found'})
        else:
            self._send_json(404, {'error': 'Not found'})

    def do_GET(self):
        path = urlparse(self.path).path.rstrip('/')

        if path in ('/stream', '/stream.mjpg', '', '/video'):
            self.send_response(200)
            self.send_header('Age', 0)
            self.send_header('Cache-Control', 'no-cache, private')
            self.send_header('Pragma', 'no-cache')
            self.send_header('Content-Type', 'multipart/x-mixed-replace; boundary=FRAME')
            self._cors()
            self.end_headers()

            while True:
                with frame_lock:
                    frame = current_frame
                if frame is not None:
                    try:
                        self.wfile.write(b'--FRAME\r\n')
                        self.send_header('Content-Type', 'image/jpeg')
                        self.send_header('Content-Length', str(len(frame)))
                        self.end_headers()
                        self.wfile.write(frame)
                        self.wfile.write(b'\r\n')
                    except (BrokenPipeError, ConnectionResetError):
                        break
                time.sleep(0.033)

        elif path == '/health':
            rec_status = {
                'recording': is_recording,
                'recDuration': round(time.time() - rec_start_time, 1) if is_recording else 0.0
            }
            self._send_json(200, {
                'status': 'ok',
                'service': 'visionpath-cam',
                'camera': {
                    'detected': True,
                    'streaming': current_frame is not None,
                    'recording': is_recording,
                    'recDuration': rec_status['recDuration'],
                    'capturesDir': CAPTURES_DIR
                }
            })

        elif path in ('/api/capture/photo', '/capture/photo'):
            res = capture_photo_disk()
            self._send_json(200 if res.get('success') else 500, res)

        elif path in ('/api/capture/video/start', '/capture/video/start'):
            res = start_video_rec()
            self._send_json(200 if res.get('success') else 500, res)

        elif path in ('/api/capture/video/stop', '/capture/video/stop'):
            res = stop_video_rec()
            self._send_json(200, res)

        elif path in ('/api/capture/status', '/capture/status'):
            self._send_json(200, {
                'recording': is_recording,
                'filename': rec_filename if is_recording else None,
                'elapsedSeconds': round(time.time() - rec_start_time, 1) if is_recording else 0.0,
                'framesWritten': rec_frames_count if is_recording else 0
            })

        elif path in ('/api/captures', '/captures'):
            items = list_saved_captures()
            self._send_json(200, {'captures': items, 'count': len(items), 'capturesDir': CAPTURES_DIR})

        elif path.startswith('/captures/'):
            filename = os.path.basename(path[len('/captures/'):])
            file_path = os.path.join(CAPTURES_DIR, filename)
            if os.path.exists(file_path) and os.path.isfile(file_path):
                lower = filename.lower()
                ctype = 'image/jpeg' if lower.endswith(('.jpg', '.jpeg')) else 'video/x-msvideo' if lower.endswith('.avi') else 'video/mp4' if lower.endswith('.mp4') else 'application/octet-stream'
                size = os.path.getsize(file_path)
                self.send_response(200)
                self.send_header('Content-Type', ctype)
                self.send_header('Content-Length', str(size))
                self._cors()
                self.end_headers()
                with open(file_path, 'rb') as f:
                    shutil.copyfileobj(f, self.wfile)
                return
            self._send_json(404, {'error': 'File not found'})

        else:
            self._send_json(404, {'error': 'Not found'})

    def log_message(self, format, *args):
        return


class ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True


def start_camera_thread(cam_index=0, width=960, height=540, fps=30):
    """Captures frames from Pi Camera / USB Camera / synthetic generator."""
    global current_frame

    def camera_worker():
        global current_frame
        try:
            import cv2
            cap = cv2.VideoCapture(cam_index)
            cap.set(cv2.CAP_PROP_FRAME_WIDTH, width)
            cap.set(cv2.CAP_PROP_FRAME_HEIGHT, height)
            cap.set(cv2.CAP_PROP_FPS, fps)

            if not cap.isOpened():
                log.warning(f"Could not open camera {cam_index}, switching to synthetic test pattern generator.")
                _generate_synthetic_frames(width, height)
                return

            log.info(f"Camera opened successfully ({width}x{height} @ {fps}fps)")
            while True:
                ret, frame = cap.read()
                if not ret:
                    time.sleep(0.01)
                    continue

                # Add timestamp overlay
                ts = time.strftime("%H:%M:%S")
                cv2.putText(frame, f"PI-CAM | {ts}", (16, 32),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 229, 255), 2)

                ret, jpeg = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 75])
                if ret:
                    raw_bytes = jpeg.tobytes()
                    with frame_lock:
                        current_frame = raw_bytes
                    if is_recording:
                        feed_rec_frame(raw_bytes)
                time.sleep(1.0 / fps)
        except Exception as e:
            log.error(f"OpenCV capture failed: {e}. Generating fallback synthetic pattern.")
            _generate_synthetic_frames(width, height)

    t = threading.Thread(target=camera_worker, daemon=True)
    t.start()


def _generate_synthetic_frames(width, height):
    """Fallback generator when no physical camera is attached."""
    global current_frame
    try:
        import numpy as np
        import cv2

        t = 0
        while True:
            t += 0.05
            img = np.zeros((height, width, 3), dtype=np.uint8)
            horizon_y = int(height * 0.45)
            img[0:horizon_y, :] = (18, 12, 8)
            img[horizon_y:, :] = (30, 20, 15)

            cx = width // 2 + int(math.sin(t) * 40)
            cv2.line(img, (cx, horizon_y), (width // 2 - 180, height), (0, 229, 255), 2)
            cv2.line(img, (cx, horizon_y), (width // 2 + 180, height), (0, 229, 255), 2)

            cv2.putText(img, "VISIONPATH PI-CAM (TEST PATTERN)", (20, 40),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 229, 255), 2)
            cv2.putText(img, time.strftime("%Y-%m-%d %H:%M:%S"), (20, 75),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.5, (100, 200, 255), 1)

            ret, jpeg = cv2.imencode('.jpg', img, [cv2.IMWRITE_JPEG_QUALITY, 70])
            if ret:
                raw_bytes = jpeg.tobytes()
                with frame_lock:
                    current_frame = raw_bytes
                if is_recording:
                    feed_rec_frame(raw_bytes)
            time.sleep(0.033)
    except Exception as e:
        log.error(f"Synthetic generator error: {e}")


# ═════════════════════════════════════════════════════════════════
# 2. MAVLink Interface (Pixhawk Serial / UDP)
# ═════════════════════════════════════════════════════════════════
class PixhawkBridge:
    def __init__(self, connection_str="/dev/ttyAMA0", baudrate=921600):
        self.connection_str = connection_str
        self.baudrate = baudrate
        self.master = None
        self.connected = False
        self.telemetry = {
            "alt": 0.0,
            "speed": 0.0,
            "heading": 0.0,
            "pitch": 0.0,
            "roll": 0.0,
            "yaw": 0.0,
            "battery": 98.0,
            "armed": False,
            "mode": "DISARMED",
            "lat": 0.0,
            "lon": 0.0
        }

    def connect(self):
        if not MAVLINK_AVAILABLE:
            log.warning("MAVLink running in simulation mode.")
            self.connected = True
            return True

        try:
            log.info(f"Connecting to Pixhawk at {self.connection_str} (baud={self.baudrate})…")
            self.master = mavutil.mavlink_connection(self.connection_str, baud=self.baudrate)
            log.info("Waiting for heartbeat…")
            self.master.wait_heartbeat(timeout=5)
            self.connected = True
            log.info(f"✓ Heartbeat received from System {self.master.target_system} Component {self.master.target_component}")
            return True
        except Exception as e:
            log.error(f"Pixhawk connection failed: {e}. Defaulting to telemetry simulation.")
            self.connected = False
            return False

    def read_telemetry(self):
        if not self.master or not self.connected:
            t = time.time()
            self.telemetry["alt"] = round(1.5 + math.sin(t * 0.2) * 0.08, 2)
            self.telemetry["speed"] = 0.8
            self.telemetry["heading"] = round((355.0 + math.sin(t * 0.1) * 6.0) % 360, 1)
            self.telemetry["roll"] = round(math.sin(t * 0.5) * 1.5, 1)
            self.telemetry["pitch"] = round(math.cos(t * 0.4) * 1.2, 1)
            self.telemetry["battery"] = max(10.0, round(99.0 - (t % 1000) * 0.02, 1))
            return self.telemetry

        while True:
            msg = self.master.recv_match(blocking=False)
            if not msg:
                break
            msg_type = msg.get_type()
            if msg_type == 'HEARTBEAT':
                self.telemetry["armed"] = bool(msg.base_mode & mavutil.mavlink.MAV_MODE_FLAG_SAFETY_ARMED)
                custom_mode = msg.custom_mode
                mode_map = {0: "MANUAL", 4: "GUIDED", 9: "LAND", 6: "RTL", 5: "LOITER"}
                self.telemetry["mode"] = mode_map.get(custom_mode, f"MODE_{custom_mode}")
            elif msg_type == 'ATTITUDE':
                self.telemetry["roll"] = round(math.degrees(msg.roll), 1)
                self.telemetry["pitch"] = round(math.degrees(msg.pitch), 1)
                self.telemetry["yaw"] = round(math.degrees(msg.yaw), 1)
                self.telemetry["heading"] = (round(math.degrees(msg.yaw)) + 360) % 360
            elif msg_type == 'GLOBAL_POSITION_INT':
                self.telemetry["alt"] = round(msg.relative_alt / 1000.0, 2)
                self.telemetry["speed"] = round(math.sqrt(msg.vx**2 + msg.vy**2) / 100.0, 2)
            elif msg_type == 'SYS_STATUS':
                self.telemetry["battery"] = round(msg.battery_remaining, 1)

        return self.telemetry

    def send_arm(self, arm=True):
        log.info(f"Executing: {'ARM' if arm else 'DISARM'}")
        if self.master:
            self.master.mav.command_long_send(
                self.master.target_system,
                self.master.target_component,
                mavutil.mavlink.MAV_CMD_COMPONENT_ARM_DISARM,
                0,
                1 if arm else 0, 0, 0, 0, 0, 0, 0
            )

    def set_guided_mode(self):
        log.info("Setting mode to GUIDED")
        if self.master:
            mode_id = self.master.mode_mapping().get('GUIDED', 4)
            self.master.set_mode(mode_id)

    def send_lateral_correction(self, lateral_velocity_m_s, forward_velocity_m_s=0.5):
        log.info(f"Auto-correction command: Vy={lateral_velocity_m_s:.2f} m/s, Vx={forward_velocity_m_s:.2f} m/s")
        if self.master:
            type_mask = 0b0000111111000111
            self.master.mav.set_position_target_local_ned_send(
                0,
                self.master.target_system,
                self.master.target_component,
                mavutil.mavlink.MAV_FRAME_BODY_NED,
                type_mask,
                0, 0, 0,
                forward_velocity_m_s, lateral_velocity_m_s, 0,
                0, 0, 0,
                0, 0
            )

    def precision_land(self):
        log.info("Executing PRECISION LANDING at final waypoint")
        if self.master:
            self.master.mav.command_long_send(
                self.master.target_system,
                self.master.target_component,
                mavutil.mavlink.MAV_CMD_NAV_LAND,
                0,
                1,
                0, 0, 0, 0, 0, 0
            )

    def send_condition_yaw(self, target_angle_deg, yaw_rate=20, relative=False):
        log.info(f"Executing: Condition Yaw target={target_angle_deg}°, rate={yaw_rate}°/s, rel={relative}")
        if self.master:
            direction = 1 if target_angle_deg >= 0 else -1
            self.master.mav.command_long_send(
                self.master.target_system,
                self.master.target_component,
                mavutil.mavlink.MAV_CMD_CONDITION_YAW,
                0,
                abs(target_angle_deg),
                yaw_rate,
                direction,
                1 if relative else 0,
                0, 0, 0
            )

    def send_takeoff(self, alt_m=1.5):
        log.info(f"Executing: Takeoff to {alt_m}m")
        if self.master:
            self.master.mav.command_long_send(
                self.master.target_system,
                self.master.target_component,
                mavutil.mavlink.MAV_CMD_NAV_TAKEOFF,
                0,
                0, 0, 0, 0, 0, 0,
                alt_m
            )

    def send_guided_waypoint(self, distance_m, turn_deg=0.0, speed_m_s=1.39, alt_rel_m=0.0):
        rad = math.radians(turn_deg)
        target_x = float(distance_m) * math.cos(rad)
        target_y = float(distance_m) * math.sin(rad)
        target_z = -float(alt_rel_m)  # NED: negative Z is upwards
        vx = float(speed_m_s) * math.cos(rad)
        vy = float(speed_m_s) * math.sin(rad)
        log.info(f"Executing: Guided Waypoint dist={distance_m}m, turn={turn_deg}°, Target x(fwd)={target_x:.2f}m, y(lat)={target_y:.2f}m @ {speed_m_s}m/s")

        # 1. Ensure GUIDED mode
        if self.master:
            try:
                mode_id = self.master.mode_mapping().get('GUIDED', 4)
                self.master.set_mode(mode_id)
            except Exception as e:
                log.warning(f"Could not set GUIDED mode: {e}")

        # 2. Change Speed on Pixhack / ArduCopter
        if self.master and speed_m_s > 0:
            try:
                self.master.mav.command_long_send(
                    self.master.target_system,
                    self.master.target_component,
                    mavutil.mavlink.MAV_CMD_DO_CHANGE_SPEED,
                    0,
                    0,  # 0 = airspeed/groundspeed
                    float(speed_m_s),
                    -1, 0, 0, 0, 0
                )
            except Exception as e:
                log.warning(f"Failed to set speed: {e}")

        # 3. Send Position Target Local NED with MAV_FRAME_BODY_OFFSET_NED (value 9)
        if self.master:
            # type_mask: 0b0000111111111000 (ignore velocity, accel, yaw; use position x, y, z)
            type_mask = 0b0000111111111000
            self.master.mav.set_position_target_local_ned_send(
                0,
                self.master.target_system,
                self.master.target_component,
                mavutil.mavlink.MAV_FRAME_BODY_OFFSET_NED,
                type_mask,
                target_x, target_y, target_z,
                0, 0, 0,
                0, 0, 0,
                0, 0
            )
            log.info(f"✓ Dispatched MAVLink SET_POSITION_TARGET_LOCAL_NED (BODY_OFFSET_NED) to Pixhack: x={target_x:.2f}m, y={target_y:.2f}m")
        return {"distance": distance_m, "turn": turn_deg, "x": target_x, "y": target_y, "speed": speed_m_s}


# ═════════════════════════════════════════════════════════════════
# 3. WebSocket GCS Telemetry & Command Server
# ═════════════════════════════════════════════════════════════════
connected_clients = set()
pixhawk = PixhawkBridge()


async def ws_handler(websocket, path=None):
    connected_clients.add(websocket)
    log.info(f"GCS Web client connected: {websocket.remote_address}")
    try:
        async for message in websocket:
            try:
                cmd = json.loads(message)
                action = cmd.get("action")
                log.info(f"Received GCS Command: {action} => {cmd}")

                if action == "ARM":
                    pixhawk.send_arm(True)
                elif action == "DISARM":
                    pixhawk.send_arm(False)
                elif action == "SET_MODE" and cmd.get("mode") == "GUIDED":
                    pixhawk.set_guided_mode()
                elif action == "CMD_CONDITION_YAW":
                    pixhawk.send_condition_yaw(
                        cmd.get("angle", 0.0),
                        cmd.get("rate", 20.0),
                        cmd.get("relative", False)
                    )
                elif action == "NAV_WAYPOINT_REL":
                    dist = float(cmd.get("distance", 1.0))
                    turn = float(cmd.get("turn", 0.0))
                    speed = float(cmd.get("speed", 1.39))
                    alt = float(cmd.get("alt", 0.0))
                    res = pixhawk.send_guided_waypoint(
                        distance_m=dist,
                        turn_deg=turn,
                        speed_m_s=speed,
                        alt_rel_m=alt
                    )
                    ack_msg = json.dumps({
                        "type": "cmd_ack",
                        "action": "NAV_WAYPOINT_REL",
                        "status": "EXECUTED",
                        "distance": dist,
                        "turn": turn,
                        "x": res.get("x") if res else dist,
                        "y": res.get("y") if res else 0.0,
                        "speed": speed,
                        "message": f"Pixhack executing waypoint: dist={dist:.2f}m, turn={turn:.1f}°"
                    })
                    await websocket.send(ack_msg)
                elif action == "CMD_NAV_TAKEOFF":
                    pixhawk.send_takeoff(cmd.get("alt", 1.5))
                elif action == "SET_POSITION_TARGET_LOCAL_NED":
                    vy = cmd.get("vy", 0.0)
                    vx = cmd.get("vx", 0.5)
                    pixhawk.send_lateral_correction(vy, vx)
                elif action == "CMD_NAV_LAND":
                    pixhawk.precision_land()
                elif action == "CMD_NAV_RETURN_TO_LAUNCH":
                    log.info("Executing Return to Launch (RTL)")
                    if pixhawk.master:
                        mode_id = pixhawk.master.mode_mapping().get('RTL', 6)
                        pixhawk.master.set_mode(mode_id)

                elif action == "CAPTURE_PHOTO":
                    res = capture_photo_disk()
                    await websocket.send(json.dumps({"type": "capture_result", "data": res}))
                elif action == "START_VIDEO_REC":
                    res = start_video_rec()
                    await websocket.send(json.dumps({"type": "capture_result", "data": res}))
                elif action == "STOP_VIDEO_REC":
                    res = stop_video_rec()
                    await websocket.send(json.dumps({"type": "capture_result", "data": res}))
            except Exception as e:
                log.error(f"Command execution error: {e}")
    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        connected_clients.remove(websocket)
        log.info("GCS Web client disconnected")


async def telemetry_broadcast_loop():
    """Broadcasts 10Hz telemetry to all connected web clients."""
    while True:
        if connected_clients:
            telem = pixhawk.read_telemetry()
            payload = json.dumps({"type": "telemetry", "data": telem})
            await asyncio.gather(
                *[client.send(payload) for client in connected_clients],
                return_exceptions=True
            )
        await asyncio.sleep(0.1)


# ═════════════════════════════════════════════════════════════════
# Main Entry Point
# ═════════════════════════════════════════════════════════════════
async def async_main(args, http_server):
    log.info(f"✓ Starting WebSocket MAVLink Server on ws://0.0.0.0:{args.ws_port}")
    async with websockets.serve(ws_handler, "0.0.0.0", args.ws_port):
        broadcast_task = asyncio.create_task(telemetry_broadcast_loop())
        try:
            await asyncio.Future()
        except asyncio.CancelledError:
            broadcast_task.cancel()
            http_server.shutdown()


def main():
    global CAPTURES_DIR
    parser = argparse.ArgumentParser(description="VISIONPATH Raspberry Pi Companion Bridge & Media Recorder")
    parser.add_argument("--serial", default="/dev/ttyAMA0", help="Pixhawk serial port or UDP (e.g. /dev/ttyAMA0, COM3, udp:127.0.0.1:14550)")
    parser.add_argument("--baud", type=int, default=921600, help="Pixhawk baudrate (default: 921600)")
    parser.add_argument("--cam-port", type=int, default=8080, help="HTTP MJPEG camera stream port (default: 8080)")
    parser.add_argument("--ws-port", type=int, default=8081, help="WebSocket MAVLink bridge port (default: 8081)")
    parser.add_argument("--cam-index", type=int, default=0, help="Camera device index (default: 0)")
    parser.add_argument("--captures", type=str, default=None, help="Captures directory path (default: ~/captures)")
    args = parser.parse_args()

    if args.captures:
        CAPTURES_DIR = os.path.abspath(args.captures)
        os.makedirs(CAPTURES_DIR, exist_ok=True)

    print("=" * 72)
    print("  VISIONPATH — Companion Bridge & Media Recorder")
    print(f"  Captures Dir  : {CAPTURES_DIR}")
    print(f"  Camera Stream : http://0.0.0.0:{args.cam_port}/stream")
    print(f"  Capture Photo : http://0.0.0.0:{args.cam_port}/api/capture/photo")
    print(f"  Record Video  : http://0.0.0.0:{args.cam_port}/api/capture/video/start")
    print(f"  Gallery       : http://0.0.0.0:{args.cam_port}/api/captures")
    print(f"  MAVLink WS    : ws://0.0.0.0:{args.ws_port}")
    print("=" * 72)

    # 1. Start Camera capture & HTTP server
    start_camera_thread(cam_index=args.cam_index)
    http_server = ThreadedHTTPServer(('0.0.0.0', args.cam_port), MJPEGHandler)
    http_thread = threading.Thread(target=http_server.serve_forever, daemon=True)
    http_thread.start()
    log.info(f"✓ Camera MJPEG Stream active at: http://0.0.0.0:{args.cam_port}/stream")

    # 2. Connect to Pixhawk (or simulation fallback)
    pixhawk.connection_str = args.serial
    pixhawk.baudrate = args.baud
    pixhawk.connect()

    # 3. Start WebSocket Server for GCS
    if not WEBSOCKETS_AVAILABLE:
        log.error("Cannot start WebSocket server without 'websockets' library. Exiting.")
        sys.exit(1)

    try:
        asyncio.run(async_main(args, http_server))
    except KeyboardInterrupt:
        log.info("Bridge shutting down…")
        http_server.shutdown()


if __name__ == '__main__':
    main()

