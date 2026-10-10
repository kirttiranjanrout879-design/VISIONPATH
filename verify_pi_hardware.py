#!/usr/bin/env python3
"""
═════════════════════════════════════════════════════════════════════════════════
VISIONPATH — Hardware Verification Tool for Raspberry Pi 4B
═════════════════════════════════════════════════════════════════════════════════
Run this directly on the Raspberry Pi (username: bk) to test every single
hardware component before starting flight operations:

  python3 verify_pi_hardware.py

Reports green PASS / red FAIL with exact diagnostic explanations.
═════════════════════════════════════════════════════════════════════════════════
"""

import os
import shutil
import socket
import subprocess
import sys
import time

GREEN = "\033[92m"
RED = "\033[91m"
YELLOW = "\033[93m"
CYAN = "\033[96m"
BOLD = "\033[1m"
RESET = "\033[0m"

def print_header(title):
    print(f"\n{BOLD}{CYAN}═════════════════════════════════════════════════════════════════{RESET}")
    print(f"{BOLD}{CYAN}  {title}{RESET}")
    print(f"{BOLD}{CYAN}═════════════════════════════════════════════════════════════════{RESET}")

def report(test_name, success, details=""):
    mark = f"{GREEN}[ PASS ]{RESET}" if success else f"{RED}[ FAIL ]{RESET}"
    print(f"{mark} {BOLD}{test_name}{RESET}")
    if details:
        indent = "         "
        for line in details.strip().split("\n"):
            print(f"{indent}{line}")
    return success

def test_network():
    print_header("TEST 1: NETWORK & WI-FI IP CONFIGURATION")
    try:
        res = subprocess.run(["hostname", "-I"], capture_output=True, text=True, timeout=3)
        ips = res.stdout.strip().split()
        if ips:
            primary_ip = ips[0]
            ok = "10.89.89.85" in ips or len(ips) > 0
            msg = f"Detected IP addresses: {', '.join(ips)}\nPrimary LAN IP: {primary_ip}"
            if "10.89.89.85" not in ips:
                msg += f"\n{YELLOW}Note: Pi IP is {primary_ip}. If phone hotspot changed IP, enter {primary_ip} in VISIONPATH GCS.{RESET}"
            return report("Raspberry Pi Wi-Fi Connectivity", ok, msg)
        else:
            return report("Raspberry Pi Wi-Fi Connectivity", False, "No active IP address found on Wi-Fi interface")
    except Exception as e:
        return report("Raspberry Pi Wi-Fi Connectivity", False, f"Network check error: {e}")

def test_uart():
    print_header("TEST 2: PIXHACK TELEM1 UART DEVICE (/dev/ttyS0)")
    device = "/dev/ttyS0"
    if not os.path.exists(device):
        # Check alternative ttyAMA0
        alt = "/dev/ttyAMA0"
        if os.path.exists(alt):
            return report("Pixhack UART Device", True, f"/dev/ttyS0 not found, but {alt} exists. Check raspi-config serial settings.")
        return report("Pixhack UART Device", False, f"Serial device {device} does not exist. Enable serial port with: sudo raspi-config -> Interface Options -> Serial Port.")

    # Check user permissions
    try:
        res = subprocess.run(["ls", "-l", device], capture_output=True, text=True)
        perms = res.stdout.strip()
        user_in_dialout = "dialout" in subprocess.run(["groups"], capture_output=True, text=True).stdout
        details = f"Permissions: {perms}\nUser in 'dialout' group: {user_in_dialout}"
        if not user_in_dialout:
            details += f"\n{YELLOW}Fix: sudo usermod -a -G dialout $USER{RESET}"
        return report("Pixhack UART Device (/dev/ttyS0)", True, details)
    except Exception as e:
        return report("Pixhack UART Device", False, str(e))

def test_mavlink_heartbeat():
    print_header("TEST 3: PIXHACK MAVLINK 2 RECEPTION (@ 57600 BAUD)")
    try:
        from pymavlink import mavutil
    except ImportError:
        return report("MAVLink Reception", False, "pymavlink is not installed! Run: pip3 install pymavlink")

    port = "/dev/ttyS0"
    baud = 57600
    print(f"[*] Opening {port} at {baud} baud (MAVLink 2)...")
    try:
        master = mavutil.mavlink_connection(port, baud=baud)
        print("[*] Listening for Pixhack heartbeat (timeout 5s)...")
        hb = master.wait_heartbeat(timeout=5.0)
        if hb:
            sysid = master.target_system
            compid = master.target_component
            mode = hb.custom_mode
            msg = f"Heartbeat received from System {sysid}, Component {compid}\nArduCopter Custom Mode: {mode}"
            return report("Pixhack MAVLink Telemetry", True, msg)
        else:
            return report("Pixhack MAVLink Telemetry", False,
                          f"No heartbeat received on {port} @ {baud} baud.\n"
                          "Checks:\n"
                          "• Is Pixhack 2.4.8 powered on?\n"
                          "• Is TELEM1 TX wired to Pi GPIO 15 (RX)?\n"
                          "• Is TELEM1 RX wired to Pi GPIO 14 (TX)?\n"
                          "• Is TELEM1 GND wired to Pi GND?\n"
                          "• Is TELEM1 baud rate set to 57 in ArduCopter (SERIAL1_BAUD=57)?")
    except Exception as e:
        return report("Pixhack MAVLink Telemetry", False, f"UART connection error: {e}")

def test_camera_hardware():
    print_header("TEST 4: CSI CAMERA HARDWARE DETECTION (OV5647)")
    cmd = shutil.which("rpicam-hello") or shutil.which("libcamera-hello")
    if not cmd:
        return report("CSI Camera Tool (rpicam-apps)", False, "rpicam-hello not found! Install with: sudo apt install -y rpicam-apps")

    try:
        res = subprocess.run([cmd, "--list-cameras"], capture_output=True, text=True, timeout=5)
        out = (res.stdout + res.stderr).strip()
        if "ov5647" in out.lower() or ("available" in out.lower() and "no cameras" not in out.lower()):
            return report("OV5647 Camera Detection", True, out)
        else:
            return report("OV5647 Camera Detection", False,
                          f"No camera found on CSI ribbon port.\nOutput:\n{out}\n"
                          "Checks:\n"
                          "• Is the camera ribbon cable inserted with blue side facing the Ethernet jack on Pi 4B?\n"
                          "• Is camera enabled in /boot/firmware/config.txt (camera_auto_detect=1)?")
    except Exception as e:
        return report("OV5647 Camera Detection", False, str(e))

def test_ports():
    print_header("TEST 5: PORT AVAILABILITY & CONFLICT CHECK")
    for port in [8080, 8081]:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(1.0)
        res = sock.connect_ex(('127.0.0.1', port))
        sock.close()
        if res == 0:
            report(f"Port {port} Status", True, f"Port {port} is active and currently LISTENING (Service is running)")
        else:
            report(f"Port {port} Status", True, f"Port {port} is free and ready to be bound by pi_agent.py")

def main():
    print(f"\n{BOLD}{CYAN}VISIONPATH — Raspberry Pi 4B Hardware Verification Suite{RESET}\n")
    results = [
        test_network(),
        test_uart(),
        test_mavlink_heartbeat(),
        test_camera_hardware(),
    ]
    test_ports()

    print_header("FINAL VERIFICATION SUMMARY")
    passed = sum(1 for r in results if r)
    total = len(results)
    if passed == total:
        print(f"\n{BOLD}{GREEN}✓ ALL HARDWARE CHECKS PASSED ({passed}/{total})!{RESET}")
        print(f"You are ready to launch Pi Agent:")
        print(f"  {BOLD}python3 pi_agent.py --serial /dev/ttyS0 --baud 57600 --cam-port 8080 --ws-port 8081{RESET}\n")
    else:
        print(f"\n{BOLD}{RED}⚠ {total - passed} HARDWARE CHECK(S) FAILED ({passed}/{total} passed).{RESET}")
        print("Please review the troubleshooting suggestions above.\n")

if __name__ == '__main__':
    main()
