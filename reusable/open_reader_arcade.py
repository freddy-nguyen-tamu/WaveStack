"""Independent staged arcade pages; no comic library changes."""
import json, shutil, re
from pathlib import Path

def stage_assets(root,stage):
    src=Path(root)/'reusable'/'arcade'
    if not src.is_dir(): return
    dest=Path(stage)/'arcade'
    dest.mkdir(parents=True,exist_ok=True)
    for name in ('index.html','arcade.css','arcade.js','games.json'):
        shutil.copy2(src/name,dest/name)
    games=json.loads((src/'games.json').read_text(encoding='utf-8'))['games']
    for game in games:
        folder=dest/game['id'];folder.mkdir(exist_ok=True)
        shutil.copy2(src/'index.html',folder/'index.html')
    # Keep both permanent URLs usable even when an optional game is absent.
    installed={g['id'] for g in games}
    for game_id,title,filename in GAME_LINKS:
        if game_id in installed:continue
        folder=dest/game_id;folder.mkdir(exist_ok=True)
        (folder/'index.html').write_text(missing_game_html(title,filename),encoding='utf-8')
    stage_cloudflare_discs(root, stage, games)
    add_game_navigation(stage)
    vendor=Path(root)/'.archiver_tools/open_reader_arcade/ruffle'
    if any(g['ready'] and g['engine']=='ruffle' for g in games):
        if not vendor.is_dir():raise RuntimeError('Ruffle runtime missing; rerun arcade installer')
        shutil.copytree(vendor,dest/'ruffle',dirs_exist_ok=True,ignore=shutil.ignore_patterns('.version','*.map'))

def hash_inputs(root,sha):
    root=Path(root);src=root/'reusable'/'arcade'
    paths=[root/'.archiver_state'/'open_reader_arcade.json',root/'reusable'/'open_reader_arcade.py',root/'reusable'/'worker_addon'/'arcade_worker.mjs']
    if src.is_dir():paths.extend(p for p in src.rglob('*') if p.is_file())
    vendor=root/'.archiver_tools/open_reader_arcade/ruffle'
    if vendor.is_dir():paths.extend(p for p in vendor.rglob('*') if p.is_file() and p.suffix!='.map')
    return {p.relative_to(root).as_posix():sha(p.read_bytes()) for p in paths if p.is_file()}


def bind_database(root,cfg):
    p=Path(root)/'.archiver_state'/'open_reader_arcade.json'
    if not p.is_file():raise RuntimeError('Arcade D1 config missing; rerun Arcade installer')
    data=json.loads(p.read_text(encoding='utf-8'));dbid=data.get('database_id') if isinstance(data,dict) else None
    if not isinstance(dbid,str) or not re.fullmatch(r'[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}',dbid):raise RuntimeError('Invalid Arcade D1 database ID')
    cfg.setdefault('d1_databases',[]).append({'binding':'ARCADE_DB','database_name':'open-reader-arcade-saves','database_id':dbid})


GAME_LINKS=(('chaos-faction-2','Chaos Faction 2','chaos-faction-2-5645.swf'),
            ('bloody-roar-2','Bloody Roar II','Bloody Roar 2 - Bringer of the New Age (Europe).chd'))
NAV_CSS='<style id="arcade-home-nav-style">\n.subtitle{white-space:nowrap;overflow-x:auto;overflow-y:hidden;scrollbar-width:thin;scrollbar-color:#718091 transparent;gap:0}\n.subtitle::before,.subtitle a{flex:none}\n.subtitle a.arcade-home-link{margin:0 14px 0 0;color:#f5d99f;font-weight:650;text-decoration:underline;white-space:nowrap}\n.subtitle a.arcade-home-link:focus-visible{outline:2px solid #febd69;outline-offset:2px}\n@media(max-width:760px){.subtitle{gap:8px}.subtitle a[href="/add-comic/"]{margin-left:0!important}.subtitle a{margin-right:4px!important}}\n</style>'

def add_game_navigation(stage):
    home=Path(stage)/'index.html'
    html=home.read_text(encoding='utf-8')
    # Called after manual_import.stage_assets: anchor to its generated Add Comic link.
    nav=re.findall(r'<p\b[^>]*class=["\']subtitle["\'][^>]*>.*?</p>',html,flags=re.S)
    if len(nav)!=1:raise RuntimeError('Cannot locate unique homepage navigation bar')
    bar=nav[0]
    anchors=list(re.finditer(r'<a\b[^>]*href=["\']/add-comic/["\'][^>]*>.*?</a>',bar,flags=re.S|re.I))
    if len(anchors)!=1:raise RuntimeError('Cannot locate unique Add Comic navigation link')
    existing=[f'href="/arcade/{g}/"' in bar for g,_,_ in GAME_LINKS]
    if any(existing):
        if all(existing) and 'id="arcade-home-nav-style"' in html:return
        raise RuntimeError('Partial arcade navigation already exists; refusing duplicate links')
    links=''.join(f' <a class="arcade-home-link" href="/arcade/{g}/">{title}</a>' for g,title,_ in GAME_LINKS)
    pos=anchors[0].end();new=bar[:pos]+links+bar[pos:]
    if html.count('</head>')!=1:raise RuntimeError('Homepage head anchor changed')
    html=html.replace(bar,new,1).replace('</head>',NAV_CSS+'</head>',1)
    home.write_text(html,encoding='utf-8')


def missing_game_html(title,filename):
    from html import escape
    return ('<!doctype html><html lang="en"><head><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width,initial-scale=1">'
            '<meta name="robots" content="noindex,nofollow"><title>'+escape(title)+' · Open Reader</title>'
            '<link rel="stylesheet" href="/arcade/arcade.css"><style id="arcade-home-return-style">header{flex-wrap:wrap;gap:12px}header a.arcade-home-return{display:inline-block;background:#febd69;color:#17212d;border:1px solid #d6a44f;border-radius:5px;padding:10px 14px;font:inherit;font-weight:600;text-decoration:none}header a.arcade-home-return:hover{background:#ffd18f}header a.arcade-home-return:focus-visible{outline:2px solid white;outline-offset:3px}</style></head><body><header>'
            '<a href="/">Open Reader</a><a id="home-return" class="arcade-home-return" href="/">Return to Open Reader homepage</a></header><main><h1>'+escape(title)+'</h1>'
            '<p>This game is not installed yet. The site administrator can add '
            '<code>'+escape(filename)+'</code> using the arcade game installer.</p>'
            '<p><a href="/arcade/">Other games</a> · <a href="/">Comic library</a></p></main></body></html>')


# Persist disc bytes outside the tracked repository. Every deployment stages
# them into Workers Static Assets; comic images still use GitHub streaming.
def disc_parts(game):
    import hashlib
    d=game.get('disc',{})
    names=d.get('parts')
    if not isinstance(names,list) or not 1<=len(names)<=100 or not re.fullmatch(r'[0-9a-f]{64}',str(d.get('sha',''))):
        raise RuntimeError('Invalid PlayStation disc catalog')
    files={f['name']:f for f in game['files']}
    parts=[]
    for i,name in enumerate(names):
        f=files.get(name)
        if name!=f'disc-{i:04d}.part' or not f or not re.fullmatch(r'[0-9a-f]{64}',str(f.get('sha',''))) or type(f.get('size')) is not int or not 0<f['size']<=8*1024*1024:
            raise RuntimeError('Invalid disc part: '+str(name))
        parts.append(f)
    if sum(f['size'] for f in parts)!=d.get('size') or not 0<d['size']<=700*1024*1024:
        raise RuntimeError('Invalid disc size')
    return parts


def disc_cache(root):
    return Path(root)/'.archiver_tools'/'open_reader_arcade'/'cloudflare_disc_v5'


def stage_cloudflare_discs(root,stage,games):
    import hashlib
    for game in games:
        if not (game.get('ready') and game.get('engine')=='psx'):continue
        parts=disc_parts(game); whole=hashlib.sha256()
        for f in parts:
            src=disc_cache(root)/f['sha']/f['name']
            if not src.is_file():raise RuntimeError('Cloudflare disc cache missing: '+str(src)+'; rerun Arcade Cloudflare v5 installer')
            raw=src.read_bytes()
            if len(raw)!=f['size'] or hashlib.sha256(raw).hexdigest()!=f['sha']:
                raise RuntimeError('Cloudflare disc cache corrupt: '+str(src)+'; rerun v5 installer')
            whole.update(raw)
            dest=Path(stage)/'arcade-disc'/f['sha']/f['name'];dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(raw)
        if whole.hexdigest()!=game['disc']['sha']:raise RuntimeError('Whole disc integrity mismatch')
        print(f"ARCADE CLOUDFLARE STATIC ASSETS: {game['id']} — {len(parts)} verified parts, {game['disc']['size']/1048576:.1f} MiB",flush=True)
    if sum(1 for p in Path(stage).rglob('*') if p.is_file())>20000:
        raise RuntimeError('Cloudflare Workers Free static asset count would exceed 20,000')
