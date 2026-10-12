# 新词雷达 插件图标：gpt-image-2.5（APIMart）出图。用法：python3 gen.py [概念名 ...]
# 结果存在 gpt/<概念>-0.png，task JSON 里有 data.cost（美元）
import json, re, sys, time, urllib.request, pathlib
KEY = re.search(r'APIMART_API_KEY=\s*["\']?([^"\'\s]+)', pathlib.Path.home().joinpath('.config/pdoomvideo/apimart.env').read_text()).group(1)
OUT = pathlib.Path(__file__).parent / 'gpt'
BASE = ("Square app icon for a Chrome extension called 'Keyword Radar' that spots newly emerging search keywords and newly registered domains. "
        "Flat vector style, crisp geometric shapes, rounded-square tile filling the canvas, centered composition with generous margin, "
        "bold and simple so it stays readable at 16 pixels. Palette only: royal blue #1D4ED8, deep navy #101828, white, amber orange #F59E0B, signal red #C8261C. "
        "Strictly NO text, NO letters, NO numbers, NO mockup, NO drop shadow under the tile, NO gradients except a very subtle one on the tile, NO 3D, NO sparkles or stars. ")
CONCEPTS = {
  'blips': "Design: royal blue tile. In white: two concentric quarter-circle radar arcs and a solid radar sweep wedge fanning out from the lower-left corner. "
           "Inside the sweep, one amber orange dot and one smaller signal red dot, like targets just detected.",
  'navy-sweep': "Design: deep navy tile. A circular radar screen in royal blue with one thin white ring and crosshair lines, a bright white sweep line from the center, "
                "and a single amber orange glowing blip right at the leading edge of the sweep.",
  'ring-dot': "Design: white tile. A thick royal blue ring like a radar scope, a royal blue sweep wedge from the center to the upper right, "
              "and one solid signal red dot plus one amber orange dot on the wedge. Very minimal, only 3-4 shapes.",
}
def post(path, body):
    req = urllib.request.Request('https://api.apimart.ai' + path, data=json.dumps(body).encode(),
        headers={'Authorization': f'Bearer {KEY}', 'Content-Type': 'application/json'})
    return json.load(urllib.request.urlopen(req, timeout=60))
def get(path):
    req = urllib.request.Request('https://api.apimart.ai' + path, headers={'Authorization': f'Bearer {KEY}'})
    return json.load(urllib.request.urlopen(req, timeout=30))
names = sys.argv[1:] or list(CONCEPTS)
tasks = {}
for name in names:
    r = post('/v1/images/generations', {'model': 'gpt-image-2.5-sunburst', 'prompt': BASE + CONCEPTS[name],
             'size': '1:1', 'resolution': '1k', 'quality': 'high', 'n': 1, 'output_format': 'png'})
    tasks[name] = r['data'][0]['task_id']; print('submitted', name, flush=True)
pending, cost, t0 = dict(tasks), 0.0, time.time()
while pending and time.time() - t0 < 600:
    time.sleep(8)
    for name, tid in list(pending.items()):
        d = get(f'/v1/tasks/{tid}')
        st = d.get('data', {}).get('status')
        if st in ('completed', 'succeeded', 'success', 'failed'):
            pending.pop(name)
            (OUT / f'{name}.task.json').write_text(json.dumps(d, indent=1))
            cost += float(d.get('data', {}).get('cost') or 0)
            urls = re.findall(r'https://[^"\s]+?\.(?:png|jpg|jpeg|webp)[^"\s]*', json.dumps(d))
            print(name, st, flush=True)
            for i, u in enumerate(dict.fromkeys(urls)):
                p = OUT / f'{name}-{i}.png'; p.write_bytes(urllib.request.urlopen(u, timeout=120).read()); print('  saved', p.name)
print(f'cost ${cost:.3f}; still pending: {list(pending)}')
