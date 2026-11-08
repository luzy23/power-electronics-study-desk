#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""构建回归校验：检查 data/book.json 与 data/sections/*.json 的构建结果。

用法::

    python tools/verify_book.py            # 完整报告
    python tools/verify_book.py --quiet    # 只输出 FAIL / WARN 与汇总
    python tools/verify_book.py --json     # 以 JSON 输出结果

退出码：0 = 没有 FAIL（WARN 不影响退出码）；1 = 存在 FAIL。
本脚本只读 data/ 下的文件，不做任何修改。
"""
from __future__ import annotations

import argparse
import json
import math
import re
import sys
import unicodedata
from pathlib import Path

# ---------------------------------------------------------------------------
# 路径与常量
# ---------------------------------------------------------------------------

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
SECTIONS_DIR = DATA_DIR / "sections"
BOOK_PATH = DATA_DIR / "book.json"
BASELINE_PATH = DATA_DIR / "_build_report.json"

IMG_X_MAX = 620.0          # PDF 页面宽度约 504pt，留出裁切余量
IMG_Y_MAX = 820.0
TITLE_WINDOW = 8000        # 只在 text 的前 8000 字符里找小节标题
TITLE_NEEDLE = 20          # 标题前 20 个字符
LONG_DUP_MIN = 40          # 未显示的长段落重复（>= 40 字符）也算提取 bug

PROBLEM_NUM_RE = re.compile(r"^(\d+)\.(\d+)\s")
REF_PREFIX_RE = re.compile(r"Fig\.|Eq\.|Problem|Table|Section|Chap\.")
# 紧挨在题号前面的引用前缀，如 "Fig. 4.2"
REF_BEFORE_RE = re.compile(r"(?:Fig|Eq|Table|Section|Chap|Problem)\.\s*$")

# 跟在 "x.y" 之后、表示物理单位的词（用于排除 "3.3 V" 这类数值）
UNIT_WORDS = {
    "V", "mV", "kV", "A", "mA", "µA", "uA", "W", "mW", "kW", "MW",
    "Ω", "kΩ", "MΩ", "ohm", "ohms", "Hz", "kHz", "MHz", "GHz",
    "F", "mF", "µF", "uF", "nF", "pF", "H", "mH", "µH", "uH",
    "s", "ms", "µs", "us", "ns", "°C", "K", "%", "cm", "mm",
    "m", "km", "g", "kg", "J", "N", "VA", "kVA", "A/s", "V/s",
    "W/A", "V/A", "rpm", "dB", "Vdc", "Vac", "Adc",
}


# ---------------------------------------------------------------------------
# 小工具
# ---------------------------------------------------------------------------

def _setup_stdout() -> None:
    """避免 Windows 控制台 GBK 编码遇到 Ć / – / ∞ 等字符时抛异常。"""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass


def _load_json(path: Path):
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def _is_int(value) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _is_number(value) -> bool:
    return (isinstance(value, (int, float))
            and not isinstance(value, bool)
            and math.isfinite(float(value)))


def _norm_compact(text: str) -> str:
    """标题匹配用的归一化：大小写、全半角、空白、软连字符都不计较。"""
    text = unicodedata.normalize("NFKC", text).lower()
    text = text.replace("\u00ad", "")
    return re.sub(r"\s+", "", text)


def _short(text, limit: int = 70) -> str:
    text = re.sub(r"\s+", " ", str(text)).strip()
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _looks_like_prose(text: str) -> bool:
    """是否是正文段落（至少 3 个小写单词）。

    图轴标签（"1 Hz 10 Hz …"）和公式碎片（"2 Js + π …"）不是正文，
    相邻两图出现同样的坐标轴文字属于正常现象，不算重复段落。
    """
    words = re.findall(r"[A-Za-z][A-Za-z'\-]*", text)
    return sum(1 for word in words if len(word) >= 3 and word.islower()) >= 3


def _pad(label: str, width: int = 20) -> str:
    return label + " " + "." * max(3, width - len(label) - 1)


# ---------------------------------------------------------------------------
# 报告
# ---------------------------------------------------------------------------

class Report:
    def __init__(self) -> None:
        self.fails: list[dict] = []
        self.warns: list[dict] = []
        self.counts = {"sections": 0, "problems": 0, "chapters": 0, "images": 0}
        self.baseline: dict = {"present": False}

    # -- 记录 ---------------------------------------------------------------
    def fail(self, category: str, where: str, message: str) -> None:
        self.fails.append({"category": category, "where": where, "message": message})

    def warn(self, category: str, where: str, message: str) -> None:
        self.warns.append({"category": category, "where": where, "message": message})

    # -- 查询 ---------------------------------------------------------------
    def entries(self, kind: str, category: str | None = None) -> list[dict]:
        source = self.fails if kind == "fail" else self.warns
        if category is None:
            return source
        return [entry for entry in source if entry["category"] == category]

    def status(self, category: str) -> str:
        if self.entries("fail", category):
            return "FAIL"
        if self.entries("warn", category):
            return "WARN"
        return "PASS"

    def detail(self, category: str) -> str:
        status = self.status(category)
        if status == "FAIL":
            return f"({len(self.entries('fail', category))} 项失败)"
        if status == "WARN":
            return f"({len(self.entries('warn', category))} 个警告)"
        if category == "sections":
            return f"({self.counts['sections']} 个)"
        if category == "problems":
            return f"({self.counts['problems']} 个)"
        if category == "chapters":
            return f"({self.counts['chapters']} 章)"
        return ""

    def entry_text(self, entry: dict) -> str:
        where, message = entry["where"], entry["message"]
        return f"{where}: {message}" if where else message


# ---------------------------------------------------------------------------
# 通用：items / 图片坐标
# ---------------------------------------------------------------------------

def _check_img(it: dict) -> tuple[bool, str]:
    for key in ("x0", "y0", "x1", "y1"):
        if key not in it:
            return False, f"img 缺少坐标字段 {key}"
        if not _is_number(it[key]):
            return False, f"img.{key} 不是数字: {it[key]!r}"
    x0, y0, x1, y1 = (float(it[k]) for k in ("x0", "y0", "x1", "y1"))
    if not (0.0 <= x0 < x1 <= IMG_X_MAX):
        return False, f"img x 坐标非法: x0={x0:g}, x1={x1:g}（要求 0≤x0<x1≤{IMG_X_MAX:g}）"
    if not (0.0 <= y0 < y1 <= IMG_Y_MAX):
        return False, f"img y 坐标非法: y0={y0:g}, y1={y1:g}（要求 0≤y0<y1≤{IMG_Y_MAX:g}）"
    return True, ""


def _check_items(report: Report, category: str, where: str,
                 items, paras) -> tuple[list[int], list[tuple[int, dict]]]:
    """校验 items；返回 (已引用的 paras 下标列表, [(item 下标, img), ...])。"""
    displayed: list[int] = []
    imgs: list[tuple[int, dict]] = []
    para_count = len(paras) if isinstance(paras, list) else 0

    if not isinstance(items, list):
        report.fail(category, where, "items 不是数组")
        return displayed, imgs

    seen: set[int] = set()
    for pos, it in enumerate(items):
        if not isinstance(it, dict):
            report.fail(category, where, f"items[{pos}] 不是对象")
            continue
        kind = it.get("t")
        if kind == "p":
            idx = it.get("i")
            if not _is_int(idx):
                report.fail(category, where, f"items[{pos}].i 不是整数: {idx!r}")
                continue
            if not (0 <= idx < para_count):
                report.fail(category, where,
                            f"items[{pos}].i={idx} 超出 paras 下标范围 0..{para_count - 1}")
                continue
            if idx in seen:
                # 同一个段落被引用两次 → 页面上会出现重复文本
                report.fail(category, where,
                            f"同一段落被多个 p item 引用: para[{idx}]")
                continue
            seen.add(idx)
            displayed.append(idx)
        elif kind == "img":
            ok, msg = _check_img(it)
            if not ok:
                report.fail(category, where, f"items[{pos}]: {msg}")
                continue
            if "page" in it and not _is_int(it["page"]):
                report.fail(category, where, f"items[{pos}].page 不是整数: {it.get('page')!r}")
                continue
            imgs.append((pos, it))
        else:
            report.fail(category, where, f"items[{pos}].t 未知: {kind!r}")

    report.counts["images"] += len(imgs)
    return displayed, imgs


def _overlap_ratio(a: dict, b: dict) -> float:
    """两张图（同一页）的交集面积 / 较小图面积。"""
    inter_w = max(0.0, min(float(a["x1"]), float(b["x1"])) - max(float(a["x0"]), float(b["x0"])))
    inter_h = max(0.0, min(float(a["y1"]), float(b["y1"])) - max(float(a["y0"]), float(b["y0"])))
    area_a = (float(a["x1"]) - float(a["x0"])) * (float(a["y1"]) - float(a["y0"]))
    area_b = (float(b["x1"]) - float(b["x0"])) * (float(b["y1"]) - float(b["y0"]))
    smaller = min(area_a, area_b)
    if smaller <= 0:
        return 0.0
    return (inter_w * inter_h) / smaller


# ---------------------------------------------------------------------------
# 1. book.json 结构
# ---------------------------------------------------------------------------

def _iter_chapters(book: dict):
    for part in book.get("parts") or []:
        if not isinstance(part, dict):
            continue
        for chapter in part.get("chapters") or []:
            if isinstance(chapter, dict):
                yield chapter


def _iter_sections(book: dict):
    for chapter in _iter_chapters(book):
        for section in chapter.get("sections") or []:
            if isinstance(section, dict):
                yield chapter, section


def check_book(report: Report, book: dict) -> bool:
    """返回 parts/chapters 是否可用（可用才继续做后续检查）。"""
    category = "book"
    pdf_pages = book.get("pdfPages")
    if not _is_int(pdf_pages) or pdf_pages <= 0:
        report.fail(category, "", f"pdfPages 非法: {pdf_pages!r}")

    parts = book.get("parts")
    if not isinstance(parts, list) or not parts:
        report.fail(category, "", "parts 为空或不是数组")
        return False

    ok = True
    chapter_total = 0
    for pi, part in enumerate(parts):
        if not isinstance(part, dict):
            report.fail(category, "", f"parts[{pi}] 不是对象")
            ok = False
            continue
        chapters = part.get("chapters")
        if not isinstance(chapters, list) or not chapters:
            report.fail(category, part.get("id") or f"parts[{pi}]", "chapters 为空或不是数组")
            ok = False
            continue
        for ci, chapter in enumerate(chapters):
            chapter_total += 1
            if not isinstance(chapter, dict):
                report.fail(category, "", f"parts[{pi}].chapters[{ci}] 不是对象")
                ok = False
                continue
            cid = chapter.get("id") or f"parts[{pi}].chapters[{ci}]"
            if not _is_int(chapter.get("page")):
                report.fail(category, cid, f"缺少有效 page: {chapter.get('page')!r}")
            sections = chapter.get("sections")
            if not isinstance(sections, list):
                report.fail(category, cid, "sections 不是数组")
                ok = False
                continue
            pages: list[int] = []
            for si, section in enumerate(sections):
                if not isinstance(section, dict):
                    report.fail(category, cid, f"sections[{si}] 不是对象")
                    continue
                page = section.get("page")
                if not _is_int(page):
                    report.fail(category, cid,
                                f"section[{si}]（{section.get('id')!r}）缺少有效 page: {page!r}")
                    continue
                pages.append(page)
            if pages != sorted(pages):
                report.fail(category, cid, "sections 未按 page 非降序排列")

    report.counts["chapters"] = chapter_total
    return ok


# ---------------------------------------------------------------------------
# 2. 普通小节
# ---------------------------------------------------------------------------

def _check_section_file(report: Report, section: dict, next_section: dict | None) -> None:
    category = "sections"
    sid = section.get("id")
    if not isinstance(sid, str) or not sid:
        report.fail(category, "", "book.json 中有 section 缺少 id")
        return
    report.counts["sections"] += 1

    path = SECTIONS_DIR / f"{sid}.json"
    if not path.is_file():
        report.fail(category, sid, f"缺少文件 data/sections/{sid}.json")
        return
    try:
        data = _load_json(path)
    except Exception as exc:  # noqa: BLE001 - 校验脚本要把坏文件报出来
        report.fail(category, sid, f"JSON 读取失败: {exc}")
        return
    if not isinstance(data, dict):
        report.fail(category, sid, "JSON 顶层不是对象")
        return

    for key in ("id", "text", "paras", "items"):
        if key not in data:
            report.fail(category, sid, f"缺少必备字段 {key}")
    if "id" in data and data["id"] != sid:
        report.fail(category, sid, f"id 字段 {data['id']!r} 与文件名不一致")

    text = data.get("text")
    paras = data.get("paras")
    items = data.get("items")

    if not isinstance(text, str) or not text.strip():
        report.fail(category, sid, "text 为空或不是字符串")
    elif len(text) <= 200:
        report.fail(category, sid, f"text 长度 {len(text)} <= 200")
    if not isinstance(paras, list) or not paras:
        report.fail(category, sid, "paras 为空或不是数组")
    if not isinstance(items, list) or not items:
        report.fail(category, sid, "items 为空或不是数组")

    displayed, _imgs = _check_items(report, category, sid, items, paras)

    # 标题出现在 text 前 8000 字符内
    num = section.get("num")
    title = section.get("title")
    if isinstance(num, str) and num and isinstance(title, str) and title:
        full_title = f"{num} {title}"
        needle = _norm_compact(full_title[:TITLE_NEEDLE])
        haystack = _norm_compact(text[:TITLE_WINDOW]) if isinstance(text, str) else ""
        if not needle or needle not in haystack:
            report.warn(category, sid, f'找不到小节标题 "{full_title}"')
    else:
        report.warn(category, sid, "book.json 中缺少 num/title，无法校验标题")

    # 不应包含下一节标题作为独立段落开头
    if isinstance(paras, list) and isinstance(next_section, dict):
        next_num = next_section.get("num")
        if isinstance(next_num, str) and next_num:
            prefix = next_num + " "
            for pi, para in enumerate(paras):
                if isinstance(para, str) and para.lstrip().startswith(prefix):
                    report.fail(category, sid,
                                f'para[{pi}] 以下一节标题 "{next_num}" 开头: {_short(para)}')
                    break

    # 相邻段落完全相同
    if isinstance(paras, list):
        displayed_set = set(displayed)
        reported: set[tuple[int, int]] = set()
        for i in range(len(paras) - 1):
            first, second = paras[i], paras[i + 1]
            if not isinstance(first, str) or not first.strip() or first != second:
                continue
            # paras 里混有图轴标签 / 表格碎片 / 公式碎片（很多不显示、天然会重复），
            # 真正会造成「重复显示」或「重复原文」的只有：
            #   1) 两段都会显示、且是正文段落；
            #   2) 不显示的整段长文本重复（提取 bug）。
            both_visible = i in displayed_set and i + 1 in displayed_set
            if (both_visible and _looks_like_prose(first)) or len(first.strip()) >= LONG_DUP_MIN:
                report.fail(category, sid,
                            f"相邻段落重复: para[{i}] 与 para[{i + 1}] = {_short(first)}")
                reported.add((i, i + 1))

        # 显示流里紧挨着的两个正文段落（para 下标不一定相邻，中间不能隔图片）
        previous_p = None
        for item in items if isinstance(items, list) else []:
            if not isinstance(item, dict):
                continue
            if item.get("t") != "p":
                previous_p = None
                continue
            idx = item.get("i")
            if not _is_int(idx) or not (0 <= idx < len(paras)):
                previous_p = None
                continue
            if isinstance(previous_p, int):
                key = (min(previous_p, idx), max(previous_p, idx))
                current_text = paras[idx]
                previous_text = paras[previous_p]
                if (key not in reported
                        and isinstance(current_text, str)
                        and current_text.strip()
                        and current_text == previous_text
                        and _looks_like_prose(current_text)):
                    report.fail(category, sid,
                                f"相邻显示段落重复: para[{previous_p}] 与 para[{idx}] = "
                                f"{_short(current_text)}")
            previous_p = idx


def check_sections(report: Report, book: dict) -> None:
    for chapter in _iter_chapters(book):
        sections = [s for s in (chapter.get("sections") or []) if isinstance(s, dict)]
        for idx, section in enumerate(sections):
            next_section = sections[idx + 1] if idx + 1 < len(sections) else None
            _check_section_file(report, section, next_section)


# ---------------------------------------------------------------------------
# 3. 习题
# ---------------------------------------------------------------------------

def _followed_by_unit(para: str, match: re.Match) -> bool:
    """判断一个 "x.y" 后面跟的是不是物理单位（如 "3.3 V"）。"""
    word_match = re.match(r"\s+([A-Za-zµμΩ°%]+)", para[match.end():])
    if not word_match:
        return False
    return word_match.group(1) in UNIT_WORDS


def _preceded_by_reference(para: str, match: re.Match) -> bool:
    return bool(REF_BEFORE_RE.search(para[max(0, match.start() - 24):match.start()]))


def _check_problem_numbers(report: Report, sid: str, chapter_num: int, paras: list) -> None:
    # 3.1 题号识别：段落开头 "4.1 " 且章节号与文件名一致
    numbers: list[tuple[int, int]] = []
    for pi, para in enumerate(paras):
        if not isinstance(para, str):
            continue
        match = PROBLEM_NUM_RE.match(para)
        if match and int(match.group(1)) == chapter_num:
            numbers.append((pi, int(match.group(2))))

    values = [value for _, value in numbers]
    if len(values) < 2:
        report.fail("problems", sid, f"识别到的题号不足 2 个: {values}")
    elif any(later <= earlier for earlier, later in zip(values, values[1:])):
        report.fail("problems", sid, f"题号未严格递增: {values}")

    # 3.2 一个段落里出现两个题号（中间没有图/公式/题目引用前缀）
    pattern = re.compile(r"(?:^|(?<=\s))" + str(chapter_num) + r"\.(\d+)(?=\s+[A-Z(])")
    for pi, para in enumerate(paras):
        if not isinstance(para, str):
            continue
        matches = list(pattern.finditer(para))
        if len(matches) < 2:
            continue
        kept = [m for m in matches
                if not _preceded_by_reference(para, m)
                and not (m.start() > 0 and _followed_by_unit(para, m))]
        if len(kept) < 2:
            continue
        region = para[kept[0].start():kept[-1].start()]
        if REF_PREFIX_RE.search(region):
            continue
        report.fail("problems", sid,
                    f"para[{pi}] 内疑似出现两个题号: {_short(para, 100)}")


def _check_problem_file(report: Report, path: Path) -> None:
    category = "problems"
    name = path.name
    matched = re.fullmatch(r"ch(\d+)-problems\.json", name)
    if not matched:
        report.fail(category, name, "文件名不符合 ch<N>-problems.json")
        return
    chapter_num = int(matched.group(1))
    report.counts["problems"] += 1

    try:
        data = _load_json(path)
    except Exception as exc:  # noqa: BLE001
        report.fail(category, name, f"JSON 读取失败: {exc}")
        return
    if not isinstance(data, dict):
        report.fail(category, name, "JSON 顶层不是对象")
        return

    for key in ("id", "text", "paras", "items"):
        if key not in data:
            report.fail(category, name, f"缺少必备字段 {key}")

    text = data.get("text")
    paras = data.get("paras")
    items = data.get("items")

    if not isinstance(text, str) or not text.strip():
        report.fail(category, name, "text 为空或不是字符串")
    elif not text.startswith("Problems"):
        report.warn(category, name, f'text 未以 "Problems" 开头: {_short(text, 50)}')
    if not isinstance(paras, list) or not paras:
        report.fail(category, name, "paras 为空或不是数组")
    if not isinstance(items, list) or not items:
        report.fail(category, name, "items 为空或不是数组")

    _displayed, imgs = _check_items(report, category, name, items, paras)

    # 同一页任意两张图的重叠面积不能超过较小图的 50%
    for i in range(len(imgs)):
        pos_a, img_a = imgs[i]
        if not _is_number(img_a.get("page")):
            continue
        for j in range(i + 1, len(imgs)):
            pos_b, img_b = imgs[j]
            if img_a.get("page") != img_b.get("page"):
                continue
            ratio = _overlap_ratio(img_a, img_b)
            if ratio > 0.5:
                report.fail(category, name,
                            f"图片疑似重复裁切: items[{pos_a}] 与 items[{pos_b}] "
                            f"重叠 {ratio:.0%}（超过较小图的 50%）")

    if isinstance(paras, list):
        _check_problem_numbers(report, name, chapter_num, paras)


def check_problems(report: Report, book: dict) -> None:
    category = "problems"
    # book.json 声明了 probsPage 的章必须有对应文件
    for chapter in _iter_chapters(book):
        if chapter.get("probsPage") is None:
            continue
        cid = chapter.get("id")
        if not isinstance(cid, str) or not cid:
            continue
        expected = SECTIONS_DIR / f"{cid}-problems.json"
        if not expected.is_file():
            report.fail(category, cid, f"book.json 声明了 probsPage，但缺少 {expected.name}")

    for path in sorted(SECTIONS_DIR.glob("*-problems.json")):
        _check_problem_file(report, path)


# ---------------------------------------------------------------------------
# 4. 每章
# ---------------------------------------------------------------------------

def _first_visible_para(section_id: str) -> str | None:
    """取小节文件中第一个会显示的段落文本。"""
    path = SECTIONS_DIR / f"{section_id}.json"
    try:
        data = _load_json(path)
    except Exception:  # noqa: BLE001 - 文件问题会在 sections 检查里报
        return None
    paras, items = data.get("paras"), data.get("items")
    if not isinstance(paras, list) or not isinstance(items, list):
        return None
    for item in items:
        if isinstance(item, dict) and item.get("t") == "p" and _is_int(item.get("i")):
            idx = item["i"]
            if 0 <= idx < len(paras) and isinstance(paras[idx], str):
                return paras[idx]
    return None


def check_chapters(report: Report, book: dict) -> None:
    category = "chapters"
    for chapter in _iter_chapters(book):
        cid = chapter.get("id")
        if not isinstance(cid, str) or not cid:
            cid = "?"
        sections = [s for s in (chapter.get("sections") or []) if isinstance(s, dict)]
        if not sections:
            report.fail(category, cid, "没有小节")
            continue

        chars = [s.get("chars") for s in sections]
        missing = [s.get("id") for s, value in zip(sections, chars) if not _is_int(value)]
        if missing:
            report.fail(category, cid, f"有 section 缺少有效 chars: {missing}")
        total = sum(value for value in chars if _is_int(value))
        if total <= 1000:
            report.fail(category, cid, f"各节 chars 合计 {total} <= 1000")

        # 章首页在第一节之前 → 章导言并进了第一节
        chapter_page = chapter.get("page")
        first = sections[0]
        first_page = first.get("page")
        if _is_int(chapter_page) and _is_int(first_page) and chapter_page < first_page:
            first_chars = first.get("chars")
            if not _is_int(first_chars) or first_chars <= 1000:
                report.fail(category, cid,
                            f"有章首页导言，但首节 {first.get('id')!r} chars={first_chars!r} <= 1000")
            first_id = first.get("id")
            if isinstance(first_id, str) and first_id:
                first_para = _first_visible_para(first_id)
                if first_para is None:
                    report.fail(category, cid,
                                f"有章首页导言，但取不到首节 {first_id} 的可见段落")
                elif re.fullmatch(r"\d+", first_para.strip()):
                    report.fail(category, cid,
                                f"有章首页导言，但首节 {first_id} 第一个可见段落是纯数字: "
                                f"{_short(first_para, 30)}")


# ---------------------------------------------------------------------------
# 5. 与基线对比（可选）
# ---------------------------------------------------------------------------

def check_baseline(report: Report, book: dict) -> None:
    category = "baseline"
    if not BASELINE_PATH.is_file():
        report.baseline = {"present": False}
        return

    try:
        baseline = _load_json(BASELINE_PATH)
    except Exception as exc:  # noqa: BLE001
        report.fail(category, BASELINE_PATH.name, f"JSON 读取失败: {exc}")
        report.baseline = {"present": True, "error": str(exc)}
        return
    if not isinstance(baseline, dict):
        report.fail(category, BASELINE_PATH.name, "JSON 顶层不是对象")
        report.baseline = {"present": True, "error": "顶层不是对象"}
        return

    old_sections = baseline.get("sections")
    if not isinstance(old_sections, dict):
        report.warn(category, BASELINE_PATH.name, "缺少 sections 字段，无法逐节比较")
        old_sections = {}

    current_total = 0
    for _chapter, section in _iter_sections(book):
        sid = section.get("id")
        current = section.get("chars")
        if not isinstance(sid, str) or not _is_int(current):
            continue
        current_total += current
        previous = old_sections.get(sid)
        if previous is None:
            report.warn(category, sid, "基线中没有该小节（新增？）")
            continue
        if not _is_int(previous):
            report.warn(category, sid, f"基线 chars 非法: {previous!r}")
            continue
        if previous == 0:
            change = 0.0 if current == 0 else float("inf")
        else:
            change = abs(current - previous) / previous
        if change > 0.60:
            report.warn(category, sid,
                        f"chars 变化超过 60%: {previous} → {current} ({change:+.0%})")

    previous_total = baseline.get("totalChars")
    if not _is_int(previous_total):
        previous_total = sum(value for value in old_sections.values() if _is_int(value))

    if previous_total == 0:
        percent = "n/a"
    else:
        percent = f"{(current_total - previous_total) / previous_total:+.2%}"
    report.baseline = {
        "present": True,
        "totalChars": current_total,
        "previousTotalChars": previous_total,
        "change": percent,
    }


# ---------------------------------------------------------------------------
# 输出
# ---------------------------------------------------------------------------

def _print_status(report: Report, label: str, category: str, quiet: bool) -> None:
    status = report.status(category)
    if quiet and status == "PASS":
        return
    detail = report.detail(category)
    print(f"{_pad(label)} {status}" + (f" {detail}" if detail else ""))


def _print_human(report: Report, quiet: bool) -> None:
    print("== 构建回归校验 ==")
    for category, label in (
        ("book", "book.json"),
        ("sections", "sections"),
        ("problems", "problems"),
        ("chapters", "chapters"),
    ):
        _print_status(report, label, category, quiet)

    baseline = report.baseline
    if not baseline.get("present"):
        if not quiet:
            print(f"{_pad('baseline')} 跳过（未找到 data/_build_report.json）")
    else:
        _print_status(report, "baseline", "baseline", quiet)

    if baseline.get("present") and _is_int(baseline.get("totalChars")):
        print(f"本次 totalChars = {baseline['totalChars']} vs 上次 = "
              f"{baseline.get('previousTotalChars')} ({baseline.get('change')})")

    print(f"FAIL 列表（{len(report.fails)}）")
    for entry in report.fails:
        print(f"  - {report.entry_text(entry)}")

    print(f"WARN 列表（{len(report.warns)}）")
    for entry in report.warns:
        print(f"  - {report.entry_text(entry)}")

    conclusion = "FAIL" if report.fails else "PASS"
    print(f"== 结论: {conclusion} ==")


def _json_payload(report: Report) -> dict:
    categories = {}
    for category in ("book", "sections", "problems", "chapters", "baseline"):
        if category == "baseline" and not report.baseline.get("present"):
            continue
        categories[category] = report.status(category)
    return {
        "ok": not report.fails,
        "exitCode": 1 if report.fails else 0,
        "categories": categories,
        "counts": report.counts,
        "baseline": report.baseline,
        "failures": report.fails,
        "warnings": report.warns,
    }


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="校验 data/book.json 与 data/sections/ 的构建结果")
    parser.add_argument("--quiet", "-q", action="store_true",
                        help="只输出 FAIL/WARN 与汇总")
    parser.add_argument("--json", "-j", action="store_true",
                        help="以 JSON 输出结果到 stdout")
    args = parser.parse_args(argv)

    _setup_stdout()
    report = Report()

    book = None
    book_ok = False
    if not BOOK_PATH.is_file():
        report.fail("book", "", f"缺少文件 {BOOK_PATH}")
    else:
        try:
            book = _load_json(BOOK_PATH)
        except Exception as exc:  # noqa: BLE001
            report.fail("book", "book.json", f"JSON 读取失败: {exc}")
        if book is not None:
            if isinstance(book, dict):
                book_ok = check_book(report, book)
            else:
                report.fail("book", "book.json", "JSON 顶层不是对象")

    if book_ok:
        check_sections(report, book)
        check_problems(report, book)
        check_chapters(report, book)
        check_baseline(report, book)
    elif report.baseline.get("present") is False and BASELINE_PATH.is_file():
        # book 不可用时无法逐节比较，但至少说明基线存在
        report.baseline = {"present": True, "skipped": "book.json 不可用"}

    if args.json:
        print(json.dumps(_json_payload(report), ensure_ascii=False, indent=2))
    else:
        _print_human(report, args.quiet)

    return 1 if report.fails else 0


if __name__ == "__main__":
    sys.exit(main())
