# Coloca ?v=<versão> em todos os imports locais do PWA (evita cache velho no githack/Pages).
import re, os, sys
root = os.path.join(os.path.dirname(__file__), '..', 'web', 'app')
ver = re.search(r"APP_VERSION = '([^']+)'", open(os.path.join(root, 'js', 'config.js')).read()).group(1)
def fix(path):
    s = open(path).read()
    n = re.sub(r"""((?:from|import)\s*\(?\s*['"])(\./[\w\-/]+\.js)(?:\?v=[^'"]*)?(['"])""", lambda m: f"{m.group(1)}{m.group(2)}?v={ver}{m.group(3)}", s)
    n = re.sub(r"""(src=")(js/app\.js|style\.css)(?:\?v=[^"]*)?(")""", lambda m: f"{m.group(1)}{m.group(2)}?v={ver}{m.group(3)}", n)
    n = re.sub(r"""(href=")(style\.css)(?:\?v=[^"]*)?(")""", lambda m: f"{m.group(1)}{m.group(2)}?v={ver}{m.group(3)}", n)
    if n != s: open(path, 'w').write(n); print('versioned', os.path.relpath(path, root))
for dp, dn, fn in os.walk(root):
    for f in fn:
        if f.endswith(('.js', '.html')): fix(os.path.join(dp, f))
