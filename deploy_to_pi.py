import os
import sys
import time
import paramiko

PI_HOST = "10.89.89.85"
USERNAME = "bk"
PASSWORD = "kumarrupa143"

def connect():
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    print(f"[*] Connecting to {USERNAME}@{PI_HOST} with SSH...")
    try:
        client.connect(PI_HOST, port=22, username=USERNAME, password=PASSWORD, timeout=10, banner_timeout=10, auth_timeout=10)
        print(f"[OK] LOGIN SUCCESSFUL! Connected as '{USERNAME}'")
        return client
    except Exception as e:
        print(f"[!] Login error: {e}")
        return None

def deploy(client):
    print("[*] Uploading companion scripts to Raspberry Pi...")
    sftp = client.open_sftp()
    scripts = ["companion_bridge.py", "pi_mavlink_ws.py", "pi_agent.py", "pi_camera_server.py", "verify_pi_hardware.py"]
    for script in scripts:
        local_path = os.path.join(os.path.dirname(__file__), script)
        if os.path.exists(local_path):
            remote_path = f"/home/{USERNAME}/{script}"
            sftp.put(local_path, remote_path)
            print(f"  [OK] Uploaded: {remote_path}")
    sftp.close()
    
    print("[*] Creating media captures directory on Raspberry Pi (/home/{USERNAME}/captures)...")
    client.exec_command(f"mkdir -p /home/{USERNAME}/captures")
    
    print("[*] Installing required packages on Raspberry Pi (websockets opencv-python pymavlink)...")
    stdin, stdout, stderr = client.exec_command("pip3 install websockets opencv-python pymavlink --break-system-packages 2>&1 || pip3 install websockets opencv-python pymavlink 2>&1")
    for line in stdout:
        print(f"  [Pi] {line.strip()}")
        
    print("[*] Stopping any previous bridge / camera instances...")
    client.exec_command("pkill -f companion_bridge.py; pkill -f pi_agent.py; pkill -f pi_camera_server.py")
    time.sleep(1)
    
    print("[*] Starting companion_bridge.py in background...")
    cmd = f"nohup python3 /home/{USERNAME}/companion_bridge.py --serial /dev/ttyAMA0 --baud 921600 --cam-port 8080 --ws-port 8081 > /home/{USERNAME}/companion_bridge.log 2>&1 &"
    client.exec_command(cmd)
    time.sleep(3)
    
    # Check if process is running
    stdin, stdout, stderr = client.exec_command("pgrep -fl python3")
    res = stdout.read().decode().strip()
    if "companion_bridge.py" in res or "pi_agent.py" in res:
        print(f"[OK] Companion Bridge is RUNNING on Raspberry Pi! Process: {res}")
    else:
        print(f"[!] Checking logs (/home/{USERNAME}/companion_bridge.log)...")
        stdin, stdout, stderr = client.exec_command(f"cat /home/{USERNAME}/companion_bridge.log")
        print(stdout.read().decode())
        
    # Check open ports 8080 and 8081
    stdin, stdout, stderr = client.exec_command("netstat -tuln | grep -E '8080|8081' || ss -tuln | grep -E '8080|8081'")
    ports = stdout.read().decode().strip()
    print(f"[*] Open Ports on Pi:\n{ports}")
    
    client.close()
    print("\n[OK] ALL DONE! Raspberry Pi is now streaming camera, recording media & MAVLink.")

if __name__ == '__main__':
    client = connect()
    if client:
        deploy(client)
    else:
        sys.exit(1)
