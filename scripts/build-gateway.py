from pathlib import Path
import subprocess
root=Path(__file__).resolve().parents[1]
service=root/"services/model-gateway-go"
output=root/"runtime/model-gateway/windows-x64/daming-gateway-v3.exe"
output.parent.mkdir(parents=True,exist_ok=True)
raise SystemExit(subprocess.run(["D:/Anaconda3/envs/daming/python.exe","-X","utf8",str(service/"run_go.py"),"build","-trimpath","-o",str(output),"./cmd/daming-gateway"],cwd=root).returncode)
