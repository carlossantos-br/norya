#!/usr/bin/env python3
"""Gera assets/pet/*.png a partir dos sprites ORIGINAIS dos apps instalados.

Nada é redesenhado: o Clawd vem do minigame "Clawd's Quest" que o Claude.app
traz (sprite "Laptop", tabela base+deltas em base36 dentro do bundle JS) e o
mascote do Codex vem do spritesheet v2 que o ChatGPT.app traz (atlas 8x11 de
192x208). Rodar de novo só quando os apps trocarem os sprites:

    python3 tools/pet-assets.py

Saída (assets/pet): uma tira horizontal RGBA POR ESTADO (<pet>-<estado>.png, um
quadro ao lado do outro, todos do mesmo tamanho) + manifest.json (arquivo, nº de
quadros, durações em ms, filtro, espelhar). O helper carrega uma tira por vez,
sob demanda. Clawd: 1 px por pixel de arte, todas as tiras no MESMO canvas (pé
embaixo, centralizado) pra não pular na troca; Codex: célula inteira 192x208 do
atlas (linhas 0-8; já é @2x).
"""
import json, os, re, subprocess, sys, tempfile
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', 'assets', 'pet')
CLAUDE_ASAR = '/Applications/Claude.app/Contents/Resources/app.asar'
CHATGPT_ASAR = '/Applications/ChatGPT.app/Contents/Resources/app.asar'


def asar_find(asar, pattern):
    names = subprocess.run(['npx', '--yes', '@electron/asar', 'list', asar],
                           capture_output=True, text=True, check=True).stdout.split('\n')
    hit = [n for n in names if re.search(pattern, n)]
    if not hit:
        sys.exit(f'não achei {pattern} em {asar}')
    return hit[0].lstrip('/')


def asar_extract(asar, inner, tmp):
    subprocess.run(['npx', '--yes', '@electron/asar', 'extract-file', asar, inner], cwd=tmp, check=True)
    return os.path.join(tmp, os.path.basename(inner))


def clawd_table(js_path):
    # `,te={Nome:{cat,w,h,fps,palette,base,deltas,a0}, ...}` — avaliado em Node
    # pra não reimplementar o parser de objeto JS.
    src = r'''
const s=require("fs").readFileSync(process.argv[1],"utf8");
const m=s.indexOf(",te={BreakDancing:"); if(m<0) process.exit(2);
let d=0,i=m+4;
for(;i<s.length;i++){const c=s[i];
  if(c==='"'){i++;while(s[i]!=='"'){if(s[i]==="\\")i++;i++;}continue;}
  if(c==="{")d++;else if(c==="}"){d--;if(d===0)break;}}
process.stdout.write(JSON.stringify((0,eval)("("+s.slice(m+4,i+1)+")")));
'''
    return json.loads(subprocess.run(['node', '-e', src, js_path], capture_output=True,
                                     text=True, check=True).stdout)


def clawd_frames(t):
    w, h = t['w'], t['h']
    cur = [255 if c == '.' else int(c, 36) for c in t['base']]
    out = [list(cur)]
    for delta in t['deltas']:
        if delta:
            for tok in delta.split(','):
                cur[int(tok[:-1], 36)] = 255 if tok[-1] == '.' else int(tok[-1], 36)
        out.append(list(cur))
    pal = [tuple(int(p[k:k + 2], 16) for k in (1, 3, 5)) for p in t['palette']]
    imgs = []
    for f in out:
        im = Image.new('RGBA', (w, h))
        im.putdata([(0, 0, 0, 0) if v == 255 else pal[v] + (255,) for v in f])
        imgs.append(im)
    return imgs


def write_strip(frames, name):
    sheet = Image.new('RGBA', (frames[0].width * len(frames), frames[0].height))
    for i, f in enumerate(frames):
        sheet.paste(f, (i * f.width, 0))
    sheet.save(os.path.join(OUT, name + '.png'), optimize=True)
    print(f'{name}.png: {len(frames)} quadros de {frames[0].width}x{frames[0].height}')


# Codex: linha do atlas, quadros, ms/quadro, ms do último quadro (tabela do app).
CODEX_STATES = [
    ('idle', 0, 6, [280, 110, 110, 140, 140, 320]),
    ('running-right', 1, 8, [120] * 7 + [220]),
    ('running-left', 2, 8, [120] * 7 + [220]),
    ('waving', 3, 4, [140] * 3 + [280]),
    ('jumping', 4, 5, [140] * 4 + [280]),
    ('failed', 5, 8, [140] * 7 + [240]),
    ('waiting', 6, 6, [150] * 5 + [260]),
    ('running', 7, 6, [120] * 5 + [220]),
    ('review', 8, 6, [150] * 5 + [280]),
]
# Clawd: estado -> (animação do Clawd's Quest, intervalo de quadros ou None, espelhar)
CLAWD_STATES = [
    ('idle', 'LookingAroundEyesOnly', None, False),
    ('running', 'Laptop', (0, 20), False),
    ('running-right', 'Running', None, False),
    ('running-left', 'Running', None, True),
    ('waving', 'Waving', None, False),
    ('jumping', 'JumpingHappy', None, False),
    ('failed', 'Disappointed', None, False),
    ('waiting', 'Pointing', None, False),
    ('review', 'Excited', None, False),
]


def union_box(frames):
    boxes = [f.getbbox() for f in frames if f.getbbox()]
    return (min(b[0] for b in boxes), min(b[1] for b in boxes),
            max(b[2] for b in boxes), max(b[3] for b in boxes))


def main():
    os.makedirs(OUT, exist_ok=True)
    for f in os.listdir(OUT):
        if f.endswith('.png') or f == 'manifest.json':
            os.remove(os.path.join(OUT, f))
    manifest = {'version': 2, 'pets': {}}
    with tempfile.TemporaryDirectory() as tmp:
        # ---- Clawd
        js = asar_extract(CLAUDE_ASAR, asar_find(CLAUDE_ASAR, r'clawdQuestEngine-.*\.js$'), tmp)
        table = clawd_table(js)
        # Âncora de cada animação = quadro 0 (pose neutra): centro x do corpo e pé (base).
        # Todas as animações são coladas no mesmo canvas por essa âncora, então o corpo
        # não pula na troca de estado.
        raw, anchors = {}, {}
        for st, name, rng, _ in CLAWD_STATES:
            fs = clawd_frames(table[name])
            if rng:
                fs = fs[rng[0]:rng[1]]
            raw[st] = fs
            b0 = fs[0].getbbox()
            anchors[st] = ((b0[0] + b0[2]) // 2, b0[3])
        L = R = U = D = 0
        for st, fs in raw.items():
            ax, ay = anchors[st]
            bx = union_box(fs)
            L = max(L, ax - bx[0]); R = max(R, bx[2] - ax)
            U = max(U, ay - bx[1]); D = max(D, bx[3] - ay)
        cw, ch = L + R, U + D
        states = {}
        done = {}
        for st, name, rng, mirror in CLAWD_STATES:
            key = (name, rng)
            if key not in done:
                ax, ay = anchors[st]
                out = []
                for f in raw[st]:
                    c = Image.new('RGBA', (cw, ch))
                    c.paste(f, (L - ax, U - ay))
                    out.append(c)
                fname = f'clawd-{st}'
                write_strip(out, fname)
                done[key] = (fname, len(out))
            fname, n = done[key]
            ent = {'file': fname + '.png', 'frames': n, 'durations': [83] * n,
                   'filter': 'nearest', 'mirror': mirror, 'loops': 3 if n <= 30 else 1}
            if st == 'idle':
                ent['loops'] = 1
            if st == 'running':
                # Laptop: intro 0-16, loop 17-19 (3 ciclos) e descansa no último quadro do loop.
                ent.update({'introFrames': 17, 'loopStart': 17, 'loopFrames': 3, 'loops': 3, 'after': 'hold'})
            states[st] = ent
        states['idle']['idlePauseMs'] = 5000   # toca a 12 fps e pausa no quadro 0 por 5 s
        manifest['pets']['clawd'] = {'name': 'Clawd', 'cell': {'w': cw, 'h': ch}, 'filter': 'nearest',
                                     'sizing': 'pixelSnap', 'states': states}

        # ---- Codex
        webp = asar_extract(CHATGPT_ASAR, asar_find(CHATGPT_ASAR, r'codex-spritesheet-v\d+-.*\.webp$'), tmp)
        atlas = Image.open(webp).convert('RGBA')
        states = {}
        for st, row, n, durs in CODEX_STATES:
            frames = [atlas.crop((c * 192, row * 208, (c + 1) * 192, (row + 1) * 208)) for c in range(n)]
            write_strip(frames, f'codex-{st}')
            states[st] = {'file': f'codex-{st}.png', 'frames': n, 'durations': durs, 'filter': 'linear',
                          'mirror': False, 'loops': 3}
        states['idle']['loops'] = 1
        states['idle']['idleSlow'] = 6          # idle lento: durações x6, em loop
        manifest['pets']['codex'] = {'name': 'Codex', 'cell': {'w': 192, 'h': 208}, 'filter': 'linear',
                                     'sizing': 'fitWidth', 'states': states}
    with open(os.path.join(OUT, 'manifest.json'), 'w') as fh:
        json.dump(manifest, fh, indent=1)
    print('manifest.json ok')


if __name__ == '__main__':
    main()
