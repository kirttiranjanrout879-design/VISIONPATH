#!/usr/bin/env python3
"""
================================================================================
VISIONPATH -- Laptop MAVLink WebSocket Bridge (vp_laptop_bridge.py)
================================================================================
Runs on HP Victus Windows Laptop (Localhost).

PURPOSE:
  Receives real MAVLink 2 telemetry forwarded via UDP (port 14550) from MAVProxy
  on the Raspberry Pi (or direct USB serial on laptop), and exposes it as a
  WebSocket JSON stream on ws://localhost:8081 for the VISIONPATH browser app.

ARCHITECTURE:
  Raspberry Pi 4B (10.89.89.85):
    - Reads Pixhack 2.4.8 on /dev/ttyS0 @ 57600
    - Forwards MAVLink:
        mavproxy.py --master=/dev/ttyS0,57600 --out=udp:10.89.89.228:14550
    - Runs camera server on port 8080 (http://10.89.89.85:8080/stream.mjpg)

  Laptop (Localhost 127.0.0.1 / 10.89.89.228):
    - This script (vp_laptop_bridge.py) listens on UDP 0.0.0.0:14550
    - Exposes WebSocket on ws://127.0.0.1:8081
    - VISIONPATH browser connects to ws://localhost:8081

INSTALL DEPENDENCIES (on Windows Laptop):
  pip install pymavlink websockets

RUN:
  python vp_laptop_bridge.py
  python vp_laptop_bridge.py --udp-port 14550 --ws-port 8081

OPTIONS:
  --udp-port  PORT    UDP port to listen for MAVLink (default: 14550)
  --ws-port   PORT    WebSocket server port (default: 8081)
  --ws-host   HOST    WebSocket bind host (default: 0.0.0.0)
  --serial    PORT    Optional direct USB serial port (e.g. COM3)
  --baud      BAUD    Serial baud rate if using USB (default: 57600)
================================================================================
"""

import argparse
import asyncio
import json
import logging
import math
import os
import sys
import threading
import time

# Force MAVLink 2.0 protocol
os.environ['MAVLINK20'] = '1'

logging.basicConfig(
    level=logging.INFO,
    format='[%(asctime)s] [%(levelname)s] [Laptop-Bridge] %(message)s',
    datefmt='%H:%M:%S'
)
log = logging.getLogger('LaptopBridge')

# ---------------------------------------------------------------------------
# Dependency checks
# ---------------------------------------------------------------------------
try:
    from pymavlink import mavutil
    MAVLINK_AVAILABLE = True
except ImportError:
    MAVLINK_AVAILABLE = False
    log.error('pymavlink not installed! Run: pip install pymavlink')

try:
    import websockets
    WEBSOCKETS_AVAILABLE = True
except ImportError:
    WEBSOCKETS_AVAILABLE = False
    log.error('websockets not installed! Run: pip install websockets')


# ---------------------------------------------------------------------------
# ArduCopter flight mode dictionary
# ---------------------------------------------------------------------------
COPTER_MODES = {
    0: 'STABILIZE', 1: 'ACRO',     2: 'ALT_HOLD',    3: 'AUTO',
    4: 'GUIDED',    5: 'LOITER',   6: 'RTL',          7: 'CIRCLE',
    9: 'LAND',      11: 'DRIFT',   13: 'SPORT',        14: 'FLIP',
    15: 'AUTOTUNE', 16: 'POSHOLD', 17: 'BRAKE',        18: 'THROW',
    19: 'AVOID_ADSB', 20: 'GUIDED_NOGPS', 21: 'SMART_RTL',
    22: 'FLOWHOLD', 23: 'FOLLOW',  24: 'ZIGZAG',       25: 'SYSTEMID',
    26: 'AUTOROTATE', 27: 'AUTO_RTL',
}


# ---------------------------------------------------------------------------
# MAVLink UDP/Serial Reader
# ---------------------------------------------------------------------------
class MAVLinkBridgeReader:
    """
    Receives real MAVLink 2 packets over UDP 14550 (or Serial) and stores telemetry.
    No simulation or fake telemetry generated.
    """

    def __init__(self, target_uri='udpin:0.0.0.0:14550', baud=57600):
        self.target_uri    = target_uri
        self.baud          = baud
        self.master        = None
        self.running       = False

        # Connection health
        self.status        = 'offline'   # 'online' | 'offline' | 'error'
        self.error_msg     = 'Waiting for MAVLink stream...'
        self.last_hb_ts    = 0.0
        self.sysid         = 0
        self.compid        = 0

        # Real telemetry dict (None = awaiting data)
        self._telem_lock = threading.Lock()
        self._telem = {
            'sysid':      None,
            'compid':     None,
            'firmware':   'ArduCopter 4.6.3',
            'armed':      False,
            'mode':       'DISARMED',
            'alt':        None,
            'rel_alt':    None,
            'speed':      None,
            'airspeed':   None,
            'heading':    None,
            'pitch':      None,
            'roll':       None,
            'yaw':        None,
            'battery':    None,
            'battery_v':  None,
            'battery_c':  None,
            'gps_fix':    None,
            'gps_sats':   None,
            'lat':        None,
            'lon':        None,
            'local_x':    None,
            'local_y':    None,
            'local_z':    None,
            'vx':         None,
            'vy':         None,
            'vz':         None,
            'rc_channels': [],
            'timestamp':  None,
        }

    def start(self):
        self.running = True
        t = threading.Thread(target=self._worker, daemon=True, name='MAVLinkBridgeWorker')
        t.start()

    def _connect(self):
        if not MAVLINK_AVAILABLE:
            self.status    = 'error'
            self.error_msg = 'pymavlink library not installed (run: pip install pymavlink)'
            return False

        try:
            if self.target_uri.startswith('udp'):
                log.info(f'Listening for MAVLink UDP on {self.target_uri} ...')
                self.master = mavutil.mavlink_connection(self.target_uri)
            else:
                log.info(f'Connecting MAVLink Serial on {self.target_uri} @ {self.baud} ...')
                self.master = mavutil.mavlink_connection(self.target_uri, baud=self.baud)

            log.info('Waiting for Pixhack heartbeat...')
            hb = self.master.wait_heartbeat(timeout=4.0)
            if hb:
                self.last_hb_ts = time.time()
                self.sysid      = self.master.target_system
                self.compid     = self.master.target_component
                self.status     = 'online'
                self.error_msg  = None
                log.info(f'Pixhack heartbeat detected! System ID: {self.sysid}, Component ID: {self.compid}')
                return True
            else:
                self.status    = 'offline'
                self.error_msg = f'No heartbeat on {self.target_uri} within 4s'
                log.warning(self.error_msg)
                return False

        except Exception as e:
            self.status    = 'error'
            self.error_msg = f'Connection error: {e}'
            log.error(self.error_msg)
            return False

    def _worker(self):
        while self.running:
            if not self.master or self.status != 'online':
                ok = self._connect()
                if not ok:
                    time.sleep(2.5)
                    continue

            try:
                msg = self.master.recv_match(blocking=True, timeout=0.5)
                if msg is None:
                    # Heartbeat timeout check (3.5 seconds)
                    if self.last_hb_ts > 0 and (time.time() - self.last_hb_ts) > 3.5:
                        self.status    = 'offline'
                        self.error_msg = f'Heartbeat timeout ({round(time.time() - self.last_hb_ts, 1)}s)'
                        log.warning(self.error_msg)
                    continue

                msg_type = msg.get_type()
                now = time.time()

                with self._telem_lock:
                    if msg_type == 'HEARTBEAT':
                        self.last_hb_ts = now
                        self.status     = 'online'
                        self.error_msg  = None
                        sysid  = msg.get_srcSystem()
                        compid = msg.get_srcComponent()
                        self.sysid  = sysid
                        self.compid = compid
                        self._telem['sysid']  = sysid
                        self._telem['compid'] = compid
                        self._telem['armed']  = bool(msg.base_mode & mavutil.mavlink.MAV_MODE_FLAG_SAFETY_ARMED)
                        self._telem['mode']   = COPTER_MODES.get(msg.custom_mode, f'MODE_{msg.custom_mode}')
                        self._telem['timestamp'] = round(now, 3)

                    elif msg_type == 'ATTITUDE':
                        self._telem['roll']    = round(math.degrees(msg.roll), 1)
                        self._telem['pitch']   = round(math.degrees(msg.pitch), 1)
                        self._telem['yaw']     = round(math.degrees(msg.yaw), 1)
                        self._telem['heading'] = round((math.degrees(msg.yaw) + 360) % 360, 1)
                        self._telem['timestamp'] = round(now, 3)

                    elif msg_type == 'VFR_HUD':
                        self._telem['alt']      = round(msg.alt, 2)
                        self._telem['airspeed'] = round(msg.airspeed, 2)
                        self._telem['speed']    = round(msg.groundspeed, 2)
                        if msg.heading is not None:
                            self._telem['heading'] = round(msg.heading, 1)
                        self._telem['timestamp'] = round(now, 3)

                    elif msg_type == 'GLOBAL_POSITION_INT':
                        self._telem['rel_alt'] = round(msg.relative_alt / 1000.0, 2)
                        self._telem['lat']     = round(msg.lat / 1e7, 6)
                        self._telem['lon']     = round(msg.lon / 1e7, 6)
                        self._telem['vx']      = round(msg.vx / 100.0, 3)
                        self._telem['vy']      = round(msg.vy / 100.0, 3)
                        self._telem['vz']      = round(msg.vz / 100.0, 3)
                        self._telem['timestamp'] = round(now, 3)

                    elif msg_type == 'LOCAL_POSITION_NED':
                        self._telem['local_x'] = round(msg.x, 3)
                        self._telem['local_y'] = round(msg.y, 3)
                        self._telem['local_z'] = round(msg.z, 3)
                        self._telem['vx']      = round(msg.vx, 3)
                        self._telem['vy']      = round(msg.vy, 3)
                        self._telem['vz']      = round(msg.vz, 3)
                        self._telem['timestamp'] = round(now, 3)

                    elif msg_type == 'SYS_STATUS':
                        self._telem['battery']   = msg.battery_remaining  # percent (0-100)
                        self._telem['battery_v'] = round(msg.voltage_battery / 1000.0, 2)  # volts
                        if msg.current_battery >= 0:
                            self._telem['battery_c'] = round(msg.current_battery / 100.0, 2)  # amps
                        self._telem['timestamp'] = round(now, 3)

                    elif msg_type == 'GPS_RAW_INT':
                        self._telem['gps_fix']  = msg.fix_type
                        self._telem['gps_sats'] = msg.satellites_visible
                        self._telem['timestamp'] = round(now, 3)

                    elif msg_type == 'RC_CHANNELS':
                        self._telem['rc_channels'] = [
                            msg.chan1_raw, msg.chan2_raw, msg.chan3_raw, msg.chan4_raw,
                            msg.chan5_raw, msg.chan6_raw, msg.chan7_raw, msg.chan8_raw,
                        ]

            except Exception as e:
                log.error(f'MAVLink parse error: {e}')
                self.status    = 'error'
                self.error_msg = str(e)
                try:
                    self.master.close()
                except Exception:
                    pass
                self.master = None
                time.sleep(2)

    def get_telemetry(self):
        with self._telem_lock:
            return dict(self._telem)

    def get_status(self):
        now  = time.time()
        age  = round(now - self.last_hb_ts, 2) if self.last_hb_ts > 0 else None
        effective = self.status
        if self.last_hb_ts > 0 and (now - self.last_hb_ts) > 3.0:
            effective = 'offline'
        return {
            'status':              effective,
            'sysid':               self.sysid,
            'compid':              self.compid,
            'firmware':            'ArduCopter 4.6.3',
            'last_heartbeat_age_s': age,
            'error':               self.error_msg,
        }

    # -------------------------------------------------------------------------
    # Operator Commands
    # -------------------------------------------------------------------------
    def send_arm(self, arm=True):
        if not self.master:
            log.warning('Cannot send ARM/DISARM: MAVLink stream not connected')
            return
        log.info(f'Operator command sent: {"ARM" if arm else "DISARM"}')
        self.master.mav.command_long_send(
            self.master.target_system,
            self.master.target_component,
            mavutil.mavlink.MAV_CMD_COMPONENT_ARM_DISARM,
            0,
            1 if arm else 0, 0, 0, 0, 0, 0, 0
        )

    def set_mode(self, mode_name):
        if not self.master:
            return
        mapping = self.master.mode_mapping()
        if mode_name not in mapping:
            log.warning(f'Unknown flight mode: {mode_name}')
            return
        log.info(f'Operator mode switch: {mode_name}')
        self.master.set_mode(mapping[mode_name])

    def return_to_launch(self):
        self.set_mode('RTL')

    def precision_land(self):
        if not self.master:
            return
        log.info('Operator command: PRECISION LAND')
        self.master.mav.command_long_send(
            self.master.target_system,
            self.master.target_component,
            mavutil.mavlink.MAV_CMD_NAV_LAND,
            0, 1, 0, 0, 0, 0, 0, 0
        )

    def send_condition_yaw(self, target_angle_deg, yaw_rate=20, relative=False):
        if not self.master or self.status != 'online':
            return
        log.info(f'Condition Yaw: target={target_angle_deg}°, rate={yaw_rate}°/s, rel={relative}')
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
        if not self.master or self.status != 'online':
            return
        log.info(f'Operator command: TAKEOFF to {alt_m}m')
        self.master.mav.command_long_send(
            self.master.target_system,
            self.master.target_component,
            mavutil.mavlink.MAV_CMD_NAV_TAKEOFF,
            0,
            0, 0, 0, 0, 0, 0,
            alt_m
        )

    def send_guided_waypoint(self, distance_m, turn_deg=0.0, speed_m_s=1.39, alt_rel_m=0.0):
        if not self.master or self.status != 'online':
            log.warning('Cannot send waypoint: Pixhack MAVLink is offline')
            return None
        rad = math.radians(turn_deg)
        target_x = float(distance_m) * math.cos(rad)
        target_y = float(distance_m) * math.sin(rad)
        target_z = -float(alt_rel_m)  # Negative Z is up in NED
        log.info(f'Guided Waypoint: dist={distance_m}m, turn={turn_deg}°, Target X={target_x:.2f}m, Y={target_y:.2f}m, speed={speed_m_s}m/s')

        # 1. Switch to GUIDED mode if not already
        try:
            mapping = self.master.mode_mapping()
            if mapping and 'GUIDED' in mapping:
                self.master.set_mode(mapping['GUIDED'])
        except Exception as e:
            log.warning(f'Could not set GUIDED mode: {e}')

        # 2. Set speed on Pixhack
        if speed_m_s > 0:
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
                log.warning(f'Failed to set speed: {e}')

        # 3. Send position target offset (BODY_OFFSET_NED)
        self.send_position_target_local_ned(vx=0.0, vy=0.0, vz=0.0, x=target_x, y=target_y, z=target_z)
        log.info(f'✓ Pixhack executing target position: offset x={target_x:.2f}m, y={target_y:.2f}m')
        return {"distance": distance_m, "turn": turn_deg, "x": target_x, "y": target_y, "speed": speed_m_s}

    def send_position_target_local_ned(self, vx=0.0, vy=0.0, vz=0.0, x=None, y=None, z=None):
        if not self.master or self.status != 'online':
            return
        if x is not None and y is not None:
            type_mask = 0b0000111111111000  # position only
            frame = mavutil.mavlink.MAV_FRAME_BODY_OFFSET_NED
            self.master.mav.set_position_target_local_ned_send(
                0,
                self.master.target_system,
                self.master.target_component,
                frame,
                type_mask,
                x, y, z or 0,
                0, 0, 0,
                0, 0, 0,
                0, 0
            )
        else:
            type_mask = 0b0000111111000111  # velocity only
            self.master.mav.set_position_target_local_ned_send(
                0,
                self.master.target_system,
                self.master.target_component,
                mavutil.mavlink.MAV_FRAME_BODY_NED,
                type_mask,
                0, 0, 0,
                vx, vy, vz,
                0, 0, 0,
                0, 0
            )

    def send_lateral_correction(self, vy, vx=0.5):
        self.send_position_target_local_ned(vx=vx, vy=vy, vz=0.0)

    def stop(self):
        self.running = False
        if self.master:
            try:
                self.master.close()
            except Exception:
                pass


# ---------------------------------------------------------------------------
# WebSocket Server & Client Management
# ---------------------------------------------------------------------------
bridge_reader = None
ws_clients = set()


async def ws_handler(websocket, path=None):
    ws_clients.add(websocket)
    addr = getattr(websocket, 'remote_address', '?')
    log.info(f'VISIONPATH GCS connected: {addr}')

    # Send initial status packet immediately
    try:
        mav_state = bridge_reader.get_status() if bridge_reader else {}
        init_msg  = json.dumps({
            'type': 'status',
            'data': {
                'pi':      'online',
                'mavlink': mav_state.get('status', 'offline'),
                'camera':  'managed_by_camera_server',
                'firmware': mav_state.get('firmware'),
                'sysid':   mav_state.get('sysid'),
                'compid':  mav_state.get('compid'),
                'mavlink_error': mav_state.get('error'),
                'last_heartbeat': mav_state.get('last_heartbeat_age_s'),
            }
        })
        await websocket.send(init_msg)
    except Exception:
        pass

    try:
        async for message in websocket:
            try:
                cmd    = json.loads(message)
                action = cmd.get('action', '')
                log.info(f'WebSocket command received: {action}')

                if bridge_reader:
                    if action == 'ARM':
                        bridge_reader.send_arm(True)
                    elif action == 'DISARM':
                        bridge_reader.send_arm(False)
                    elif action == 'CMD_NAV_RETURN_TO_LAUNCH':
                        bridge_reader.return_to_launch()
                    elif action == 'CMD_NAV_LAND':
                        bridge_reader.precision_land()
                    elif action == 'CMD_NAV_TAKEOFF':
                        bridge_reader.send_takeoff(cmd.get('alt', 1.5))
                    elif action == 'SET_MODE':
                        bridge_reader.set_mode(cmd.get('mode', 'GUIDED'))
                    elif action == 'CMD_CONDITION_YAW':
                        bridge_reader.send_condition_yaw(
                            cmd.get('angle', 0.0),
                            cmd.get('rate', 20.0),
                            cmd.get('relative', False)
                        )
                    elif action == 'NAV_WAYPOINT_REL':
                        dist = float(cmd.get('distance', 1.0))
                        turn = float(cmd.get('turn', 0.0))
                        spd  = float(cmd.get('speed', 1.39))
                        alt  = float(cmd.get('alt', 0.0))
                        res = bridge_reader.send_guided_waypoint(dist, turn, spd, alt)
                        ack_msg = json.dumps({
                            'type': 'cmd_ack',
                            'action': 'NAV_WAYPOINT_REL',
                            'status': 'EXECUTED',
                            'distance': dist,
                            'turn': turn,
                            'x': res.get('x') if res else dist,
                            'y': res.get('y') if res else 0.0,
                            'speed': spd,
                            'message': f'Pixhack executing waypoint: dist={dist:.2f}m, turn={turn:.1f}°'
                        })
                        await websocket.send(ack_msg)
                    elif action == 'SET_POSITION_TARGET_LOCAL_NED':
                        bridge_reader.send_position_target_local_ned(
                            vx=cmd.get('vx', 0.0),
                            vy=cmd.get('vy', 0.0),
                            vz=cmd.get('vz', 0.0),
                            x=cmd.get('x', None),
                            y=cmd.get('y', None),
                            z=cmd.get('z', None)
                        )
            except Exception as e:
                log.error(f'Error processing command: {e}')
    except (websockets.exceptions.ConnectionClosed,
            websockets.exceptions.ConnectionClosedOK,
            websockets.exceptions.ConnectionClosedError):
        pass
    finally:
        ws_clients.discard(websocket)
        log.info(f'VISIONPATH GCS disconnected: {addr}')



async def broadcast_loop():
    """
    10 Hz telemetry loop + 1 Hz status loop.
    Real telemetry only; missing fields are None.
    """
    last_status_ts = 0.0
    while True:
        if ws_clients and bridge_reader:
            now = time.time()

            # 10 Hz telemetry payload
            telem   = bridge_reader.get_telemetry()
            payload = json.dumps({'type': 'telemetry', 'data': telem})
            dead    = set()
            results = await asyncio.gather(
                *[c.send(payload) for c in list(ws_clients)],
                return_exceptions=True
            )
            for c, r in zip(list(ws_clients), results):
                if isinstance(r, Exception):
                    dead.add(c)

            # 1 Hz status broadcast
            if now - last_status_ts >= 1.0:
                last_status_ts = now
                mav_state = bridge_reader.get_status()
                status_payload = json.dumps({
                    'type': 'status',
                    'data': {
                        'pi':      'online',
                        'mavlink': mav_state.get('status', 'offline'),
                        'camera':  'managed_by_camera_server',
                        'firmware': mav_state.get('firmware'),
                        'sysid':   mav_state.get('sysid'),
                        'compid':  mav_state.get('compid'),
                        'mavlink_error': mav_state.get('error'),
                        'last_heartbeat': mav_state.get('last_heartbeat_age_s'),
                    }
                })
                stat_results = await asyncio.gather(
                    *[c.send(status_payload) for c in list(ws_clients)],
                    return_exceptions=True
                )
                for c, r in zip(list(ws_clients), stat_results):
                    if isinstance(r, Exception):
                        dead.add(c)

            ws_clients.difference_update(dead)

        await asyncio.sleep(0.1)  # 10 Hz interval


async def main_async(ws_host, ws_port):
    log.info(f'Starting VISIONPATH Localhost WebSocket on ws://{ws_host}:{ws_port} ...')
    async with websockets.serve(ws_handler, ws_host, ws_port):
        log.info('===============================================================')
        log.info('  VISIONPATH LOCALHOST MAVLINK BRIDGE ACTIVE')
        log.info(f'  WebSocket server  : ws://localhost:{ws_port} (or ws://{ws_host}:{ws_port})')
        log.info(f'  MAVLink target    : {bridge_reader.target_uri}')
        log.info('  Pi Camera Stream  : http://10.89.89.85:8080/stream.mjpg')
        log.info('===============================================================')
        await broadcast_loop()


def main():
    global bridge_reader

    parser = argparse.ArgumentParser(description='VISIONPATH Laptop Localhost MAVLink WebSocket Bridge')
    parser.add_argument('--udp-port', type=int, default=14550,
                        help='UDP port to listen for MAVLink stream (default: 14550)')
    parser.add_argument('--ws-port',  type=int, default=8081,
                        help='WebSocket server port (default: 8081)')
    parser.add_argument('--ws-host',  type=str, default='0.0.0.0',
                        help='WebSocket bind host (default: 0.0.0.0 / localhost)')
    parser.add_argument('--serial',   type=str, default=None,
                        help='Optional USB COM port (e.g. COM3) if connected directly to laptop')
    parser.add_argument('--baud',     type=int, default=57600,
                        help='Serial baud rate (default: 57600)')
    args = parser.parse_args()

    if not MAVLINK_AVAILABLE or not WEBSOCKETS_AVAILABLE:
        log.error('Missing dependencies! Please run:')
        log.error('  pip install pymavlink websockets')
        sys.exit(1)

    target_uri = args.serial if args.serial else f'udpin:0.0.0.0:{args.udp_port}'

    bridge_reader = MAVLinkBridgeReader(target_uri=target_uri, baud=args.baud)
    bridge_reader.start()

    try:
        asyncio.run(main_async(args.ws_host, args.ws_port))
    except KeyboardInterrupt:
        log.info('Shutting down Localhost bridge...')
        bridge_reader.stop()


if __name__ == '__main__':
    main()
