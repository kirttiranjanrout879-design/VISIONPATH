#!/usr/bin/env python3
"""
VISIONPATH — Raspberry Pi Camera Diagnostic Script
Run on the Raspberry Pi to find why the camera is offline.

  python3 pi_diagnose.py

Tests:
  1. rpicam-hello / libcamera-hello available
  2. Camera hardware detected (OV5647)
  3. rpicam-vid available
  4. Camera can capture actual frames
  5. HTTP port 8080 available (not in use)
  6. pi_camera_server.py present
"""

import os
import shutil
import socket
import subprocess
import sys
import time

PASS = '\033[92m✓ PASS\033[0m'
FAIL = '\033[91m✗ FAIL\033[0m'
WARN = '\033[93m⚠ WARN\033[0m'
INFO = '\033[96mℹ INFO\033[0m'

results = []

def section(title):
    print(f'\n{"─"*60}')
    print(f'  {title}')
    print('─'*60)

def test(name, ok, detail=''):
    tag = PASS if ok else FAIL
    line = f'  {tag}  {name}'
    if detail:
        line += f'\n         {detail}'
    print(line)
    results.append((name, ok, detail))
    return ok

def run(cmd, timeout=10):
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return r.returncode, r.stdout + r.stderr
    except subprocess.TimeoutExpired:
        return -1, 'TIMEOUT'
    except FileNotFoundError:
        return -2, f'Command not found: {cmd[0]}'
    except Exception as e:
        return -3, str(e)


# ══════════════════════════════════════════════════════════════════
# TEST 1 — rpicam-hello / libcamera-hello
# ══════════════════════════════════════════════════════════════════
section('TEST 1 — Camera Tools')

hello_bin = shutil.which('rpicam-hello') or shutil.which('libcamera-hello')
if test('rpicam-hello or libcamera-hello found', bool(hello_bin),
        hello_bin or 'Fix: sudo apt install -y rpicam-apps'):
    # Run --list-cameras
    code, out = run([hello_bin, '--list-cameras'])
    print(f'\n  Camera list output:\n  {out.strip().replace(chr(10), chr(10)+"  ")}')

    if 'no cameras available' in out.lower() or 'no cameras' in out.lower():
        test('OV5647 detected', False,
             'No camera found. Check CSI ribbon cable and run: sudo raspi-config → Interface Options → Camera → Enable')
    elif 'ov5647' in out.lower():
        test('OV5647 detected', True, 'OV5647 confirmed')
    elif 'imx' in out.lower():
        test('CSI camera detected', True, 'IMX-series camera found')
    elif code == 0:
        test('CSI camera detected (generic)', True, out[:80])
    else:
        test('Camera detected', False, f'Exit code {code}: {out[:120]}')
else:
    print(f'  Fix: sudo apt install -y rpicam-apps libcamera-apps')


# ══════════════════════════════════════════════════════════════════
# TEST 2 — rpicam-vid binary
# ══════════════════════════════════════════════════════════════════
section('TEST 2 — Video Capture Binary')

vid_bin = shutil.which('rpicam-vid') or shutil.which('libcamera-vid')
test('rpicam-vid or libcamera-vid found', bool(vid_bin),
     vid_bin or 'Fix: sudo apt install -y rpicam-apps')


# ══════════════════════════════════════════════════════════════════
# TEST 3 — Actual Frame Capture (5 second test)
# ══════════════════════════════════════════════════════════════════
section('TEST 3 — Frame Capture (5 second live test)')

if vid_bin:
    print(f'  Running: {vid_bin} for 5 seconds → /tmp/visionpath_test.mjpeg')
    cmd = [
        vid_bin,
        '-t', '5000',
        '--width', '1280', '--height', '720',
        '--framerate', '10',
        '--codec', 'mjpeg',
        '--nopreview',
        '-o', '/tmp/visionpath_test.mjpeg'
    ]
    code, out = run(cmd, timeout=12)
    if code == 0 and os.path.exists('/tmp/visionpath_test.mjpeg'):
        size = os.path.getsize('/tmp/visionpath_test.mjpeg')
        test('Camera captured frames', size > 10000,
             f'Captured {size:,} bytes in /tmp/visionpath_test.mjpeg')
        os.remove('/tmp/visionpath_test.mjpeg')
    else:
        test('Camera captured frames', False,
             f'Exit {code}: {out[:200]}')
        print(f'\n  ⚠ rpicam-vid stderr:\n  {out[:400]}')
else:
    test('Camera captured frames', False, 'rpicam-vid not found — skipped')


# ══════════════════════════════════════════════════════════════════
# TEST 4 — MJPEG Stdout Streaming (what pi_camera_server.py uses)
# ══════════════════════════════════════════════════════════════════
section('TEST 4 — MJPEG Stdout Stream (2 second test)')

if vid_bin:
    import select, signal

    print('  Starting rpicam-vid stdout stream for 2 seconds…')
    cmd = [
        vid_bin,
        '-t', '0',
        '--inline',
        '--width', '640', '--height', '480',
        '--framerate', '10',
        '--codec', 'mjpeg',
        '--nopreview',
        '-o', '-'
    ]
    try:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0)
        time.sleep(2.5)

        if proc.poll() is not None:
            stderr = proc.stderr.read().decode('utf-8', errors='replace')
            test('MJPEG stdout stream works', False, f'Process exited: {stderr[:200]}')
        else:
            # Try to read some data
            ready, _, _ = select.select([proc.stdout], [], [], 1.0)
            if ready:
                data = proc.stdout.read(65536)
                has_jpeg = b'\xff\xd8' in data and b'\xff\xd9' in data
                test('MJPEG stdout stream works', has_jpeg,
                     f'Read {len(data)} bytes, JPEG SOI/EOI found: {has_jpeg}')
            else:
                test('MJPEG stdout stream works', False, 'No data on stdout within 1 s')

        proc.terminate()
        proc.wait(timeout=3)
    except Exception as e:
        test('MJPEG stdout stream works', False, str(e))
else:
    test('MJPEG stdout stream works', False, 'rpicam-vid not found — skipped')


# ══════════════════════════════════════════════════════════════════
# TEST 5 — Port 8080 available
# ══════════════════════════════════════════════════════════════════
section('TEST 5 — Network Port')

def port_in_use(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.5)
        return s.connect_ex(('127.0.0.1', port)) == 0

port_used = port_in_use(8080)
test('Port 8080 is available (not already in use)', not port_used,
     'Something is already on port 8080 — kill it with: sudo fuser -k 8080/tcp' if port_used else 'Port 8080 free')

# Show Pi IP
code, ip_out = run(['hostname', '-I'])
local_ip = ip_out.strip().split()[0] if ip_out.strip() else 'unknown'
print(f'\n  {INFO}  Pi IP address: {local_ip}')
print(f'  {INFO}  Stream URL will be: http://{local_ip}:8080/stream')


# ══════════════════════════════════════════════════════════════════
# TEST 6 — pi_camera_server.py present
# ══════════════════════════════════════════════════════════════════
section('TEST 6 — Server Script')

script_paths = [
    os.path.expanduser('~/visionpath/pi_camera_server.py'),
    os.path.expanduser('~/pi_camera_server.py'),
    './pi_camera_server.py',
]
found_script = next((p for p in script_paths if os.path.exists(p)), None)
test('pi_camera_server.py found', bool(found_script),
     found_script or f'Not found in: {", ".join(script_paths)}')


# ══════════════════════════════════════════════════════════════════
# TEST 7 — User in video group
# ══════════════════════════════════════════════════════════════════
section('TEST 7 — Permissions')

import grp, pwd
try:
    user = os.environ.get('USER', os.popen('whoami').read().strip())
    groups = [g.gr_name for g in grp.getgrall() if user in g.gr_mem]
    in_video   = 'video'   in groups
    in_dialout = 'dialout' in groups
    test(f'User "{user}" in video group',   in_video,
         f'Fix: sudo usermod -a -G video {user} && newgrp video')
    test(f'User "{user}" in dialout group', in_dialout,
         f'Fix: sudo usermod -a -G dialout {user}')
except Exception as e:
    print(f'  {WARN}  Could not check groups: {e}')


# ══════════════════════════════════════════════════════════════════
# SUMMARY
# ══════════════════════════════════════════════════════════════════
section('SUMMARY')
passed = sum(1 for _, ok, _ in results if ok)
total  = len(results)
print(f'\n  Results: {passed}/{total} passed\n')

for name, ok, detail in results:
    tag = '✓' if ok else '✗'
    print(f'  [{tag}] {name}')

# ── Next steps ────────────────────────────────────────────────────
print('\n' + '═'*60)
if all(ok for _, ok, _ in results):
    print('''
  ✓ ALL TESTS PASSED

  Start the camera server:
    python3 ~/visionpath/pi_camera_server.py

  Test from Windows (PowerShell):
    Test-NetConnection 10.89.89.85 -Port 8080
    curl http://10.89.89.85:8080/health

  Stream URL for VISIONPATH:
    http://10.89.89.85:8080/stream
''')
else:
    print('\n  FAILED TESTS need fixing before camera will work.\n')
    if not shutil.which('rpicam-hello') and not shutil.which('libcamera-hello'):
        print('  → Run: sudo apt install -y rpicam-apps')
    if not shutil.which('rpicam-vid') and not shutil.which('libcamera-vid'):
        print('  → Run: sudo apt install -y rpicam-apps')
print('═'*60)
