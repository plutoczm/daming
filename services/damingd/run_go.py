import os
import subprocess
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[2]
go = root / '.tools/go/1.26.8/bin/go.exe'
service = root / 'services/damingd'
env = os.environ.copy()
env.update({
    'GOTOOLCHAIN': 'local',
    'GOPROXY': env.get('DAMING_GOPROXY', 'https://goproxy.cn,direct'),
    'GOMODCACHE': str(root / '.cache/go-mod'),
    'GOCACHE': str(root / '.cache/magpie-build'),
    'GOPATH': str(root / '.cache/go-path'),
    'CGO_ENABLED': '0',
})
raise SystemExit(subprocess.call([str(go), *sys.argv[1:]], cwd=service, env=env))
