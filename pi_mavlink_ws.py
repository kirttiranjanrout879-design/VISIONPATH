#!/usr/bin/env python3
"""
================================================================================
VISIONPATH -- Pi MAVLink WebSocket Bridge (pi_mavlink_ws.py)
================================================================================
Runs on Raspberry Pi 4B.

PURPOSE:
  Reads real MAVLink 2 telemetry from Pixhack 2.4.8 via UART,
  and exposes it as a WebSocket JSON stream to the VISIONPATH browser app.

DOES NOT:
  - Touch port 8080 (camera_server.py already owns that port)
  - Stream camera video (camera_server.py handles that via systemd)
  - Generate fake/simulated telemetry

HARDWARE:
  Pixhack 2.4.8 TELEM1  -->  Raspberry Pi /dev/ttyS0 @ 57600 baud (MAVLink 2)

NETWORK:
  WebSocket server       -->  ws://10.89.89.85:8081
  Camera MJPEG (existing)--> http://10.89.89.85:8080/stream.mjpg

INSTALL on Raspberry Pi:
  pip3 install pymavlink websockets

RUN:
  python3 pi_mavlink_ws.py
  python3 pi_mavlink_ws.py --serial /dev/ttyS0 --baud 57600 --ws-port 8081

SYSTEMD SERVICE (optional):
  sudo nano /etc/systemd/system/vp-mavlink.service
  [Unit]
  Description=VISIONPATH MAVLink WebSocket Bridge
  After=network.target
  [Service]
  ExecStart=/usr/bin/python3 /home/bk/visionpath/pi_mavlink_ws.py
  Restart=always
  User=bk
  [Install]
  WantedBy=multi-user.target

  sudo systemctl enable vp-mavlink
  sudo systemctl start vp-mavlink
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

# Force MAVLink 2 protocol
os.environ['MAVLINK20'] = '1'

logging.basicConfig(
    level=logging.INFO,
    format='[%(asctime)s] [%(levelname)s] [MAVLink-WS] %(message)s',
    datefmt='%H:%M:%S'
)
log = logging.getLogger('PiMAVLink')

# ---------------------------------------------------------------------------
# Dependency checks
# ---------------------------------------------------------------------------
try:
    from pymavlink import mavutil
    MAVLINK_AVAILABLE = True
except ImportError:
    MAVLINK_AVAILABLE = False
    log.error('pymavlink not installed!  Run: pip3 install pymavlink')

try:
    import websockets
    WEBSOCKETS_AVAILABLE = True
except ImportError:
    WEBSOCKETS_AVAILABLE = False
    log.error('websockets not installed!  Run: pip3 install websockets')


# ---------------------------------------------------------------------------
# ArduCopter mode table
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
# MAVLink reader (runs in background thread)
# ---------------------------------------------------------------------------
class PixhackReader:
    """
    Connects to Pixhack 2.4.8 over /dev/ttyS0 @ 57600 baud.
    Reads real MAVLink 2 messages and stores latest telemetry.
    Never generates fake data -- all None values if not yet received.
    """

    def __init__(self, serial_port='/dev/ttyS0', baud=57600, udp_src=None):
        self.serial_port  = serial_port
        self.baud         = baud
        self.udp_src      = udp_src   # e.g. 'udpin:0.0.0.0:14550' if using MAVProxy
        self.master        = None
        self.running       = False

        # Connection health
        self.status        = 'offline'   # 'online' | 'offline' | 'error'
        self.error_msg     = 'Not started'
        self.last_hb_ts    = 0.0
        self.sysid         = 0
        self.compid        = 0

        # Real telemetry -- None = not yet received from MAVLink
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
            'rc_channels': [],
            'timestamp':  None,
        }

    def start(self):
        self.running = True
        t = threading.Thread(target=self._worker, daemon=True, name='PixhackReader')
        t.start()

    def _connect(self):
        if not MAVLINK_AVAILABLE:
            self.status    = 'error'
            self.error_msg = 'pymavlink not installed'
            return False

        # Choose connection target
        target = self.udp_src if self.udp_src else self.serial_port
        try:
            if target.startswith('udp'):
                log.info(f'Connecting MAVLink via UDP: {target}')
                self.master = mavutil.mavlink_connection(target)
            else:
                log.info(f'Connecting to Pixhack at {target} (baud={self.baud})...')
                self.master = mavutil.mavlink_connection(target, baud=self.baud)

            log.info('Waiting for Pixhack heartbeat (timeout 5s)...')
            hb = self.master.wait_heartbeat(timeout=5.0)
            if hb:
                self.last_hb_ts = time.time()
                self.sysid      = self.master.target_system
                self.compid     = self.master.target_component
                self.status     = 'online'
                self.error_msg  = None
                log.info(f'Pixhack heartbeat OK! SysID={self.sysid} CompID={self.compid}')
                return True
            else:
                self.status    = 'offline'
                self.error_msg = f'No heartbeat on {target} @ {self.baud} within 5s'
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
                    time.sleep(3)
                    continue

            try:
                msg = self.master.recv_match(blocking=True, timeout=0.5)
                if msg is None:
                    # Check heartbeat timeout (3.5s)
                    if self.last_hb_ts > 0 and (time.time() - self.last_hb_ts) > 3.5:
                        self.status    = 'offline'
                        self.error_msg = f'Heartbeat lost ({round(time.time() - self.last_hb_ts, 1)}s ago)'
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
                        self._telem['roll']    = round(math.degrees(msg.roll),  1)
                        self._telem['pitch']   = round(math.degrees(msg.pitch), 1)
                        self._telem['yaw']     = round(math.degrees(msg.yaw),   1)
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
                        self._telem['timestamp'] = round(now, 3)

                    elif msg_type == 'SYS_STATUS':
                        self._telem['battery']   = msg.battery_remaining  # percent
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
                log.error(f'MAVLink read error: {e}')
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
    # Manual commands (only sent when operator explicitly triggers them)
    # -------------------------------------------------------------------------
    def send_arm(self, arm=True):
        if not self.master:
            log.warning('Cannot ARM/DISARM -- MAVLink not connected')
            return
        log.info(f'Operator command: {"ARM" if arm else "DISARM"}')
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
            log.warning(f'Unknown mode: {mode_name}')
            return
        log.info(f'Operator mode change: {mode_name}')
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

    def send_guided_waypoint(self, distance_m, turn_deg=0.0, speed_m_s=1.0):
        if not self.master or self.status != 'online':
            return
        rad = math.radians(turn_deg)
        vx = speed_m_s * math.cos(rad)
        vy = speed_m_s * math.sin(rad)
        log.info(f'Guided Waypoint: dist={distance_m}m, turn={turn_deg}°, vx={vx:.2f}, vy={vy:.2f}')
        self.send_position_target_local_ned(vx=vx, vy=vy, vz=0.0)

    def send_position_target_local_ned(self, vx=0.0, vy=0.0, vz=0.0, x=None, y=None, z=None):
        if not self.master or self.status != 'online':
            return
        if x is not None and y is not None:
            type_mask = 0b0000111111111000 # position only
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
# WebSocket Server
# ---------------------------------------------------------------------------
pixhack = None        # set in main()
ws_clients = set()


async def ws_handler(websocket, path=None):
    ws_clients.add(websocket)
    addr = getattr(websocket, 'remote_address', '?')
    log.info(f'GCS client connected: {addr}')

    # Send initial status immediately on connect
    try:
        mav_state = pixhack.get_status() if pixhack else {}
        init_msg  = json.dumps({
            'type': 'status',
            'data': {
                'pi':      'online',
                'mavlink': mav_state.get('status', 'offline'),
                'camera':  'managed_by_camera_server',   # camera is separate
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
                log.info(f'Received command: {action}')

                if pixhack:
                    if action == 'ARM':
                        pixhack.send_arm(True)
                    elif action == 'DISARM':
                        pixhack.send_arm(False)
                    elif action == 'CMD_NAV_RETURN_TO_LAUNCH':
                        pixhack.return_to_launch()
                    elif action == 'CMD_NAV_LAND':
                        pixhack.precision_land()
                    elif action == 'CMD_NAV_TAKEOFF':
                        pixhack.send_takeoff(cmd.get('alt', 1.5))
                    elif action == 'SET_MODE':
                        pixhack.set_mode(cmd.get('mode', 'GUIDED'))
                    elif action == 'CMD_CONDITION_YAW':
                        pixhack.send_condition_yaw(
                            cmd.get('angle', 0.0),
                            cmd.get('rate', 20.0),
                            cmd.get('relative', False)
                        )
                    elif action == 'NAV_WAYPOINT_REL':
                        pixhack.send_guided_waypoint(
                            cmd.get('distance', 1.0),
                            cmd.get('turn', 0.0),
                            cmd.get('speed', 1.0)
                        )
                    elif action == 'SET_POSITION_TARGET_LOCAL_NED':
                        pixhack.send_position_target_local_ned(
                            vx=cmd.get('vx', 0.0),
                            vy=cmd.get('vy', 0.0),
                            vz=cmd.get('vz', 0.0),
                            x=cmd.get('x', None),
                            y=cmd.get('y', None),
                            z=cmd.get('z', None)
                        )
            except Exception as e:
                log.error(f'Command error: {e}')
    except (websockets.exceptions.ConnectionClosed,
            websockets.exceptions.ConnectionClosedOK,
            websockets.exceptions.ConnectionClosedError):
        pass
    finally:
        ws_clients.discard(websocket)
        log.info(f'GCS client disconnected: {addr}')



async def broadcast_loop():
    """
    10 Hz telemetry broadcast + 1 Hz status broadcast.
    Never sends fake data -- if MAVLink is offline, fields are None.
    """
    last_status_ts = 0.0
    while True:
        if ws_clients and pixhack:
            now = time.time()

            # 10 Hz: real telemetry packet
            telem   = pixhack.get_telemetry()
            payload = json.dumps({'type': 'telemetry', 'data': telem})
            dead    = set()
            results = await asyncio.gather(
                *[c.send(payload) for c in list(ws_clients)],
                return_exceptions=True
            )
            for c, r in zip(list(ws_clients), results):
                if isinstance(r, Exception):
                    dead.add(c)
            ws_clients -= dead

            # 1 Hz: status packet
            if now - last_status_ts >= 1.0:
                last_status_ts = now
                mav_state = pixhack.get_status()
                status_payload = json.dumps({
                    'type': 'status',
                    'data': {
                        'pi':             'online',
                        'mavlink':        mav_state.get('status', 'offline'),
                        'camera':         'managed_by_camera_server',
                        'sysid':          mav_state.get('sysid'),
                        'compid':         mav_state.get('compid'),
                        'firmware':       mav_state.get('firmware'),
                        'mode':           telem.get('mode'),
                        'armed':          telem.get('armed'),
                        'last_heartbeat': mav_state.get('last_heartbeat_age_s'),
                        'mavlink_error':  mav_state.get('error'),
                    }
                })
                dead2   = set()
                results2 = await asyncio.gather(
                    *[c.send(status_payload) for c in list(ws_clients)],
                    return_exceptions=True
                )
                for c, r in zip(list(ws_clients), results2):
                    if isinstance(r, Exception):
                        dead2.add(c)
                ws_clients -= dead2

        await asyncio.sleep(0.1)   # 10 Hz loop


async def async_main(ws_port):
    log.info(f'WebSocket server listening on ws://0.0.0.0:{ws_port}')
    async with websockets.serve(ws_handler, '0.0.0.0', ws_port):
        broadcast = asyncio.create_task(broadcast_loop())
        try:
            await asyncio.Future()   # run forever
        except asyncio.CancelledError:
            broadcast.cancel()


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
def main():
    global pixhack

    parser = argparse.ArgumentParser(
        description='VISIONPATH Pi MAVLink WebSocket Bridge'
    )
    parser.add_argument('--serial',   default='/dev/ttyS0',
                        help='Pixhack serial port (default: /dev/ttyS0)')
    parser.add_argument('--baud',     type=int, default=57600,
                        help='Pixhack baud rate (default: 57600 -- DO NOT change)')
    parser.add_argument('--ws-port',  type=int, default=8081,
                        help='WebSocket listen port (default: 8081)')
    parser.add_argument('--udp-src',  default=None,
                        help='Optional UDP MAVLink source, e.g. udpin:0.0.0.0:14550')
    args = parser.parse_args()

    if not MAVLINK_AVAILABLE:
        log.error('pymavlink required. Install: pip3 install pymavlink')
        sys.exit(1)
    if not WEBSOCKETS_AVAILABLE:
        log.error('websockets required. Install: pip3 install websockets')
        sys.exit(1)

    print('=' * 70)
    print('  VISIONPATH -- Pi MAVLink WebSocket Bridge')
    print(f'  Pixhack UART  : {args.serial} @ {args.baud} baud (MAVLink 2)')
    print(f'  WebSocket     : ws://0.0.0.0:{args.ws_port}')
    print(f'  Camera server : http://10.89.89.85:8080 (separate, already running)')
    print(f'  MAVLink UDP   : {"disabled" if not args.udp_src else args.udp_src}')
    print('=' * 70)

    # Start MAVLink reader thread
    pixhack = PixhackReader(
        serial_port = args.serial,
        baud        = args.baud,
        udp_src     = args.udp_src,
    )
    pixhack.start()
    log.info(f'MAVLink reader started on {args.serial} @ {args.baud}')

    try:
        asyncio.run(async_main(args.ws_port))
    except KeyboardInterrupt:
        log.info('Shutting down...')
        pixhack.stop()


if __name__ == '__main__':
    main()
