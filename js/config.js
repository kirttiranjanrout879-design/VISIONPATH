/* ===============================================================
   config.js -- VISIONPATH Central Hardware Configuration

   SETUP:
     Raspberry Pi IP  : 10.89.89.85
     Laptop IP        : 10.89.89.228 (HP Victus)
     Camera Port      : 8080  (existing camera_server.py on Pi, systemd)
     Camera Stream    : /stream.mjpg
     MAVLink WS Port  : 8081  (vp_laptop_bridge.py or pi_mavlink_ws.py)
     MAVLink UDP Port : 14550 (MAVProxy -> laptop)

   Two Architecture Modes Supported:
   
   MODE A: Localhost Bridge (Laptop runs vp_laptop_bridge.py)
     Browser (file:///)
       |--- MJPEG Stream -----> http://10.89.89.85:8080/stream.mjpg (Pi)
       |--- WebSocket Telem --> ws://127.0.0.1:8081 (Localhost bridge)
     Raspberry Pi
       |--- MAVProxy ---------> forwards /dev/ttyS0 to udp:10.89.89.228:14550
       |--- camera_server.py -> port 8080

   MODE B: Pi-Direct Bridge (Pi runs pi_mavlink_ws.py)
     Browser (file:///)
       |--- MJPEG Stream -----> http://10.89.89.85:8080/stream.mjpg (Pi)
       |--- WebSocket Telem --> ws://10.89.89.85:8081 (Pi bridge)
=============================================================== */
'use strict';

const CONFIG = Object.freeze({
  // Raspberry Pi Hardware & Network
  PI_IP:               '10.89.89.85',
  LAPTOP_IP:           '10.89.89.228',

  // Camera -- Pi Camera OV5647 stream (systemd managed on Pi)
  CAMERA_HOST:         '10.89.89.85',
  CAMERA_PORT:         8080,
  CAMERA_STREAM_PATH:  '/stream.mjpg',

  // MAVLink WebSocket Server (Localhost default for vp_laptop_bridge.py)
  MAVLINK_WS_HOST:     '127.0.0.1',
  MAVLINK_WS_PORT:     8081,

  // Hardware UART on Pi
  MAVLINK_SERIAL:      '/dev/ttyS0',
  MAVLINK_BAUD:        57600,

  // MAVLink UDP forwarding port
  MAVLINK_UDP_PORT:    14550,
});
