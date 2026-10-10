import paramiko
import sys

PI_HOST = "10.89.89.85"
PW = "kumarrupa143"
USERS = ["flyingbots", "pi", "kirtt", "admin", "ubuntu", "user", "root", "kumar", "kumarrupa", "raspberry", "debian"]

print(f"Testing password '{PW}' across usernames...")
client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())

for u in USERS:
    try:
        sys.stdout.write(f"Testing {u}... ")
        sys.stdout.flush()
        client.connect(PI_HOST, port=22, username=u, password=PW, timeout=3, banner_timeout=3, auth_timeout=3)
        print(f"\n[✓✓✓] SUCCESSFUL LOGIN with username: '{u}' and password: '{PW}'")
        
        # Upload and run bridge!
        sftp = client.open_sftp()
        sftp.put("companion_bridge.py", f"companion_bridge.py")
        sftp.close()
        print("[✓] Uploaded companion_bridge.py!")
        
        client.exec_command("pkill -f companion_bridge.py")
        cmd = "nohup python3 companion_bridge.py --serial /dev/ttyAMA0 --baud 921600 --cam-port 8080 --ws-port 8081 > companion_bridge.log 2>&1 &"
        client.exec_command(cmd)
        print("[✓] STARTED companion_bridge.py on Raspberry Pi!")
        client.close()
        sys.exit(0)
    except paramiko.AuthenticationException:
        print("Failed")
    except Exception as e:
        print(f"Error: {e}")

print("None succeeded.")
