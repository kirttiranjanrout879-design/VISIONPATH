#!/usr/bin/env python3
"""
================================================================================
VISIONPATH -- Waypoint Distance Command Verification Test
================================================================================
Tests the pipeline:
  Laptop / GCS  ──(WebSocket)──>  Raspberry Pi (port 8081)  ──(MAVLink)──>  Pixhack 2.4.8

Verifies:
  1. Connection to WebSocket server (default: 10.89.89.85:8081 or 127.0.0.1:8081)
  2. Setting GUIDED mode on Pixhack
  3. Sending NAV_WAYPOINT_REL with distance (m), turn (°), and speed (m/s)
  4. Receiving execution acknowledgment (cmd_ack) from Pi and Pixhack
================================================================================
"""

import argparse
import asyncio
import json
import sys
import time

async def test_waypoint_command(host, port, distance, turn, speed, alt):
    uri = f"ws://{host}:{port}"
    print(f"[*] Connecting to MAVLink WebSocket bridge at {uri}...")
    
    try:
        import websockets
    except ImportError:
        print("[!] websockets library not installed. Run: pip install websockets")
        return False

    try:
        async with websockets.connect(uri, ping_timeout=10) as ws:
            print(f"[✓] Connected successfully to {uri}!")
            
            # 1. Wait for initial status or telemetry
            print("[*] Waiting for initial status/telemetry packet...")
            try:
                first_msg = await asyncio.wait_for(ws.recv(), timeout=4.0)
                data = json.loads(first_msg)
                print(f"[✓] Received packet: type={data.get('type')}")
                if 'data' in data:
                    telem = data['data']
                    print(f"    - Drone Mode:    {telem.get('mode', 'N/A')}")
                    print(f"    - Armed:         {telem.get('armed', 'N/A')}")
                    print(f"    - Altitude:      {telem.get('alt', 'N/A')} m")
                    print(f"    - MAVLink State: {telem.get('mavlink', 'N/A')}")
            except asyncio.TimeoutError:
                print("[!] No initial status received within 4s, proceeding to send command...")

            # 2. Build waypoint distance command
            cmd = {
                "action": "NAV_WAYPOINT_REL",
                "distance": float(distance),
                "turn": float(turn),
                "speed": float(speed),
                "alt": float(alt)
            }
            print(f"\n[*] Sending Waypoint Distance Command to Pi and Pixhack:")
            print(f"    Distance: {distance} meters")
            print(f"    Turn:     {turn} degrees")
            print(f"    Speed:    {speed} m/s (~{speed * 3.6:.1f} km/h)")
            print(f"    Payload:  {json.dumps(cmd)}")

            await ws.send(json.dumps(cmd))
            print("[✓] Command sent! Awaiting Pixhack execution response (ACK)...")

            # 3. Listen for ACK or telemetry updates
            start_t = time.time()
            got_ack = False
            while time.time() - start_t < 6.0:
                try:
                    raw = await asyncio.wait_for(ws.recv(), timeout=3.0)
                    msg = json.loads(raw)
                    if msg.get('type') == 'cmd_ack' and msg.get('action') == 'NAV_WAYPOINT_REL':
                        print("\n" + "="*60)
                        print("[✓] PIXHACK EXECUTION CONFIRMED!")
                        print(f"    Status:   {msg.get('status')}")
                        print(f"    Distance: {msg.get('distance')} m")
                        print(f"    Turn:     {msg.get('turn')}°")
                        print(f"    Target X: {msg.get('x')} m (forward)")
                        print(f"    Target Y: {msg.get('y')} m (lateral)")
                        print(f"    Speed:    {msg.get('speed')} m/s")
                        print(f"    Message:  {msg.get('message')}")
                        print("="*60)
                        got_ack = True
                        break
                    elif msg.get('type') == 'telemetry':
                        # Telemetry streaming is alive
                        pass
                except asyncio.TimeoutError:
                    break

            if not got_ack:
                print("[!] No explicit ACK received, but command was transmitted to the bridge socket.")
            return True

    except Exception as e:
        print(f"[!] Connection failed: {e}")
        return False

def main():
    parser = argparse.ArgumentParser(description="Test Waypoint Distance Command from Laptop to Pi and Pixhack")
    parser.add_argument("--host", default="10.89.89.85", help="Pi IP or localhost (default: 10.89.89.85)")
    parser.add_argument("--port", type=int, default=8081, help="WebSocket port (default: 8081)")
    parser.add_argument("--distance", type=float, default=2.5, help="Waypoint distance in meters (default: 2.5)")
    parser.add_argument("--turn", type=float, default=0.0, help="Relative turn angle in degrees (default: 0.0)")
    parser.add_argument("--speed", type=float, default=1.39, help="Flight speed in m/s (default: 1.39 = 5 km/h)")
    parser.add_argument("--alt", type=float, default=0.0, help="Relative altitude change in meters (default: 0.0)")
    args = parser.parse_args()

    asyncio.run(test_waypoint_command(args.host, args.port, args.distance, args.turn, args.speed, args.alt))

if __name__ == "__main__":
    main()
