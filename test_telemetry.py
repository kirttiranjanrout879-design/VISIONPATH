import asyncio
import websockets

async def check_telemetry():
    async with websockets.connect("ws://127.0.0.1:8081") as ws:
        for _ in range(3):
            msg = await ws.recv()
            print("[OK] Telemetry Packet:", msg)

if __name__ == '__main__':
    asyncio.run(check_telemetry())
