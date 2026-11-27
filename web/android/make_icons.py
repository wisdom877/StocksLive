#!/usr/bin/env python3
"""生成 APK 图标：蓝色圆角方块 + 白色上升折线。纯标准库输出 PNG。"""
import os
import struct
import zlib


def png(path, size, pixels):
    raw = b"".join(b"\x00" + bytes([c for p in pixels[y] for c in p]) for y in range(size))

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    data = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))
    with open(path, "wb") as f:
        f.write(data)


def make(size):
    # 背景：圆角方块 + 渐变
    px = [[(0, 0, 0, 0)] * size for _ in range(size)]
    r = size * 0.22
    for y in range(size):
        for x in range(size):
            dx = max(r - x, x - (size - 1 - r), 0)
            dy = max(r - y, y - (size - 1 - r), 0)
            if (dx * dx + dy * dy) ** 0.5 > r:
                continue
            t = y / max(size - 1, 1)
            px[y][x] = (int(10 + 6 * t), int(120 + 20 * t), 255, 255)
    # 白色折线
    pts = [(0.20, 0.72), (0.38, 0.56), (0.52, 0.63), (0.78, 0.30)]
    thick = max(size * 0.055, 2.5)
    segs = []
    for i in range(len(pts) - 1):
        p1 = (pts[i][0] * size, pts[i][1] * size)
        p2 = (pts[i + 1][0] * size, pts[i + 1][1] * size)
        segs.append((p1, p2))
    for y in range(size):
        for x in range(size):
            if px[y][x][3] == 0:
                continue
            hit = False
            for (x1, y1), (x2, y2) in segs:
                vx, vy = x2 - x1, y2 - y1
                wx, wy = x - x1, y - y1
                L2 = vx * vx + vy * vy
                t = max(0.0, min(1.0, (wx * vx + wy * vy) / L2)) if L2 else 0
                d = ((wx - t * vx) ** 2 + (wy - t * vy) ** 2) ** 0.5
                if d <= thick / 2:
                    hit = True
                    break
            if hit:
                px[y][x] = (255, 255, 255, 255)
    # 端点圆点
    cx, cy = pts[-1][0] * size, pts[-1][1] * size
    rr = thick * 1.25
    for y in range(max(0, int(cy - rr)), min(size, int(cy + rr) + 1)):
        for x in range(max(0, int(cx - rr)), min(size, int(cx + rr) + 1)):
            if px[y][x][3] and (x - cx) ** 2 + (y - cy) ** 2 <= rr * rr:
                px[y][x] = (255, 255, 255, 255)
    return px


BASE = os.path.dirname(os.path.abspath(__file__))
for folder, size in [("mipmap-mdpi", 48), ("mipmap-hdpi", 72), ("mipmap-xhdpi", 96),
                     ("mipmap-xxhdpi", 144), ("mipmap-xxxhdpi", 192)]:
    d = os.path.join(BASE, "res", folder)
    os.makedirs(d, exist_ok=True)
    png(os.path.join(d, "ic_launcher.png"), size, make(size))
    print("icon", folder, size)
