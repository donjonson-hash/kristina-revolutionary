from pathlib import Path
from html.parser import HTMLParser
from urllib.parse import urlparse
import json,zipfile,subprocess,re
root=Path(__file__).resolve().parents[1]/'dist'
release=json.loads((root.parent/'release.json').read_text())
class Parser(HTMLParser):
 def __init__(self): super().__init__(); self.refs=[]; self.ids=[]; self.csp=''
 def handle_starttag(self,tag,attrs):
  a=dict(attrs)
  if 'id' in a:self.ids.append(a['id'])
  if tag=='meta' and a.get('http-equiv')=='Content-Security-Policy':self.csp=a['content']
  for key in ('src','href'):
   if key in a:self.refs.append(a[key])
for p in root.rglob('*.html'):
 parser=Parser();parser.feed(p.read_text());assert len(parser.ids)==len(set(parser.ids)),p
 assert "connect-src 'none'" in parser.csp,p
 for ref in parser.refs:
  u=urlparse(ref)
  if u.scheme or u.netloc or not u.path:continue
  f=root/u.path.lstrip('/') if u.path.startswith('/') else p.parent/u.path
  if f.is_dir():f=f/'index.html'
  assert f.exists(),(p,ref)
for p in [*root.glob('*.js'), *root.glob('*.mjs')]:subprocess.run(['node','--check',str(p)],check=True)
app=(root/'app.js').read_text();assert "fetch(path" not in app
assert 'new Worker(' in (root/'transport.js').read_text()
for target in ('chrome','firefox'):
 assert (root/'downloads'/f"ctt-{target}-{release['version']}.zip").is_file(), f'Missing {target} release; run npm run build first'
for p in (root/'downloads').glob('*.zip'):
 with zipfile.ZipFile(p) as z:
  manifest=json.loads(z.read('manifest.json'))
  assert manifest['homepage_url']=='https://comparethesetexts.com/'
  assert manifest['version']==re.search(r'-(\d+\.\d+\.\d+)\.zip$',p.name).group(1)
  if p.name.startswith('ctt-'):
   assert manifest['name'] in ('Compare These Texts — Compare & Edit',release['name'])
   assert '<html lang="en">' in z.read('index.html').decode()
   assert manifest['action']['default_title']=='CTT — Compare & Edit'
   for name in ['index.html','launcher.html']:
    parser=Parser();parser.feed(z.read(name).decode())
    for ref in parser.refs:
     u=urlparse(ref)
     if u.scheme or u.netloc or not u.path:continue
     assert not u.path.startswith('/'),(p,ref)
     assert u.path in z.namelist(),(p,ref)
  if p.name in (f"ctt-chrome-{release['version']}.zip",f"ctt-firefox-{release['version']}.zip"):
   expected={f.name for f in root.iterdir() if f.is_file() and f.name!='robots.txt'} | {'manifest.json','launcher.html','launcher.css','launcher.js','privacy.html','support.html'}
   assert set(z.namelist())==expected,(p,'asset closure')
   for f in root.iterdir():
    if f.is_file() and f.name not in ('index.html','robots.txt'):assert z.read(f.name)==f.read_bytes(),(p,f.name)
   parser=Parser();parser.feed(z.read('index.html').decode())
   assert manifest['content_security_policy']['extension_pages']==parser.csp
   assert manifest['name']==release['name']
   for name in ('privacy.html','support.html'):
    parser=Parser();parser.feed(z.read(name).decode())
    for ref in parser.refs:
     u=urlparse(ref)
     if not u.scheme and not u.netloc and u.path:assert u.path in z.namelist(),(p,name,ref)
   if 'firefox' in p.name:assert manifest['browser_specific_settings']['gecko']['id']=='kristina-reconciliation@donjonson-hash.github.io'
  assert not manifest.get('permissions') and not manifest.get('host_permissions')
print('PASS: routes, local assets, unique UI IDs, CSP, JS syntax, worker-only comparison, both extension downloads')
