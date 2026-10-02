"""Package the site's English offline engine for Chrome and Firefox."""
from pathlib import Path
import json,zipfile,re
root=Path(__file__).resolve().parents[1];dist=root/'dist';sources=root/'extension-package'
release=json.loads((root/'release.json').read_text())
version=release['version']
for target in ['chrome','firefox']:
 manifest=json.loads((sources/(target+'-manifest.json')).read_text())
 manifest.update({key:release[key] for key in ('name','version','description','homepage_url')})
 manifest['action']['default_title']='CTT — Compare & Edit'
 # Preserve the Firefox ID and permission-free offline CSP.
 files={p.name:p.read_bytes() for p in dist.iterdir() if p.is_file() and p.name!='robots.txt'}
 html=files['index.html'].decode().replace('href="/"','href="index.html"').replace('href="/site.css"','href="site.css"').replace('href="/favicon.svg"','href="favicon.svg"')
 html=html.replace('href="/extension/"','href="https://comparethesetexts.com/extension/"').replace('href="/privacy/"','href="privacy.html"').replace('href="/support/"','href="support.html"')
 html=html.replace('>Extension</a>','>Website</a>').replace('href="https://comparethesetexts.com/extension/">Website','href="https://comparethesetexts.com/">Website')
 html=re.sub(r'<a href="(https://[^"]+)"',r'<a href="\1" target="_blank" rel="noopener noreferrer"',html)
 files['index.html']=html.encode();files['manifest.json']=(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n').encode()
 for page in ['privacy','support']:
  content=(dist/page/'index.html').read_text()
  for before,after in {'/':'index.html','/style.css':'style.css','/site.css':'site.css','/favicon.svg':'favicon.svg','/privacy/':'privacy.html','/support/':'support.html','/extension/':'https://comparethesetexts.com/extension/'}.items():
   content=content.replace('href="'+before+'"','href="'+after+'"')
  files[page+'.html']=content.encode()
 for name in ['launcher.html','launcher.css','launcher.js']:files[name]=(sources/name).read_bytes()
 archive=dist/'downloads'/f'ctt-{target}-{version}.zip'
 with zipfile.ZipFile(archive,'w',compression=zipfile.ZIP_DEFLATED) as z:
  for name,content in sorted(files.items()):
   info=zipfile.ZipInfo(name,date_time=(2026,1,1,0,0,0));info.compress_type=zipfile.ZIP_DEFLATED;info.external_attr=0o644<<16;z.writestr(info,content)
 print(archive)
