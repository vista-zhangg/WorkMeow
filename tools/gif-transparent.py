#!/usr/bin/env python3
"""把纯色背景的 GIF 转成透明背景 GIF，并可直接安装为打工喵的状态素材。

为什么不能"把所有白像素变透明"
------------------------------------
表情包里猫自己往往也有白色（肚皮、高光、白色马克杯）。逐像素阈值会把这些
一起抠掉，留下一只破洞猫。本脚本改为**从画布四边做连通域漫填**：只有与边缘
连通的背景色区域才会变透明，猫身体内部的白色被完整保留。

GIF 只有 1-bit 透明（要么全透明要么全不透明，没有半透明），所以抗锯齿边缘
会残留一圈背景色白边。--shrink 通过腐蚀 alpha 边缘若干像素来消除它。

用法
----
  # 预览单个文件的转换效果（输出到 tools/_preview/）
  python tools/gif-transparent.py in.gif

  # 转换并直接安装为某个状态的素材（写入 assets/cat/cat-<state>.gif）
  python tools/gif-transparent.py in.gif --install working-5

  # 批量转换一个目录
  python tools/gif-transparent.py ./raw/ --outdir ./out/

  # 背景不是自动识别的那个色 / 边缘毛刺重
  python tools/gif-transparent.py in.gif --bg "#00FF00" --tol 60 --shrink 2
"""

import argparse
import os
import sys
from collections import Counter

try:
    import numpy as np
    from PIL import Image, ImageSequence
except ImportError:
    sys.exit(
        "缺少依赖。请先安装：\n"
        "  python -m pip install Pillow numpy"
    )

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CAT_DIR = os.path.join(PROJECT_ROOT, "assets", "cat")

# 项目现有素材的统一规格（由 assets/cat/*.gif 实测得出）
TARGET_SIZE = 120
TRANSPARENT_INDEX = 255
PALETTE_COLORS = 255  # 0..254 给图像，255 留给透明


def load_frames(path):
    """读出所有帧的 RGBA 数组 + 帧延时(ms) + 循环次数。

    Pillow 的 seek 会自动按 disposal method 合成，得到的是"该帧完整画面"，
    而不是增量差分块 —— 这正是我们需要的。
    """
    im = Image.open(path)
    frames, delays = [], []
    for frame in ImageSequence.Iterator(im):
        frames.append(np.array(frame.convert("RGBA"), dtype=np.uint8))
        delays.append(frame.info.get("duration", 80) or 80)
    loop = im.info.get("loop", 0)
    return frames, delays, loop


def detect_bg_color(rgba):
    """从四条边的像素里取众数作为背景色。

    比只取四角稳健：某些表情包角落会有装饰或阴影。
    """
    h, w = rgba.shape[:2]
    border = np.concatenate([
        rgba[0, :, :3], rgba[h - 1, :, :3],
        rgba[:, 0, :3], rgba[:, w - 1, :3],
    ])
    counts = Counter(map(tuple, border))
    return np.array(counts.most_common(1)[0][0], dtype=np.int16)


def flood_from_border(similar):
    """从画布四边出发，返回与边缘连通的 True 区域。

    similar: bool 数组，True = 颜色接近背景色。
    用 numpy 切片做迭代膨胀，避免 Python 层逐像素 BFS 的性能塌方。
    """
    reached = np.zeros_like(similar)
    reached[0, :] = similar[0, :]
    reached[-1, :] = similar[-1, :]
    reached[:, 0] = similar[:, 0]
    reached[:, -1] = similar[:, -1]

    while True:
        grown = reached.copy()
        grown[1:, :] |= reached[:-1, :]   # 向下
        grown[:-1, :] |= reached[1:, :]   # 向上
        grown[:, 1:] |= reached[:, :-1]   # 向右
        grown[:, :-1] |= reached[:, 1:]   # 向左
        grown &= similar
        if np.array_equal(grown, reached):
            return reached
        reached = grown


def erode(mask, n):
    """把 True 区域向内收缩 n 圈（用于削掉抗锯齿白边）。"""
    for _ in range(n):
        m = mask.copy()
        m[1:, :] &= mask[:-1, :]
        m[:-1, :] &= mask[1:, :]
        m[:, 1:] &= mask[:, :-1]
        m[:, :-1] &= mask[:, 1:]
        mask = m
    return mask


def cut_background(rgba, bg, tol, shrink):
    """返回 alpha 已抠好的 RGBA 数组，以及被抠掉的像素占比。"""
    rgb = rgba[:, :, :3].astype(np.int16)
    # 曼哈顿距离比欧氏快且对 JPEG 压缩噪点同样够用
    dist = np.abs(rgb - bg.reshape(1, 1, 3)).sum(axis=2)
    similar = dist <= tol

    bg_mask = flood_from_border(similar)
    if shrink > 0:
        # 收缩"前景"等价于膨胀"背景"：把边缘那圈混色像素也算进背景
        fg = ~bg_mask
        fg = erode(fg, shrink)
        bg_mask = ~fg

    out = rgba.copy()
    out[:, :, 3] = np.where(bg_mask, 0, 255).astype(np.uint8)
    return out, float(bg_mask.mean())


def to_paletted(rgba):
    """RGBA → P 模式，索引 255 固定为透明色。"""
    alpha = rgba[:, :, 3]
    rgb = Image.fromarray(rgba[:, :, :3], mode="RGB")
    # 只用 255 色，把最后一个索引留给透明
    pal = rgb.quantize(colors=PALETTE_COLORS, method=Image.Quantize.MEDIANCUT)
    idx = np.array(pal, dtype=np.uint8)
    idx[alpha == 0] = TRANSPARENT_INDEX

    out = Image.fromarray(idx, mode="P")
    palette = pal.getpalette()[: PALETTE_COLORS * 3]
    palette += [0, 0, 0]  # 索引 255 的颜色值无所谓，它被标记为透明
    out.putpalette(palette)
    return out


def resize_rgba(rgba, size):
    if rgba.shape[0] == size and rgba.shape[1] == size:
        return rgba
    im = Image.fromarray(rgba, mode="RGBA").resize((size, size), Image.LANCZOS)
    arr = np.array(im, dtype=np.uint8)
    # LANCZOS 会产生半透明边缘，GIF 存不下 → 二值化
    arr[:, :, 3] = np.where(arr[:, :, 3] >= 128, 255, 0).astype(np.uint8)
    return arr


def convert(src, dst, bg_hex=None, tol=40, shrink=1, size=TARGET_SIZE, quiet=False):
    frames, delays, loop = load_frames(src)
    if not frames:
        raise ValueError(f"读不到帧：{src}")

    if bg_hex:
        h = bg_hex.lstrip("#")
        bg = np.array([int(h[i:i + 2], 16) for i in (0, 2, 4)], dtype=np.int16)
        bg_src = "手动指定"
    else:
        bg = detect_bg_color(frames[0])
        bg_src = "自动识别"

    out_frames, ratios = [], []
    for f in frames:
        cut, ratio = cut_background(f, bg, tol, shrink)
        ratios.append(ratio)
        out_frames.append(to_paletted(resize_rgba(cut, size)))

    os.makedirs(os.path.dirname(os.path.abspath(dst)), exist_ok=True)
    out_frames[0].save(
        dst,
        save_all=True,
        append_images=out_frames[1:],
        duration=delays,
        loop=loop,
        transparency=TRANSPARENT_INDEX,
        disposal=2,          # 每帧前清回背景，避免透明区域拖影
        optimize=False,      # optimize 会重排调色板，破坏固定的透明索引
    )

    avg = sum(ratios) / len(ratios)
    if not quiet:
        kb = os.path.getsize(dst) / 1024
        print(f"  背景色 {bg_src}: RGB{tuple(int(x) for x in bg)}  容差={tol}  收边={shrink}px")
        print(f"  {len(frames)} 帧 → {size}x{size}   抠除面积 {avg * 100:.1f}%   {kb:.1f} KB")
        if avg < 0.05:
            print("  ⚠ 抠除面积过小，背景可能没识别对 —— 试试 --bg 手动指定或调大 --tol")
        elif avg > 0.85:
            print("  ⚠ 抠除面积过大，可能连主体一起抠了 —— 试试调小 --tol")
    return avg


def main():
    ap = argparse.ArgumentParser(
        description="纯色背景 GIF → 透明背景 GIF（打工喵素材工具）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("src", help="输入 GIF 文件或目录")
    ap.add_argument("--install", metavar="STATE",
                    help="转换后直接安装为 assets/cat/cat-<STATE>.gif，例如 working-5")
    ap.add_argument("--outdir", help="输出目录（默认 tools/_preview/）")
    ap.add_argument("--bg", help="手动指定背景色，如 '#FFFFFF'；不给则自动识别")
    ap.add_argument("--tol", type=int, default=40,
                    help="颜色容差 0-765，默认 40。背景有渐变/噪点就调大")
    ap.add_argument("--shrink", type=int, default=1,
                    help="向内收边像素数，默认 1。残留白边就调到 2")
    ap.add_argument("--size", type=int, default=TARGET_SIZE,
                    help=f"输出边长，默认 {TARGET_SIZE}（与现有素材一致）")
    args = ap.parse_args()

    if args.install and os.path.isdir(args.src):
        sys.exit("--install 只能用于单个文件")

    outdir = args.outdir or os.path.join(PROJECT_ROOT, "tools", "_preview")

    if os.path.isdir(args.src):
        srcs = [os.path.join(args.src, f) for f in sorted(os.listdir(args.src))
                if f.lower().endswith(".gif")]
        if not srcs:
            sys.exit(f"目录里没有 GIF：{args.src}")
    else:
        srcs = [args.src]

    for src in srcs:
        name = os.path.basename(src)
        if args.install:
            dst = os.path.join(CAT_DIR, f"cat-{args.install}.gif")
        else:
            dst = os.path.join(outdir, name)
        print(f"\n{name}")
        try:
            convert(src, dst, args.bg, args.tol, args.shrink, args.size)
            print(f"  → {dst}")
        except Exception as exc:
            print(f"  ✗ 失败：{exc}")

    if args.install:
        print(f"\n素材已安装。别忘了在 renderer/pet.js 里登记："
              f"\n  CAT_STATES 或 CAT_POOLS 中加入 'cat-{args.install}.gif'")
    else:
        print(f"\n预览产物在 {outdir}")
        print("确认效果后再用 --install <state> 正式安装。")


if __name__ == "__main__":
    main()
