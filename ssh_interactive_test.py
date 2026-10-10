import paramiko

PI_HOST = "10.89.89.85"
USERNAME = "flyingbots"
PASSWORD = "kumarrupa143"

def handler(title, instructions, prompt_list):
    responses = []
    for prompt, echo in prompt_list:
        print(f"[SSH Prompt] {prompt}")
        responses.append(PASSWORD)
    return responses

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())

try:
    print(f"Connecting to {USERNAME}@{PI_HOST} via transport auth_interactive...")
    transport = paramiko.Transport((PI_HOST, 22))
    transport.connect(username=USERNAME)
    transport.auth_interactive(USERNAME, handler)
    if transport.is_authenticated():
        print("[✓] SUCCESS! Authenticated via interactive PAM!")
        client._transport = transport
        sftp = client.open_sftp()
        sftp.put("companion_bridge.py", f"/home/{USERNAME}/companion_bridge.py")
        sftp.close()
        print("[✓] Uploaded companion_bridge.py")
        stdin, stdout, stderr = client.exec_command(f"nohup python3 /home/{USERNAME}/companion_bridge.py --serial /dev/ttyAMA0 --baud 921600 --cam-port 8080 --ws-port 8081 > /home/{USERNAME}/companion_bridge.log 2>&1 &")
        print("[✓] Started companion_bridge.py on Raspberry Pi!")
    else:
        print("[-] Interactive auth failed.")
except Exception as e:
    print(f"[!] Error: {e}")
