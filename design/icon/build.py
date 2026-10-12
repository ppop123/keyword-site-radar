# 新词新站点点通 插件图标：由 gpt/ring-dot-0.png（美术顾问 10-12 选的）生成 16/32/48/128。
# 32/48/128：原图去掉白色方底（从角上泛洪成透明，环内的白不受影响），128 按 Chrome 规范留 16px 透明边。
# 16：按原图几何重画（美术顾问：16px 去掉红点、橙点放大），先画 64px 再缩，边缘更顺。
import subprocess, pathlib
HERE = pathlib.Path(__file__).parent
OUT = HERE.parent.parent / 'extension' / 'icons'
OUT.mkdir(exist_ok=True)
src = HERE / 'gpt' / 'ring-dot-0.png'
cut = HERE / 'ring-cut.png'
run = lambda *a: subprocess.run(['magick', *map(str, a)], check=True)
run(src, '-alpha', 'set', '-fuzz', '18%', '-fill', 'none', '-draw', 'color 2,2 floodfill', '-trim', '+repage', cut)
for size, inner in ((128, 96), (48, 46), (32, 31)):
    run(cut, '-filter', 'Lanczos', '-resize', f'{inner}x{inner}', '-background', 'none', '-gravity', 'center',
        '-extent', f'{size}x{size}', '-strip', OUT / f'icon{size}.png')
# 16px：64px 画布上画，颜色取自原图
BLUE, ORANGE = '#1951E1', '#F59E0B'
c, R, ring = 32, 30, 8           # 圆心、外半径、环宽
r_mid, r_in = R - ring / 2, R - ring
wedge_r = r_in - 2.5
big = HERE / 'icon16-64.png'
run('-size', '64x64', 'xc:none',
    '-fill', 'white', '-draw', f'circle {c},{c} {c + r_in},{c}',
    '-fill', 'none', '-stroke', BLUE, '-strokewidth', ring, '-draw', f'circle {c},{c} {c + r_mid},{c}',
    '-stroke', 'none', '-fill', BLUE, '-draw', f'path "M {c},{c} L {c},{c - wedge_r} A {wedge_r},{wedge_r} 0 0,1 {c + wedge_r * 0.866:.2f},{c - wedge_r * 0.5:.2f} Z"',
    '-fill', BLUE, '-draw', f'circle {c},{c} {c + 4},{c}',
    '-fill', ORANGE, '-draw', f'circle {c + 8.5:.1f},{c - 10.5:.1f} {c + 8.5 + 5.5:.1f},{c - 10.5:.1f}',
    big)
run(big, '-filter', 'Lanczos', '-resize', '16x16', '-strip', OUT / 'icon16.png')
print('wrote', sorted(p.name for p in OUT.glob('icon*.png')))
