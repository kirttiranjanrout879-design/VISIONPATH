# VISIONPATH — GPS-Denied Visual Path Following GCS

**Ground Control Station for autonomous drone flight without GPS, using forward-facing visual path following and MAVLink telemetry.**

---

## 🚀 Quick Start

Just open `index.html` in any modern browser (Chrome recommended). No build step, no server required.

```
flyingbots/
├── index.html          # Main entry point — open this
├── css/
│   ├── style.css       # Design system, layout, boot splash, toasts
│   ├── hud.css         # Top telemetry HUD bar
│   ├── camera.css      # Camera viewport, overlay, scan lines
│   ├── panels.css      # Side panels — deviation, attitude, waypoints, calibration
│   └── modals.css      # Calibration wizard & settings dialog
└── js/
    ├── settings.js     # Global settings store
    ├── utils.js        # Shared math & DOM helpers
    ├── calibration.js  # Camera calibration (GSD + wizard)
    ├── simulation.js   # Procedural forward-view scene renderer
    ├── pathManager.js  # Waypoint storage, overlay drawing, deviation calc
    ├── deviation.js    # XTE meter, gauge canvas, auto-correction
    ├── mavlink.js      # MAVLink engine (WebSocket + simulation fallback)
    ├── hud.js          # Attitude indicator, HUD tiles, scale ruler
    ├── camera.js       # Camera source: sim / webcam / Pi MJPEG
    ├── flightRecorder.js# 10Hz Telemetry recording & CSV export
    ├── topDownMap.js   # 2D Top-down metric ground-plane path reconstruction
    └── main.js         # Bootstrap, main loop, UI event wiring
```

---

## 🎮 Interface Guide

### Top HUD Bar
| Field | Description |
|-------|-------------|
| ⏺ REC | **10Hz Telemetry Recorder** — records flight log & exports timestamped `.csv` |
| ALTITUDE | Current AGL altitude (m) from MAVLink |
| AIRSPEED | Forward speed (m/s) |
| HEADING | Yaw angle (degrees) |
| PITCH / ROLL | Attitude angles |
| DEVIATION | Cross-track error from path (m) — **turns red if > threshold** |
| BATTERY | Battery % with colour bar |
| FLIGHT MODE | DISARMED / GUIDED / LAND / RTL |
| LINK | WebSocket connection status |

### Camera Toolbar & Overlays
| Button | Description |
|--------|-------------|
| `📸 PHOTO` | **Capture Photo Snapshot** — captures and saves full-resolution image directly to Raspberry Pi storage (`/home/flyingbots/captures/photo_*.jpg`) |
| `⏺ REC` | **Record Video** — starts/stops live video recording directly onto Raspberry Pi storage (`/home/flyingbots/captures/video_*.avi`) |
| `📁 GALLERY` | **Pi Saved Media Gallery** — view, preview, save, or delete captured photos and videos stored on the Raspberry Pi |
| `🗺 2D MAP` | Toggle 2D Top-Down (Birds-Eye) Metric Ground Map PIP |
| `📷 SOURCE` | Switch video source: **PI CAM** / **WEBCAM** / **SIM** |
| `🗑 CLEAR` | Clear current waypoints |
| `💾 EXPORT` | Export waypoints and calibration configuration as JSON |
| `🎬 DEMO` | Toggle 3D procedural simulated forward view |

### Keyboard Shortcuts
| Key | Action |
|-----|--------|
| `P` | **Capture Photo Snapshot** on Raspberry Pi |
| `V` | **Start / Stop Video Recording** on Raspberry Pi |
| `D` | Switch to **Draw Path** tab |
| `F` | Switch to **Follow Path** tab |
| `C` | Switch to **Calibrate** tab |
| `Space` | Start / Pause path following |
| `Esc` | Close any open modal |

---

## 📐 Calibration Workflow

### Quick Calibration (Right Panel)
1. Enter **Camera FOV** (H) — for Pi Camera: 62.2°
2. Enter **Altitude AGL** in cm
3. Enter **Camera Tilt** (0° = horizontal forward)
4. Click **▣ CALIBRATE NOW**

### Wizard Calibration (⊕ CALIBRATION WIZARD)
1. **Step 1:** Place a visible object at a known distance (e.g. 200 cm)
2. **Step 2:** Click on the object in the camera feed preview
3. **Step 3:** Enter the actual distance and current altitude
4. **Step 4:** Review and apply — GSD and px/m ratio are computed

> **Method:** `GSD = 2 × H × tan(FOV/2) / imageWidth`  
> **Direct:** `px/m = pixelOffset / realWorldDistance`

---

## 🛣 Path Following Workflow

1. **Click DRAW PATH tab** → click on camera feed to place waypoints
2. Final waypoint is automatically tagged **LAND 🛬**
3. Click **▶ START FOLLOW** in the Waypoints panel
4. System tracks cross-track error (XTE) in real-time
5. If drone drifts > **2m** from path, **⚠ WARNING** banner appears
6. **Auto-correct** sends MAVLink `SET_POSITION_TARGET_LOCAL_NED` commands
7. At the final waypoint: `CMD_NAV_LAND precision=1` triggers precision landing

---

## 🔌 Connecting Real Hardware

### Connection Panel (Right panel, bottom)
| Field | Value |
|-------|-------|
| Pi IP / Host | Your Raspberry Pi's IP (e.g. `192.168.1.100`) |
| MAVLink Port | `14550` (UDP) or your mavproxy port |
| Cam Stream Port | `8080` for MJPEG stream |

### Raspberry Pi Setup (All-in-One Companion Bridge)
We provide a complete turnkey bridge script [`companion_bridge.py`](file:///c:/Users/kirtt/OneDrive/Desktop/flyingbots/companion_bridge.py) for the Raspberry Pi 4B:

```bash
# 1. Install dependencies on Raspberry Pi:
pip3 install pymavlink websockets opencv-python

# 2. Run the companion bridge:
python3 companion_bridge.py --serial /dev/ttyAMA0 --baud 921600 --cam-port 8080 --ws-port 8081
```

This single command:
- 🎥 Streams the Pi Camera feed at `http://PI_IP:8080/stream`
- 📡 Bridges Pixhawk MAVLink telemetry & visual auto-corrections over WebSocket `ws://PI_IP:8081`
- 🛬 Triggers precision landing at the final waypoint automatically

### Camera Source Toggle
- **SIM** → Procedural animated scene (default, no hardware needed)
- **WEBCAM** → Laptop webcam via `getUserMedia`
- **PI** → Raspberry Pi MJPEG stream over network

Use the **📷 SOURCE** button in the toolbar or **Settings → Camera → Source**.

---

## 📡 MAVLink Commands Sent

| Action | MAVLink Message |
|--------|----------------|
| ARM | `CMD_COMPONENT_ARM_DISARM arm=1` |
| DISARM | `CMD_COMPONENT_ARM_DISARM arm=0` |
| Set GUIDED mode | `SET_MODE GUIDED` |
| Navigate to waypoint | `CMD_NAV_WAYPOINT` |
| Path correction | `SET_POSITION_TARGET_LOCAL_NED` |
| Precision land | `CMD_NAV_LAND precision=1` |
| RTL | `CMD_NAV_RETURN_TO_LAUNCH` |

---

## 🔧 Technical Notes

### Why not fixed px-per-meter?
Pixels cannot be treated as a fixed real-world distance — perspective, FOV, altitude, and camera tilt all affect the mapping. VISIONPATH uses:
- **GSD method** (altitude + FOV → ground coverage per pixel)
- **Reference object method** (wizard: known distance → pixel offset ratio)

### GPS-Denied Position Estimation
The visual system provides **lateral correction** only. For a fully robust GPS-denied system, combine this with:
- **Optical flow** (PX4Flow sensor, ArduPilot EKF3 OF mode)
- **Visual-Inertial Odometry** (VINS-Mono, MSCKF, or OpenVINS on Pi 4)
- **Rangefinder/LiDAR** for altitude hold without barometer drift

### Auto-Correction Logic
```
XTE (px) → XTE (m) via calibration
if |XTE_m| > threshold (default 2.0m):
    corrAngle = clamp(|XTE_m| × 3, 0, maxAngle°)
    send MAVLink lateral velocity command
    show warning banner
```

---

## 📝 System Flow (per spec)

| Step | Implementation |
|------|---------------|
| 1. Pi Camera captures | `Camera.setSource('pi')` → MJPEG stream |
| 2. Pi processes | Pi runs mjpg-streamer or libcamera-vid |
| 3. Laptop displays | Live video rendered in `#cam-viewport` |
| 4. Operator draws path | DRAW PATH tab → click waypoints on feed |
| 5. Vision detects deviation | `PathManager.getDeviation()` computes XTE |
| 6. System calculates correction | `DeviationEngine._sendCorrection()` |
| 7. Pi sends MAVLink | `mavlink.js → WebSocket → Pi bridge → FC` |
| 8. Pixhawk stabilises | FC handles motor mixing & PID |
| 9. Final WP → land | `CMD_NAV_LAND precision=1` |
