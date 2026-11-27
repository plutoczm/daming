from pathlib import Path
import subprocess

root = Path(__file__).resolve().parents[1]
out = root / 'runtime/magpie/windows-x64/daming-magpie-codex-subscription-v2.exe'
out.parent.mkdir(parents=True, exist_ok=True)
runner = root / 'services/damingd/run_go.py'
raise SystemExit(subprocess.call([
    'D:/Anaconda3/envs/daming/python.exe', '-X', 'utf8', str(runner),
    'build', '-tags', 'nogui', '-trimpath', '-o', str(out), '.'
], cwd=root))
