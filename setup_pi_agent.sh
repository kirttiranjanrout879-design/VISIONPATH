#!/bin/bash
# ═════════════════════════════════════════════════════════════════
# VISIONPATH — Raspberry Pi 4B Agent Setup Script
# Target OS: Raspberry Pi OS Trixie / Bookworm (64-bit)
# Hardware:  Pixhack 2.4.8 on /dev/ttyS0, OV5647 CSI Camera
# ═════════════════════════════════════════════════════════════════
set -e

echo "=================================================================="
echo "  VISIONPATH — Raspberry Pi 4B Complete Setup"
echo "  User: $USER  |  OS: $(cat /etc/os-release | grep PRETTY_NAME | cut -d'"' -f2)"
echo "=================================================================="

echo ""
echo "[1/7] Updating package index..."
sudo apt-get update -y

echo ""
echo "[2/7] Installing required packages..."
sudo apt-get install -y \
    rpicam-apps \
    python3-pip \
    python3-serial \
    python3-setuptools \
    python3-websockets \
    libcamera-apps \
    git

echo ""
echo "[3/7] Installing Python MAVLink & WebSocket libraries..."
pip3 install pymavlink websockets --break-system-packages 2>/dev/null || \
pip3 install pymavlink websockets || \
pip3 install --user pymavlink websockets

echo ""
echo "[4/7] Configuring UART for Pixhack (/dev/ttyS0)..."

# Enable hardware UART (ttyS0) via raspi-config
if command -v raspi-config &>/dev/null; then
    # Enable serial hardware, disable serial console (so /dev/ttyS0 is free for MAVLink)
    sudo raspi-config nonint do_serial_hw 0      # Enable UART hardware
    sudo raspi-config nonint do_serial_cons 1    # Disable serial console
    echo "✓ UART hardware enabled, serial console disabled"
else
    echo "⚠ raspi-config not found — manually ensure UART is enabled in /boot/config.txt"
fi

# Disable getty on ttyS0 to prevent conflict with MAVLink
sudo systemctl disable serial-getty@ttyS0.service 2>/dev/null || true
sudo systemctl stop    serial-getty@ttyS0.service 2>/dev/null || true
echo "✓ Serial getty service disabled on ttyS0"

echo ""
echo "[5/7] Setting group permissions..."

# dialout group = UART/serial access
sudo usermod -a -G dialout $USER
sudo usermod -a -G video   $USER  # Camera access

# Set permissions on serial device
if [ -e /dev/ttyS0 ]; then
    sudo chmod 666 /dev/ttyS0
    echo "✓ /dev/ttyS0 permissions set (rw for all)"
fi

echo ""
echo "[6/7] Enabling camera in boot config..."
BOOT_CONFIG="/boot/firmware/config.txt"
[ -f "$BOOT_CONFIG" ] || BOOT_CONFIG="/boot/config.txt"

# Ensure camera_auto_detect is enabled
if grep -q "^camera_auto_detect=0" "$BOOT_CONFIG" 2>/dev/null; then
    sudo sed -i 's/^camera_auto_detect=0/camera_auto_detect=1/' "$BOOT_CONFIG"
    echo "✓ camera_auto_detect set to 1"
elif ! grep -q "^camera_auto_detect" "$BOOT_CONFIG" 2>/dev/null; then
    echo "camera_auto_detect=1" | sudo tee -a "$BOOT_CONFIG" > /dev/null
    echo "✓ camera_auto_detect=1 added to $BOOT_CONFIG"
else
    echo "✓ camera_auto_detect already enabled"
fi

# Make sure start_x=1 is NOT present (conflicts with libcamera on newer Pi OS)
sudo sed -i '/^start_x=/d' "$BOOT_CONFIG" 2>/dev/null || true

echo ""
echo "[7/7] Running hardware verification..."
python3 verify_pi_hardware.py || true

echo ""
echo "=================================================================="
echo "  ✓ Setup complete!"
echo ""
echo "  IMPORTANT: A REBOOT is required for UART and camera changes"
echo "  to take effect. Run:"
echo "    sudo reboot"
echo ""
echo "  After reboot, start the Pi Agent with:"
echo "    python3 pi_agent.py --serial /dev/ttyS0 --baud 57600"
echo ""
echo "  The agent will be accessible at:"
echo "    Camera Stream : http://$(hostname -I | awk '{print $1}'):8080/stream"
echo "    Telemetry WS  : ws://$(hostname -I | awk '{print $1}'):8081"
echo "  Health Check  : http://$(hostname -I | awk '{print $1}'):8080/health"
echo "=================================================================="
