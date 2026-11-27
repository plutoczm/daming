import os, subprocess, sys
from pathlib import Path
root = Path(__file__).resolve().parents[2]
env = os.environ.copy()
env.update(GOTOOLCHAIN='local', GOMODCACHE=str(root/'.cache/go-mod'), GOCACHE=str(root/'.cache/go-build'), GOPATH=str(root/'.cache/go-path'))
raise SystemExit(subprocess.run([str(root/'.tools/go/1.26.8/bin/go.exe'), *sys.argv[1:]], cwd=Path(__file__).resolve().parent, env=env).returncode)
