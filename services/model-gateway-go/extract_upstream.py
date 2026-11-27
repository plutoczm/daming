"""One-time source extraction; build/runtime never invoke this script."""
from pathlib import Path
import shutil
src=Path('D:/Projects/magpie/internal/gateway')
dst=Path(__file__).resolve().parent/'internal/stream'
dst.mkdir(parents=True, exist_ok=True)
for name in ['sse.go','sse_bare.go']:
    s=(src/name).read_text(encoding='utf-8').replace('package gateway','package stream',1)
    if name=='sse.go':
        s=s[:s.index('// sseWriter')]
        a=s.index('import ('); b=s.index(')',a)
        s=s[:a]+'import ("bufio";"io";"strings")'+s[b+1:]
        s=s.replace('func readSSE(', 'func ReadSSE(')
    else:
        s+='\nfunc carries(raw json.RawMessage) bool { s := bytes.TrimSpace(raw); return len(s)>0 && string(s)!="null" }\n'
    (dst/name).write_text(s, encoding='utf-8')
s=(src/'chat.go').read_text(encoding='utf-8')
s=s[s.index('type cUsage struct'):s.index('func (u Usage) chat()')]
s=s.replace('type cUsage struct','type ChatUsage struct').replace('(u cUsage) usage()', '(u ChatUsage) Usage()')
ir=(src/'ir.go').read_text(encoding='utf-8'); ir=ir[ir.index('type Usage struct'):ir.index('// billed is')]
(dst/'usage.go').write_text('package stream\n'+ir+s,encoding='utf-8')
s=(src/'sse_bare_test.go').read_text(encoding='utf-8'); s=s[:s.index('// zRain\'s case end to end:')]
s=s.replace('package gateway','package stream',1).replace('readSSE(', 'ReadSSE(').replace('vertexThought, ','')
a=s.index('import ('); b=s.index(')',a)
s=s[:a]+'import("io";"strings";"testing";"testing/iotest")'+s[b+1:]
(dst/'sse_bare_test.go').write_text(s,encoding='utf-8')
shutil.copyfile(src.parents[1]/'LICENSE',dst.parents[1]/'LICENSE.magpie')
