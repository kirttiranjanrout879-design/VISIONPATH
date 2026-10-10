#!/usr/bin/env python3
"""
═════════════════════════════════════════════════════════════════════════════════
VISIONPATH — Production Raspberry Pi 4B Agent
═════════════════════════════════════════════════════════════════════════════════
Hardware Architecture:
• Flight Controller: Pixhack 2.4.8 (ArduCopter 4.6.3 Hexacopter)
  TELEM1 -> Raspberry Pi /dev/ttyS0 @ 57600 baud (MAVLink 2)
• Camera: Raspberry Pi Camera Module (OV5647 CSI sensor)
  Stack: libcamera / rpicam-vid (1920x1080 @ 30 FPS MJPEG)
• Network:
  - HTTP Server (Port 8080): /stream (MJPEG), /health, /diagnostics
  - WebSocket Server (Port 8081): 10Hz Real Telemetry & Bidirectional Link
═════════════════════════════════════════════════════════════════════════════════
"""

import argparse
import asyncio
import json
import logging
import math
import os
import shutil
import signal
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from socketserver import ThreadingMixIn
from urllib.parse import urlparse

# Force MAVLink 2 protocol
os.environ["MAVLINK20"] = "1"

# Configure Logging
logging.basicConfig(
    level=logging.INFO,
    format='[%(asctime)s] [%(levelname)s] [PiAgent] %(message)s',
    datefmt='%H:%M:%S'
)
log = logging.getLogger("PiAgent")

# Dependencies verification
try:
    from pymavlink import mavutil
    MAVLINK_AVAILABLE = True
except ImportError:
    MAVLINK_AVAILABLE = False
    log.error("pymavlink is not installed! Install with: pip3 install pymavlink")

try:
    import websockets
    WEBSOCKETS_AVAILABLE = True
except ImportError:
    WEBSOCKETS_AVAILABLE = False
    log.error("websockets is not installed! Install with: pip3 install websockets")


# ═════════════════════════════════════════════════════════════════
# 1. CAMERA SUBSYSTEM (OV5647 via libcamera / rpicam-vid)
# ═════════════════════════════════════════════════════════════════
class PiCameraManager:
    """
    Manages the physical Raspberry Pi CSI camera (OV5647).
    Uses modern rpicam-vid / libcamera-vid subprocess at 1920x1080 @ 30 FPS.
    Captures live MJPEG frames and monitors camera health.
    """
    def __init__(self, width=1920, height=1080, fps=30):
        self.width = width
        self.height = height
        self.fps = fps
        self.current_frame = None
        self.frame_lock = threading.Lock()
        self.running = False
        self.process = None
        self.status = "offline"   # "online" | "offline" | "error"
        self.error_msg = None
        self.sensor_name = "Unknown"
        self.frame_count = 0
        self.last_frame_ts = 0
        self.measured_fps = 0.0

    def detect_hardware(self):
        """Checks if Pi OS detects the CSI camera. Tries multiple tool names."""
        # Try several command names for different Pi OS versions
        detect_cmds = ["rpicam-hello", "libcamera-hello"]
        bin_cmd = None
        for c in detect_cmds:
            found = shutil.which(c)
            if found:
                bin_cmd = found
                break

        if not bin_cmd:
            self.status = "offline"
            self.error_msg = (
                "rpicam-apps not installed. Fix: sudo apt install -y rpicam-apps libcamera-apps"
            )
            log.warning(self.error_msg)
            return False

        try:
            # Use timeout so this never hangs
            res = subprocess.run(
                [bin_cmd, "--list-cameras"],
                capture_output=True, text=True, timeout=8
            )
            output = (res.stdout + res.stderr).strip()
            log.info(f"Camera list:\n{output}")

            lo = output.lower()
            if "ov5647" in lo:
                self.sensor_name = "OV5647"
            elif "imx219" in lo:
                self.sensor_name = "IMX219"
            elif "imx477" in lo:
                self.sensor_name = "IMX477"
            elif "imx" in lo:
                self.sensor_name = "Sony IMX"
            elif "no cameras available" in lo or "no cameras" in lo:
                self.status = "offline"
                self.error_msg = "No camera detected. Check CSI ribbon cable & enable camera in raspi-config."
                log.error(self.error_msg)
                return False
            elif "available" in lo or res.returncode == 0:
                # Generic: some camera found
                self.sensor_name = "CSI Camera"
            else:
                self.status = "offline"
                self.error_msg = f"Camera not detected (exit {res.returncode}). Output: {output[:120]}"
                log.warning(self.error_msg)
                return False

            log.info(f"✓ Camera detected: {self.sensor_name}")
            return True

        except subprocess.TimeoutExpired:
            self.status = "error"
            self.error_msg = "Camera detection timed out (8s)"
            log.error(self.error_msg)
            return False
        except Exception as e:
            self.status = "error"
            self.error_msg = f"Detection error: {e}"
            log.error(self.error_msg)
            return False

    def _find_vid_binary(self):
        """Find the correct video capture binary."""
        for name in ["rpicam-vid", "libcamera-vid"]:
            path = shutil.which(name)
            if path:
                return path
        return None

    def _build_cmd(self, vid_bin):
        """Build rpicam-vid command. Try different flag sets for compatibility."""
        # Base command that works on Pi OS Trixie / Bookworm with rpicam-apps
        cmd = [
            vid_bin,
            "-t", "0",          # Run indefinitely
            "--inline",          # Inline headers for MJPEG
            "--width",  str(self.width),
            "--height", str(self.height),
            "--framerate", str(self.fps),
            "--codec", "mjpeg",
            "--nopreview",
            "-o", "-"           # Output to stdout
        ]
        return cmd

    def start(self):
        self.running = True
        t = threading.Thread(target=self._capture_worker, daemon=True, name="CameraWorker")
        t.start()

    def _capture_worker(self):
        # Detect hardware ONCE before starting the capture loop
        log.info("Starting camera detection…")
        hw_ok = self.detect_hardware()
        if not hw_ok:
            log.error(f"Camera hardware not found: {self.error_msg}")
            # Keep retrying detection every 10s in case camera is plugged in late
            while self.running and not hw_ok:
                time.sleep(10)
                hw_ok = self.detect_hardware()

        vid_bin = self._find_vid_binary()
        if not vid_bin:
            self.status = "offline"
            self.error_msg = "rpicam-vid / libcamera-vid not found. Install rpicam-apps."
            log.error(self.error_msg)
            return

        log.info(f"Camera binary: {vid_bin}")

        while self.running:
            cmd = self._build_cmd(vid_bin)
            log.info(f"Launching: {' '.join(cmd)}")

            try:
                self.process = subprocess.Popen(
                    cmd,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    bufsize=0          # Unbuffered for lowest latency
                )

                # Give camera 2s to initialise before declaring online
                time.sleep(1.5)
                if self.process.poll() is not None:
                    # Process already exited — read stderr for reason
                    err_out = self.process.stderr.read().decode('utf-8', errors='ignore')
                    log.error(f"Camera process exited immediately: {err_out.strip()[:200]}")
                    # Try lower resolution fallback
                    if self.width > 640:
                        log.info("Retrying at lower resolution 640x480…")
                        self.width, self.height, self.fps = 640, 480, 15
                    self.status = "error"
                    self.error_msg = f"rpicam-vid exited: {err_out.strip()[:100]}"
                    time.sleep(3)
                    continue

                self.status = "online"
                self.error_msg = None
                log.info("✓ Camera process running — reading MJPEG frames…")

                # MJPEG frame reader: scan stdout for JPEG SOI/EOI markers
                buf = b''
                last_fps_calc = time.time()
                frames_in_window = 0
                MAX_BUF = 4 * 1024 * 1024  # 4 MB safety cap

                while self.running and self.process.poll() is None:
                    chunk = self.process.stdout.read(32768)
                    if not chunk:
                        break
                    buf += chunk

                    # Trim buffer if it grows too large (prevents OOM)
                    if len(buf) > MAX_BUF:
                        idx = buf.rfind(b'\xff\xd8')
                        buf = buf[idx:] if idx != -1 else b''

                    # Extract complete JPEG frames
                    while True:
                        a = buf.find(b'\xff\xd8')
                        if a == -1:
                            break
                        b_end = buf.find(b'\xff\xd9', a + 2)
                        if b_end == -1:
                            break
                        jpg = buf[a : b_end + 2]
                        buf = buf[b_end + 2:]

                        with self.frame_lock:
                            self.current_frame = jpg

                        self.frame_count += 1
                        self.last_frame_ts = time.time()
                        frames_in_window += 1

                        now = time.time()
                        if now - last_fps_calc >= 1.0:
                            self.measured_fps = round(frames_in_window / (now - last_fps_calc), 1)
                            frames_in_window = 0
                            last_fps_calc = now

                # Process ended
                if self.process:
                    ret = self.process.poll()
                    try:
                        err_out = self.process.stderr.read().decode('utf-8', errors='ignore')
                    except Exception:
                        err_out = ""
                    log.warning(f"Camera process stopped (code {ret}): {err_out.strip()[:200]}")
                    self.status = "error"
                    self.error_msg = f"Stopped (code {ret}): {err_out.strip()[:80]}"

            except Exception as exc:
                self.status = "error"
                self.error_msg = f"Capture exception: {exc}"
                log.error(self.error_msg, exc_info=True)

            finally:
                if self.process:
                    try:
                        self.process.terminate()
                    except Exception:
                        pass
                    self.process = None

            time.sleep(3)  # Brief pause before restart

    def get_latest_frame(self):
        with self.frame_lock:
            return self.current_frame

    def get_state(self):
        now = time.time()
        is_stalled = (now - self.last_frame_ts > 3.0) if self.last_frame_ts > 0 else True
        effective_status = self.status
        if self.status == "online" and is_stalled:
            effective_status = "error"

        rec_stat = self.get_recording_status()
        return {
            "status": effective_status,
            "sensor": self.sensor_name,
            "fps": self.measured_fps,
            "frames_produced": self.frame_count,
            "last_frame_age_s": round(now - self.last_frame_ts, 2) if self.last_frame_ts > 0 else None,
            "error": self.error_msg,
            "recording": rec_stat["recording"],
            "rec_duration_s": rec_stat["elapsedSeconds"],
            "captures_dir": getattr(self, "captures_dir", os.path.join(os.path.expanduser("~"), "captures"))
        }

    # ── Photo & Video Storage on Raspberry Pi ─────────────────────────
    def capture_photo(self):
        """Saves current JPEG frame directly to Raspberry Pi storage."""
        frame = self.get_latest_frame()
        if not frame:
            return {"success": False, "error": "No camera frame available"}

        captures_dir = getattr(self, "captures_dir", os.path.join(os.path.expanduser("~"), "captures"))
        os.makedirs(captures_dir, exist_ok=True)
        ts = time.strftime("%Y%m%d_%H%M%S")
        filename = f"photo_{ts}.jpg"
        filepath = os.path.join(captures_dir, filename)

        try:
            with open(filepath, "wb") as f:
                f.write(frame)
            size = os.path.getsize(filepath)
            log.info(f"📸 Saved photo to Pi: {filepath} ({size} bytes)")
            return {
                "success": True,
                "type": "photo",
                "filename": filename,
                "path": filepath,
                "sizeBytes": size,
                "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
                "url": f"/captures/{filename}"
            }
        except Exception as e:
            log.error(f"Failed to save photo: {e}")
            return {"success": False, "error": str(e)}

    def start_recording(self):
        """Starts saving incoming frames to an AVI/MJPEG video file on Raspberry Pi."""
        if not hasattr(self, "_rec_lock"):
            self._rec_lock = threading.Lock()
            self._recording = False
            self._rec_writer = None
            self._rec_filename = None
            self._rec_filepath = None
            self._rec_start_ts = 0.0
            self._rec_frames = 0

        with self._rec_lock:
            if self._recording:
                return {"success": True, "recording": True, "filename": self._rec_filename, "elapsed": round(time.time() - self._rec_start_ts, 1)}

            frame = self.get_latest_frame()
            if not frame:
                return {"success": False, "error": "No camera feed available to record"}

            captures_dir = getattr(self, "captures_dir", os.path.join(os.path.expanduser("~"), "captures"))
            os.makedirs(captures_dir, exist_ok=True)
            ts = time.strftime("%Y%m%d_%H%M%S")
            self._rec_filename = f"video_{ts}.avi"
            self._rec_filepath = os.path.join(captures_dir, self._rec_filename)
            self._rec_start_ts = time.time()
            self._rec_frames = 0

            try:
                import cv2
                import numpy as np
                fourcc = cv2.VideoWriter_fourcc(*'MJPG')
                nparr = np.frombuffer(frame, np.uint8)
                img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
                h, w = img.shape[:2]
                self._rec_writer = cv2.VideoWriter(self._rec_filepath, fourcc, 20.0, (w, h))
            except Exception:
                self._rec_writer = None

            self._recording = True
            log.info(f"🔴 Started video recording on Pi: {self._rec_filepath}")
            return {
                "success": True,
                "recording": True,
                "filename": self._rec_filename,
                "path": self._rec_filepath,
                "url": f"/captures/{self._rec_filename}"
            }

    def _feed_recording(self, frame_bytes):
        if not getattr(self, "_recording", False):
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
                        self._rec_frames += 1
                else:
                    with open(self._rec_filepath, "ab") as f:
                        f.write(frame_bytes)
                    self._rec_frames += 1
            except Exception as e:
                log.error(f"Video frame write error: {e}")

    def stop_recording(self):
        """Stops active recording session on Raspberry Pi."""
        if not hasattr(self, "_rec_lock"):
            return {"success": True, "recording": False}
        with self._rec_lock:
            if not self._recording:
                return {"success": True, "recording": False, "message": "Not recording"}
            self._recording = False
            duration = round(time.time() - self._rec_start_ts, 1) if self._rec_start_ts > 0 else 0.0
            frames = self._rec_frames
            fname = self._rec_filename
            fpath = self._rec_filepath

            if self._rec_writer is not None:
                try:
                    self._rec_writer.release()
                except Exception:
                    pass
                self._rec_writer = None

            size = os.path.getsize(fpath) if (fpath and os.path.exists(fpath)) else 0
            log.info(f"⏹ Stopped recording on Pi: {fname} ({duration}s, {frames} frames, {size} bytes)")
            return {
                "success": True,
                "recording": False,
                "filename": fname,
                "durationSeconds": duration,
                "framesWritten": frames,
                "sizeBytes": size,
                "path": fpath,
                "url": f"/captures/{fname}"
            }

    def get_recording_status(self):
        if not getattr(self, "_recording", False):
            return {"recording": False, "filename": None, "elapsedSeconds": 0.0, "framesWritten": 0}
        with self._rec_lock:
            now = time.time()
            elapsed = round(now - self._rec_start_ts, 1) if self._recording else 0.0
            return {
                "recording": self._recording,
                "filename": self._rec_filename if self._recording else None,
                "elapsedSeconds": elapsed,
                "framesWritten": self._rec_frames if self._recording else 0
            }

    def list_captures(self):
        captures_dir = getattr(self, "captures_dir", os.path.join(os.path.expanduser("~"), "captures"))
        items = []
        if not os.path.exists(captures_dir):
            return items
        try:
            for fname in os.listdir(captures_dir):
                fpath = os.path.join(captures_dir, fname)
                if not os.path.isfile(fpath):
                    continue
                lower = fname.lower()
                ctype = "photo" if lower.endswith(('.jpg', '.jpeg', '.png')) else "video" if lower.endswith(('.avi', '.mp4', '.mjpg', '.h264')) else None
                if not ctype:
                    continue
                stat = os.stat(fpath)
                items.append({
                    "filename": fname,
                    "type": ctype,
                    "sizeBytes": stat.st_size,
                    "modified": stat.st_mtime,
                    "timestamp": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(stat.st_mtime)),
                    "url": f"/captures/{fname}"
                })
        except Exception as e:
            log.error(f"Error listing captures: {e}")
        items.sort(key=lambda x: x["modified"], reverse=True)
        return items

    def delete_capture(self, filename):
        captures_dir = getattr(self, "captures_dir", os.path.join(os.path.expanduser("~"), "captures"))
        safe_name = os.path.basename(filename)
        target = os.path.join(captures_dir, safe_name)
        if os.path.exists(target) and os.path.isfile(target):
            try:
                os.remove(target)
                return {"success": True, "deleted": safe_name}
            except Exception as e:
                return {"success": False, "error": str(e)}
        return {"success": False, "error": "File not found"}

    def stop(self):
        self.running = False
        self.stop_recording()
        if self.process:
            try:
                self.process.terminate()
            except Exception:
                pass


# ═════════════════════════════════════════════════════════════════
# 2. MAVLINK SUBSYSTEM (Pixhack 2.4.8 /dev/ttyS0 @ 57600 baud)
# ═════════════════════════════════════════════════════════════════
class PixhackMAVLinkManager:
    """
    Manages true MAVLink 2 connection to Pixhack 2.4.8.
    Never creates fake telemetry.
    Strictly reports real flight modes, battery, attitude, and GPS.
    """
    COPTER_MODES = {
        0: 'STABILIZE', 1: 'ACRO', 2: 'ALT_HOLD', 3: 'AUTO', 4: 'GUIDED',
        5: 'LOITER', 6: 'RTL', 7: 'CIRCLE', 9: 'LAND', 11: 'DRIFT',
        13: 'SPORT', 14: 'FLIP', 15: 'AUTOTUNE', 16: 'POSHOLD', 17: 'BRAKE',
        18: 'THROW', 19: 'AVOID_ADSB', 20: 'GUIDED_NOGPS', 21: 'SMART_RTL',
        22: 'FLOWHOLD', 23: 'FOLLOW', 24: 'ZIGZAG', 25: 'SYSTEMID',
        26: 'AUTOROTATE', 27: 'AUTO_RTL'
    }

    def __init__(self, serial_port="/dev/ttyS0", baud=57600, udp_endpoint=None):
        self.serial_port = serial_port
        self.baud = baud
        self.udp_endpoint = udp_endpoint
        self.master = None
        self.running = False
        self.connected = False
        self.status = "offline"   # "online" | "offline" | "error"
        self.error_msg = "Not connected"
        self.last_heartbeat_ts = 0
        self.system_id = 0
        self.component_id = 0
        self.firmware = "ArduCopter"

        # Real telemetry packet store
        self.telemetry = {
            "sysid": None,
            "compid": None,
            "firmware": "ArduCopter 4.6.3",
            "armed": False,
            "mode": "DISARMED",
            "alt": None,
            "rel_alt": None,
            "speed": None,
            "airspeed": None,
            "heading": None,
            "pitch": None,
            "roll": None,
            "yaw": None,
            "battery": None,
            "battery_v": None,
            "gps_fix": None,
            "gps_sats": None,
            "lat": None,
            "lon": None,
            "local_x": None,
            "local_y": None,
            "local_z": None,
            "vx": None,
            "vy": None,
            "vz": None,
            "rc_channels": []
        }
        self.telem_lock = threading.Lock()

    def start(self):
        self.running = True
        t = threading.Thread(target=self._mavlink_worker, daemon=True)
        t.start()

    def _connect(self):
        if not MAVLINK_AVAILABLE:
            self.status = "error"
            self.error_msg = "pymavlink library not available"
            return False

        # If UDP endpoint configured (e.g. from MAVProxy output udp:127.0.0.1:14550)
        target = self.udp_endpoint if self.udp_endpoint else self.serial_port

        try:
            if target.startswith("udp:") or target.startswith("udpin:"):
                log.info(f"Connecting MAVLink via network: {target}…")
                self.master = mavutil.mavlink_connection(target)
            else:
                log.info(f"Connecting to Pixhack at {target} ({self.baud} baud)…")
                self.master = mavutil.mavlink_connection(target, baud=self.baud)

            # Wait for first real heartbeat (timeout 3 seconds)
            log.info("Awaiting Pixhack heartbeat…")
            hb = self.master.wait_heartbeat(timeout=3.0)
            if hb:
                self.last_heartbeat_ts = time.time()
                self.system_id = self.master.target_system
                self.component_id = self.master.target_component
                self.status = "online"
                self.error_msg = None
                log.info(f"✓ Pixhack heartbeat received! SysID: {self.system_id}, CompID: {self.component_id}")
                return True
            else:
                self.status = "offline"
                self.error_msg = f"No heartbeat on {target} @ {self.baud} baud within 3s"
                log.warning(self.error_msg)
                return False

        except Exception as e:
            self.status = "error"
            self.error_msg = f"Connection error: {e}"
            log.error(self.error_msg)
            return False

    def _mavlink_worker(self):
        while self.running:
            if not self.master or self.status != "online":
                ok = self._connect()
                if not ok:
                    time.sleep(3)
                    continue

            # Read real MAVLink messages
            try:
                msg = self.master.recv_match(blocking=True, timeout=0.5)
                if msg is None:
                    # Check heartbeat timeout
                    if time.time() - self.last_heartbeat_ts > 3.5:
                        self.status = "offline"
                        self.error_msg = f"Heartbeat lost ({round(time.time() - self.last_heartbeat_ts, 1)}s ago)"
                    continue

                msg_type = msg.get_type()

                with self.telem_lock:
                    if msg_type == 'HEARTBEAT':
                        self.last_heartbeat_ts = time.time()
                        self.status = "online"
                        self.error_msg = None
                        self.system_id = msg.get_srcSystem()
                        self.component_id = msg.get_srcComponent()
                        self.telemetry["sysid"] = self.system_id
                        self.telemetry["compid"] = self.component_id
                        self.telemetry["armed"] = bool(msg.base_mode & mavutil.mavlink.MAV_MODE_FLAG_SAFETY_ARMED)
                        custom_mode = msg.custom_mode
                        self.telemetry["mode"] = self.COPTER_MODES.get(custom_mode, f"MODE_{custom_mode}")

                    elif msg_type == 'ATTITUDE':
                        self.telemetry["roll"] = round(math.degrees(msg.roll), 1)
                        self.telemetry["pitch"] = round(math.degrees(msg.pitch), 1)
                        self.telemetry["yaw"] = round(math.degrees(msg.yaw), 1)
                        self.telemetry["heading"] = round((math.degrees(msg.yaw) + 360) % 360, 1)

                    elif msg_type == 'VFR_HUD':
                        self.telemetry["alt"] = round(msg.alt, 2)
                        self.telemetry["airspeed"] = round(msg.airspeed, 2)
                        self.telemetry["speed"] = round(msg.groundspeed, 2)
                        if msg.heading:
                            self.telemetry["heading"] = round(msg.heading, 1)

                    elif msg_type == 'GLOBAL_POSITION_INT':
                        self.telemetry["rel_alt"] = round(msg.relative_alt / 1000.0, 2)
                        self.telemetry["lat"] = round(msg.lat / 1e7, 6)
                        self.telemetry["lon"] = round(msg.lon / 1e7, 6)
                        self.telemetry["vx"] = round(msg.vx / 100.0, 3)
                        self.telemetry["vy"] = round(msg.vy / 100.0, 3)
                        self.telemetry["vz"] = round(msg.vz / 100.0, 3)

                    elif msg_type == 'LOCAL_POSITION_NED':
                        self.telemetry["local_x"] = round(msg.x, 3)
                        self.telemetry["local_y"] = round(msg.y, 3)
                        self.telemetry["local_z"] = round(msg.z, 3)
                        self.telemetry["vx"] = round(msg.vx, 3)
                        self.telemetry["vy"] = round(msg.vy, 3)
                        self.telemetry["vz"] = round(msg.vz, 3)

                    elif msg_type == 'SYS_STATUS':
                        self.telemetry["battery"] = round(msg.battery_remaining, 1)
                        self.telemetry["battery_v"] = round(msg.voltage_battery / 1000.0, 2)

                    elif msg_type == 'GPS_RAW_INT':
                        self.telemetry["gps_fix"] = msg.fix_type
                        self.telemetry["gps_sats"] = msg.satellites_visible

                    elif msg_type == 'RC_CHANNELS':
                        self.telemetry["rc_channels"] = [
                            msg.chan1_raw, msg.chan2_raw, msg.chan3_raw, msg.chan4_raw,
                            msg.chan5_raw, msg.chan6_raw, msg.chan7_raw, msg.chan8_raw
                        ]

            except Exception as e:
                log.error(f"MAVLink reading error: {e}")
                self.status = "error"
                self.error_msg = str(e)
                time.sleep(2)

    def get_telemetry(self):
        with self.telem_lock:
            return dict(self.telemetry)

    def get_state(self):
        now = time.time()
        age = round(now - self.last_heartbeat_ts, 2) if self.last_heartbeat_ts > 0 else None
        effective_status = self.status
        if self.last_heartbeat_ts > 0 and (now - self.last_heartbeat_ts > 3.0):
            effective_status = "offline"

        return {
            "status": effective_status,
            "sysid": self.system_id,
            "compid": self.component_id,
            "firmware": self.firmware,
            "mode": self.telemetry["mode"],
            "armed": self.telemetry["armed"],
            "last_heartbeat_age_s": age,
            "error": self.error_msg
        }

    # ── Safe Manual Commands (Triggered only by explicit operator action) ──
    def send_arm(self, arm=True):
        if self.master:
            log.info(f"Manual operator command: {'ARM' if arm else 'DISARM'}")
            self.master.mav.command_long_send(
                self.master.target_system,
                self.master.target_component,
                mavutil.mavlink.MAV_CMD_COMPONENT_ARM_DISARM,
                0,
                1 if arm else 0, 0, 0, 0, 0, 0, 0
            )

    def set_mode(self, mode_name):
        if self.master and mode_name in self.master.mode_mapping():
            log.info(f"Manual operator mode change: {mode_name}")
            mode_id = self.master.mode_mapping()[mode_name]
            self.master.set_mode(mode_id)

    def return_to_launch(self):
        if self.master:
            log.info("Manual operator command: RTL")
            self.set_mode("RTL")

    def precision_land(self):
        if self.master:
            log.info("Manual operator command: LAND (precision)")
            self.master.mav.command_long_send(
                self.master.target_system,
                self.master.target_component,
                mavutil.mavlink.MAV_CMD_NAV_LAND,
                0,
                1, 0, 0, 0, 0, 0, 0
            )

    def send_lateral_correction(self, vy, vx=0.5):
        if self.master and self.status == "online":
            type_mask = 0b0000111111000111  # velocity only
            self.master.mav.set_position_target_local_ned_send(
                0,
                self.master.target_system,
                self.master.target_component,
                mavutil.mavlink.MAV_FRAME_BODY_NED,
                type_mask,
                0, 0, 0,
                vx, vy, 0,
                0, 0, 0,
                0, 0
            )


# ═════════════════════════════════════════════════════════════════
# 3. HTTP MJPEG & HEALTH API SERVER (Port 8080)
# ═════════════════════════════════════════════════════════════════
camera_mgr = None
mavlink_mgr = None


class AgentHTTPHandler(BaseHTTPRequestHandler):

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
            if camera_mgr:
                res = camera_mgr.capture_photo()
                self._send_json(200 if res.get('success') else 500, res)
            else:
                self._send_json(503, {'success': False, 'error': 'Camera offline'})

        elif path in ('/api/capture/video/start', '/capture/video/start'):
            if camera_mgr:
                res = camera_mgr.start_recording()
                self._send_json(200 if res.get('success') else 500, res)
            else:
                self._send_json(503, {'success': False, 'error': 'Camera offline'})

        elif path in ('/api/capture/video/stop', '/capture/video/stop'):
            if camera_mgr:
                res = camera_mgr.stop_recording()
                self._send_json(200, res)
            else:
                self._send_json(503, {'success': False, 'error': 'Camera offline'})
        else:
            self._send_json(404, {'error': 'Endpoint not found'})

    def do_DELETE(self):
        path = urlparse(self.path).path.rstrip('/')
        if path.startswith('/api/captures/'):
            fname = os.path.basename(path[len('/api/captures/'):])
            if camera_mgr:
                res = camera_mgr.delete_capture(fname)
                self._send_json(200 if res.get('success') else 404, res)
            else:
                self._send_json(503, {'error': 'Camera offline'})
        else:
            self._send_json(404, {'error': 'Not found'})

    def do_GET(self):
        path = urlparse(self.path).path.rstrip('/')

        # 1. Video MJPEG Stream
        if path in ('/stream', '/stream.mjpg', '', '/video'):
            self.send_response(200)
            self.send_header('Age', '0')
            self.send_header('Cache-Control', 'no-cache, private')
            self.send_header('Pragma', 'no-cache')
            self.send_header('Content-Type', 'multipart/x-mixed-replace; boundary=FRAME')
            self._cors()
            self.end_headers()

            while True:
                frame = camera_mgr.get_latest_frame() if camera_mgr else None
                if frame is not None:
                    try:
                        self.wfile.write(
                            b'--FRAME\r\n'
                            b'Content-Type: image/jpeg\r\n'
                            + f'Content-Length: {len(frame)}\r\n\r\n'.encode()
                            + frame
                            + b'\r\n'
                        )
                        self.wfile.flush()
                    except (BrokenPipeError, ConnectionResetError, OSError):
                        break
                else:
                    time.sleep(0.033)
                    continue
                time.sleep(0.033)  # ~30 FPS

        # 2. Health & Status JSON API
        elif path in ('/health', '/status'):
            cam_state = camera_mgr.get_state() if camera_mgr else {}
            mav_state = mavlink_mgr.get_state() if mavlink_mgr else {}

            payload = {
                "pi": "online",
                "mavlink": mav_state.get("status", "offline"),
                "camera": cam_state.get("status", "offline"),
                "camera_sensor": cam_state.get("sensor", "OV5647"),
                "camera_fps": cam_state.get("fps", 0),
                "camera_error": cam_state.get("error"),
                "recording": cam_state.get("recording", False),
                "rec_duration_s": cam_state.get("rec_duration_s", 0.0),
                "sysid": mav_state.get("sysid"),
                "compid": mav_state.get("compid"),
                "firmware": mav_state.get("firmware"),
                "mode": mav_state.get("mode"),
                "armed": mav_state.get("armed"),
                "last_heartbeat_s": mav_state.get("last_heartbeat_age_s"),
                "mavlink_error": mav_state.get("error")
            }
            self._send_json(200, payload)

        # 3. Snapshot (Single JPEG)
        elif path == '/snapshot':
            frame = camera_mgr.get_latest_frame() if camera_mgr else None
            if frame:
                self.send_response(200)
                self.send_header('Content-Type', 'image/jpeg')
                self.send_header('Content-Length', str(len(frame)))
                self._cors()
                self.end_headers()
                self.wfile.write(frame)
            else:
                self._send_json(503, {'error': 'No frame available'})

        # 4. Photo & Video API (GET aliases)
        elif path in ('/api/capture/photo', '/capture/photo'):
            if camera_mgr:
                res = camera_mgr.capture_photo()
                self._send_json(200 if res.get('success') else 500, res)
            else:
                self._send_json(503, {'success': False, 'error': 'Camera offline'})

        elif path in ('/api/capture/video/start', '/capture/video/start'):
            if camera_mgr:
                res = camera_mgr.start_recording()
                self._send_json(200 if res.get('success') else 500, res)
            else:
                self._send_json(503, {'success': False, 'error': 'Camera offline'})

        elif path in ('/api/capture/video/stop', '/capture/video/stop'):
            if camera_mgr:
                res = camera_mgr.stop_recording()
                self._send_json(200, res)
            else:
                self._send_json(503, {'success': False, 'error': 'Camera offline'})

        elif path in ('/api/capture/status', '/capture/status'):
            if camera_mgr:
                self._send_json(200, camera_mgr.get_recording_status())
            else:
                self._send_json(503, {'recording': False})

        # 5. Media Gallery List
        elif path in ('/api/captures', '/captures'):
            if camera_mgr:
                items = camera_mgr.list_captures()
                self._send_json(200, {'captures': items, 'count': len(items), 'capturesDir': camera_mgr.captures_dir})
            else:
                self._send_json(503, {'captures': []})

        # 6. Serve Media File
        elif path.startswith('/captures/'):
            filename = os.path.basename(path[len('/captures/'):])
            captures_dir = getattr(camera_mgr, 'captures_dir', os.path.join(os.path.expanduser('~'), 'captures')) if camera_mgr else os.path.join(os.path.expanduser('~'), 'captures')
            file_path = os.path.join(captures_dir, filename)
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

        # 7. Full Hardware Diagnostics Endpoint
        elif path == '/diagnostics':
            cam_state = camera_mgr.get_state() if camera_mgr else {}
            mav_state = mavlink_mgr.get_state() if mavlink_mgr else {}

            diag = {
                "test1_pi_reachable": {"pass": True, "msg": "Raspberry Pi Agent online"},
                "test2_uart_device": {
                    "pass": os.path.exists(mavlink_mgr.serial_port) if mavlink_mgr else False,
                    "msg": f"UART device {mavlink_mgr.serial_port if mavlink_mgr else '/dev/ttyS0'}"
                },
                "test3_mavlink_hb": {
                    "pass": mav_state.get("status") == "online",
                    "msg": f"Heartbeat: {mav_state.get('status')} (Age: {mav_state.get('last_heartbeat_age_s')}s)"
                },
                "test4_pixhack_fw": {
                    "pass": bool(mav_state.get("firmware") and mav_state.get("sysid")),
                    "msg": f"Firmware: {mav_state.get('firmware')} (SysID: {mav_state.get('sysid')})"
                },
                "test5_camera_detected": {
                    "pass": cam_state.get("status") == "online",
                    "msg": f"Sensor: {cam_state.get('sensor')} ({cam_state.get('status')})"
                },
                "test6_camera_streaming": {
                    "pass": cam_state.get("fps", 0) > 0,
                    "msg": f"Stream FPS: {cam_state.get('fps', 0)} ({cam_state.get('frames_produced', 0)} frames produced)"
                }
            }
            self._send_json(200, diag)

        else:
            self._send_json(404, {'error': 'Endpoint not found'})

    def log_message(self, format, *args):
        return


class ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True


# ═════════════════════════════════════════════════════════════════
# 4. WEBSOCKET SERVER (Port 8081)
# ═════════════════════════════════════════════════════════════════
ws_clients = set()


async def ws_handler(websocket, path=None):
    ws_clients.add(websocket)
    log.info(f"GCS client connected: {websocket.remote_address}")

    try:
        init_state = {
            "type": "status",
            "data": {
                "pi": "online",
                "mavlink": mavlink_mgr.get_state().get("status", "offline") if mavlink_mgr else "offline",
                "camera": camera_mgr.get_state().get("status", "offline") if camera_mgr else "offline"
            }
        }
        await websocket.send(json.dumps(init_state))
    except Exception:
        pass

    try:
        async for message in websocket:
            try:
                cmd = json.loads(message)
                action = cmd.get("action")
                log.info(f"Received GCS Command: {action}")

                if mavlink_mgr:
                    if action == "ARM":
                        mavlink_mgr.send_arm(True)
                    elif action == "DISARM":
                        mavlink_mgr.send_arm(False)
                    elif action == "CMD_NAV_RETURN_TO_LAUNCH":
                        mavlink_mgr.return_to_launch()
                    elif action == "CMD_NAV_LAND":
                        mavlink_mgr.precision_land()
                    elif action == "SET_MODE":
                        mavlink_mgr.set_mode(cmd.get("mode", "GUIDED"))
                    elif action == "SET_POSITION_TARGET_LOCAL_NED":
                        vy = cmd.get("vy", 0.0)
                        vx = cmd.get("vx", 0.5)
                        mavlink_mgr.send_lateral_correction(vy, vx)

                if action == "CAPTURE_PHOTO" and camera_mgr:
                    res = camera_mgr.capture_photo()
                    await websocket.send(json.dumps({"type": "capture_result", "data": res}))
                elif action == "START_VIDEO_REC" and camera_mgr:
                    res = camera_mgr.start_recording()
                    await websocket.send(json.dumps({"type": "capture_result", "data": res}))
                elif action == "STOP_VIDEO_REC" and camera_mgr:
                    res = camera_mgr.stop_recording()
                    await websocket.send(json.dumps({"type": "capture_result", "data": res}))

            except Exception as e:
                log.error(f"Error handling WebSocket message: {e}")
    except (websockets.exceptions.ConnectionClosed,
            websockets.exceptions.ConnectionClosedOK,
            websockets.exceptions.ConnectionClosedError):
        pass
    finally:
        ws_clients.discard(websocket)
        log.info("GCS client disconnected")


async def telemetry_broadcast_loop():
    """Broadcasts real 10Hz MAVLink telemetry and 1Hz health status."""
    last_status_broadcast = 0
    while True:
        if ws_clients:
            now = time.time()

            # 1. Telemetry Broadcast (10 Hz)
            if mavlink_mgr:
                telem = mavlink_mgr.get_telemetry()
                payload = json.dumps({"type": "telemetry", "data": telem})
                dead = set()
                results = await asyncio.gather(
                    *[client.send(payload) for client in list(ws_clients)],
                    return_exceptions=True
                )
                for client, result in zip(list(ws_clients), results):
                    if isinstance(result, Exception):
                        dead.add(client)
                ws_clients -= dead

            # 2. Status Broadcast (1 Hz)
            if now - last_status_broadcast >= 1.0:
                last_status_broadcast = now
                cam_state = camera_mgr.get_state() if camera_mgr else {}
                mav_state = mavlink_mgr.get_state() if mavlink_mgr else {}

                status_payload = json.dumps({
                    "type": "status",
                    "data": {
                        "pi": "online",
                        "mavlink": mav_state.get("status", "offline"),
                        "camera": cam_state.get("status", "offline"),
                        "camera_sensor": cam_state.get("sensor", "OV5647"),
                        "camera_fps": cam_state.get("fps", 0),
                        "camera_error": cam_state.get("error"),
                        "sysid": mav_state.get("sysid"),
                        "compid": mav_state.get("compid"),
                        "firmware": mav_state.get("firmware"),
                        "mode": mav_state.get("mode"),
                        "armed": mav_state.get("armed"),
                        "last_heartbeat": mav_state.get("last_heartbeat_age_s"),
                        "mavlink_error": mav_state.get("error")
                    }
                })
                dead2 = set()
                results2 = await asyncio.gather(
                    *[client.send(status_payload) for client in list(ws_clients)],
                    return_exceptions=True
                )
                for client, result in zip(list(ws_clients), results2):
                    if isinstance(result, Exception):
                        dead2.add(client)
                ws_clients -= dead2

        await asyncio.sleep(0.1)  # 10 Hz loop


async def async_main(args, http_server):
    log.info(f"✓ Starting WebSocket server on ws://0.0.0.0:{args.ws_port}…")
    async with websockets.serve(ws_handler, "0.0.0.0", args.ws_port):
        broadcast_task = asyncio.create_task(telemetry_broadcast_loop())
        try:
            await asyncio.Future()  # Run indefinitely
        except asyncio.CancelledError:
            broadcast_task.cancel()
            http_server.shutdown()


# ═════════════════════════════════════════════════════════════════
# 5. MAIN ENTRY POINT
# ═════════════════════════════════════════════════════════════════
def main():
    global camera_mgr, mavlink_mgr

    parser = argparse.ArgumentParser(description="VISIONPATH Production Raspberry Pi Agent")
    parser.add_argument("--serial", default="/dev/ttyS0", help="Pixhack UART serial port (default: /dev/ttyS0)")
    parser.add_argument("--baud", type=int, default=57600, help="Pixhack TELEM1 baudrate (default: 57600)")
    parser.add_argument("--mavlink-udp", default=None, help="Optional UDP MAVLink input (e.g. udpin:0.0.0.0:14550 if MAVProxy forwards)")
    parser.add_argument("--cam-port", type=int, default=8080, help="HTTP MJPEG video stream port (default: 8080)")
    parser.add_argument("--ws-port", type=int, default=8081, help="WebSocket telemetry port (default: 8081)")
    parser.add_argument("--cam-w", type=int, default=1920, help="Camera width (default: 1920)")
    parser.add_argument("--cam-h", type=int, default=1080, help="Camera height (default: 1080)")
    parser.add_argument("--cam-fps", type=int, default=30, help="Camera FPS (default: 30)")
    args = parser.parse_args()

    print("=" * 76)
    print("  VISIONPATH — Production Raspberry Pi 4B Agent")
    print(f"  Pixhack UART : {args.serial} @ {args.baud} baud (MAVLink 2)")
    print(f"  CSI Camera   : {args.cam_w}x{args.cam_h} @ {args.cam_fps} FPS via libcamera/rpicam-vid")
    print(f"  Stream Port  : http://0.0.0.0:{args.cam_port}/stream")
    print(f"  WS Telemetry : ws://0.0.0.0:{args.ws_port}")
    print("=" * 76)

    # 1. Start Camera Manager
    camera_mgr = PiCameraManager(width=args.cam_w, height=args.cam_h, fps=args.cam_fps)
    camera_mgr.start()

    # 2. Start HTTP MJPEG & Health Server (Port 8080)
    http_server = ThreadedHTTPServer(('0.0.0.0', args.cam_port), AgentHTTPHandler)
    http_thread = threading.Thread(target=http_server.serve_forever, daemon=True)
    http_thread.start()
    log.info(f"✓ HTTP stream server listening on http://0.0.0.0:{args.cam_port}/stream")

    # 3. Start Pixhack MAVLink Manager
    mavlink_mgr = PixhackMAVLinkManager(
        serial_port=args.serial,
        baud=args.baud,
        udp_endpoint=args.mavlink_udp
    )
    mavlink_mgr.start()

    # 4. Start WebSocket Server (Port 8081)
    if not WEBSOCKETS_AVAILABLE:
        log.error("websockets library required! Run: pip3 install websockets")
        sys.exit(1)

    try:
        asyncio.run(async_main(args, http_server))
    except KeyboardInterrupt:
        log.info("Pi Agent shutting down cleanly…")
        if camera_mgr: camera_mgr.stop()
        if http_server: http_server.shutdown()


if __name__ == '__main__':
    main()
