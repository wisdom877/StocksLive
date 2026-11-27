#!/usr/bin/env python3
"""清理 style.css 里「全项目再没有任何地方用到」的规则。在 stock-site/ 目录下跑：

    python3 ../tools/clean_css.py            # 只报告，不改文件
    python3 ../tools/clean_css.py --apply    # 落盘（先备份到 /tmp/style.css.before-clean）

判定（保守，宁可漏删不可误删）：
- 选择器主体 = 最左边的 .class / #id。名字在「static/index.html + static/app-*.js 全文」里一次都不出现才算死。
- 名字可能是「前缀 + ${…} / '…' + 变量」在 JS 里拼出来的（mk-${k}、wk-rk-${kind}）→ 保留。
- 名字以 -数字 结尾（运行期生成的序号）→ 保留。
- 逗号分组的选择器逐个判定：全死删整条，部分死只摘掉死的那几个。
- @media / @supports 递归处理；清空的块整个删掉。@keyframes、@font-face 不动。
"""
from __future__ import annotations

import glob
import re
import shutil
import sys
from pathlib import Path

STATIC = Path(__file__).resolve().parent.parent / "web" / "static"
CSS = STATIC / "style.css"
DYNAMIC_TAIL = re.compile(r"(\$\{|'\s*\+|\"\s*\+|`\s*\+)")   # 前缀后面紧跟拼接 → 运行期生成


def haystack() -> tuple[str, set[str]]:
    parts = [(STATIC / "index.html").read_text(encoding="utf-8")]
    parts += [Path(f).read_text(encoding="utf-8") for f in sorted(glob.glob(str(STATIC / "app-*.js")))]
    text = "\n".join(parts)
    return text, set(re.findall(r"[A-Za-z_][\w-]*", text))


def subject(selector: str) -> str | None:
    """选择器主体：最左边那个 .class / #id 的名字。"""
    m = re.search(r"[.#](-?[A-Za-z_][\w-]*)", selector)
    return m.group(1) if m else None


def possibly_dynamic(name: str, js: str) -> bool:
    if re.search(r"-\d+$", name):
        return True
    for i in range(len(name) - 1, 0, -1):
        if name[i] == "-":
            if re.search(re.escape(name[: i + 1]) + DYNAMIC_TAIL.pattern, js):
                return True
    return False


def dead_name(name: str, words: set[str], js: str) -> bool:
    return name not in words and not possibly_dynamic(name, js)


def selector_dead(selector: str, words: set[str], js: str) -> bool:
    s = selector.strip()
    if s.startswith("@") or not s:
        return False
    name = subject(s)
    return name is not None and dead_name(name, words, js)


def split_rules(block: str) -> list[tuple[str, str, bool]]:
    """把一段 CSS 文本切成 [(头, 花括体, 是不是一条规则)]，头里保留原有空白与注释。"""
    out, i, n = [], 0, len(block)
    while i < n:
        brace = block.find("{", i)
        if brace == -1:
            if block[i:].strip():
                out.append((block[i:], "", False))   # 文件尾部没有规则的注释 / 空白
            break
        head = block[i:brace]
        depth, j = 1, brace + 1
        while j < n and depth:
            if block[j] == "{":
                depth += 1
            elif block[j] == "}":
                depth -= 1
            j += 1
        out.append((head, block[brace + 1 : j - 1], True))
        i = j
    return out


AT_KEEP = ("@keyframes", "@font-face", "@charset", "@import", "@property")


def clean(block: str, words: set[str], js: str, stats: dict) -> str:
    out = []
    for head, body, is_rule in split_rules(block):
        h = head.strip()
        if not is_rule:
            out.append(head)                       # 文件头/尾部纯空白与注释，原样保留
            continue
        if h.startswith(AT_KEEP):
            out.append(f"{head}{{{body}}}")
            continue
        if h.startswith("@"):
            inner = clean(body, words, js, stats)
            if inner.strip():
                out.append(f"{head}{{{inner}}}")
            else:
                stats["blocks"] += 1
            continue
        # 普通规则：head = 前导空白 + 注释? + 「选择器, 选择器…」
        cm = re.match(r"(\s*)(/\*[\s\S]*?\*/\s*)?(.*)$", head, re.S)
        lead, comment, sel = cm.group(1), cm.group(2) or "", cm.group(3)
        parts = sel.split(",")
        alive = [p for p in parts if not selector_dead(p, words, js)]
        if not alive:
            stats["rules"] += 1
            stats["lines"] += (sel + body).count("\n") + 1
            continue
        if len(alive) == len(parts):
            out.append(f"{head}{{{body}}}")        # 没动到，原文一字不改
            continue
        stats["selectors"] += len(parts) - len(alive)
        out.append(f"{lead}{comment}{', '.join(p.strip() for p in alive)} {{{body}}}")
    text = "".join(out)
    return re.sub(r"\n{3,}", "\n\n", text)


AT_KEEP = ("@keyframes", "@font-face", "@charset", "@import", "@property")

def main() -> None:
    apply = "--apply" in sys.argv
    hay, words = haystack()
    text = CSS.read_text(encoding="utf-8")
    stats = {"rules": 0, "selectors": 0, "blocks": 0, "lines": 0}
    cleaned = clean(text, words, hay, stats)
    print(f"整条删除的规则 {stats['rules']} 条（约 {stats['lines']} 行），摘掉的选择器 {stats['selectors']} 个，"
          f"清空后删掉的 @media 块 {stats['blocks']} 个")
    print(f"行数 {text.count(chr(10))} → {cleaned.count(chr(10))}；花括号 {text.count('{')}/{text.count('}')} → "
          f"{cleaned.count('{')}/{cleaned.count('}')}")
    if not apply:
        print("（仅报告；加 --apply 落盘）")
        return
    shutil.copy2(CSS, "/tmp/style.css.before-clean")
    CSS.write_text(cleaned, encoding="utf-8")
    print(f"已写入 {CSS}，原文件备份在 /tmp/style.css.before-clean")


if __name__ == "__main__":
    main()
