# -*- coding: utf-8 -*-
"""Build chapter/section index + cleaned text + inline figure blocks from the PDF.

每节输出 data/sections/<id>.json：
  text  : 纯文本（供 AI 使用，保持与旧版一致）
  paras : 段落文本数组（正文/标题/图表标签，按阅读顺序）
  items : 阅读顺序数组
            {t:'p', i}                    -> 渲染 paras[i]
            {t:'img', page, x0,y0,x1,y1}  -> 该页的一块"图表/公式"区域（图片）
"""
import json, os, re, collections, subprocess, sys, time
import pymupdf

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG = os.path.join(ROOT, 'config.json')
DATA = os.path.join(ROOT, 'data')
SEC = os.path.join(DATA, 'sections')
os.makedirs(SEC, exist_ok=True)


def load_pdf_path():
    """按优先级找教材 PDF：环境变量 > config.json > 项目根目录常见文件名。"""
    env = os.environ.get('PE_PDF') or os.environ.get('STUDY_PDF')
    if env and os.path.exists(env):
        return os.path.abspath(env)
    if os.path.exists(CONFIG):
        try:
            c = json.load(open(CONFIG, encoding='utf-8-sig'))
            p = str(c.get('pdf') or '').strip()
            if p and not os.path.isabs(p):
                p = os.path.join(ROOT, p)
            if p and os.path.exists(p):
                return p
        except Exception:
            pass
    for name in ('book.pdf', '教材.pdf', 'Fundamentals of Power Electronics 3rd Edition.pdf'):
        path = os.path.join(ROOT, name)
        if os.path.exists(path):
            return path
    raise SystemExit(
        '找不到教材 PDF。\n'
        '请任选一种方式提供（本项目不附带教材，版权原因需自备合法副本）：\n'
        '  1) 把 PDF 放到项目根目录，命名为 book.pdf\n'
        '  2) 复制 config.example.json 为 config.json，把 "pdf" 改成你的 PDF 路径\n'
        '  3) 设置环境变量 PE_PDF=<pdf 路径>\n'
        '然后再运行：python tools/build_book.py'
    )


BOOK = load_pdf_path()

LIG = {'\ufb00': 'ff', '\ufb01': 'fi', '\ufb02': 'fl', '\ufb03': 'ffi',
       '\ufb04': 'ffl', '\ufb05': 'ft', '\ufb06': 'st'}
HEAD_RE = re.compile(r'^\d+(\.\d+){0,2}\s+[A-Z]')
# 图注：Fig./Figure/Table + 编号 + 大写开头的名词短语；正文里 "Figure 1.8 illustrates..." 不算
CAP_RE = re.compile(r'^(Fig\.?|Figure|Table)\s*\d+(\.\d+)?\s+[A-Z]')
LETTER_RE = re.compile(r'[A-Za-z]')
LOWER_RE = re.compile(r'[a-z]')


def norm(s: str) -> str:
    for k, v in LIG.items():
        s = s.replace(k, v)
    s = s.replace('\u00a0', ' ').replace('\u2019', "'").replace('\u2018', "'")
    s = s.replace('\u201c', '"').replace('\u201d', '"')
    return s


def clean_block(t: str) -> str:
    t = norm(t)
    t = re.sub(r'-\s*\n\s*', '', t)      # line-break hyphenation
    t = re.sub(r'\s*\n\s*', ' ', t)      # soft wraps
    t = re.sub(r'\s{2,}', ' ', t)
    return t.strip()


BODY_FONT = [None]   # 全书正文所用字体（带一对方括号便于闭包修改）


def classify(t: str, font=None) -> str:
    """h=标题, f=图表/公式碎片, a=正文段落"""
    if re.fullmatch(r'problems?', t.strip(), re.I):
        return 'h'
    if CAP_RE.match(t) and len(t) <= 220:
        return 'f'
    if HEAD_RE.match(t) and 6 <= len(t) <= 170 and len(LOWER_RE.findall(t)) >= 3:
        return 'h'
    # 图表里的标签用的是另一套字体；但带句号的完整句子仍按正文处理
    if (font and BODY_FONT[0] and font != BODY_FONT[0]
            and not re.search(r'[.!?]', t) and not CAP_RE.match(t)):
        return 'f'
    return 'a' if len(LETTER_RE.findall(t)) >= 22 else 'f'


def page_blocks(doc, pno):
    page = doc[pno]
    h, w = page.rect.height, page.rect.width
    out = []
    for b in page.get_text('dict')['blocks']:
        if b.get('type') != 0:
            continue
        txt = '\n'.join(''.join(s['text'] for s in l['spans']) for l in b['lines'])
        t = txt.strip()
        if not t:
            continue
        x0, y0, x1, y1 = b['bbox']
        # 页眉：顶部细条（页码 + 章节标题）
        if y0 < 50 and (y1 - y0) < 16:
            continue
        if y0 > h * 0.93 and re.fullmatch(r'\d{1,4}', t):
            continue
        t = clean_block(t)
        if not t:
            continue
        cnt = collections.Counter()
        for l in b['lines']:
            for s in l['spans']:
                cnt[s['font']] += len(s['text'])
        font = cnt.most_common(1)[0][0] if cnt else None
        out.append({'t': t, 'x0': x0, 'y0': y0, 'x1': x1, 'y1': y1, 'font': font})
    out.sort(key=lambda b: (round(b['y0'], 1), b['x0']))
    return out


def page_drawings(doc, pno):
    """矢量图元的外框（本书图、表格线、公式横线都是矢量）。"""
    page = doc[pno]
    h, w = page.rect.height, page.rect.width
    out = []
    for d in page.get_drawings():
        r = d['rect']
        if r.width < 1.2 or r.height < 1.2:
            continue
        if r.width > w * 0.95 and r.height > h * 0.9:
            continue
        out.append((r.x0, r.y0, r.x1, r.y1))
    return out


def band_rect(run, drawings, prev_b, next_b, page_w):
    xs, ys = [], []
    for b in run:
        xs += [b['x0'], b['x1']]
        ys += [b['y0'], b['y1']]
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    for (dx0, dy0, dx1, dy1) in drawings:
        if dy1 < y0 - 25 or dy0 > y1 + 25:
            continue
        x0, x1 = min(x0, dx0), max(x1, dx1)
        y0, y1 = min(y0, dy0), max(y1, dy1)
    pad = 3
    x0 = max(36, x0 - pad)
    x1 = min(page_w - 36, x1 + pad)
    y0 = max(42, y0 - pad)
    y1 = y1 + pad
    # 只有"位于上方/下方"的正文块才需要收边；图文并排（正文绕排）时不要收边
    if prev_b and prev_b['y1'] <= y0 + 8 and prev_b['x1'] > x0 - 2 and prev_b['x0'] < x1 + 2:
        y0 = max(y0, prev_b['y1'] + 1)
    if next_b and next_b['y0'] >= y1 - 8 and next_b['x1'] > x0 - 2 and next_b['x0'] < x1 + 2:
        y1 = min(y1, next_b['y0'] - 1)
    if y1 - y0 < 10 or x1 - x0 < 40:
        return None
    return [round(x0, 1), round(y0, 1), round(x1, 1), round(y1, 1)]


def detect_body_font(doc, start=10, end=80):
    cnt = collections.Counter()
    for p in range(start, min(end, len(doc)) + 1):
        for b in page_blocks(doc, p - 1):
            if len(LETTER_RE.findall(b['t'])) >= 120 and b.get('font'):
                cnt[b['font']] += len(b['t'])
    return cnt.most_common(1)[0][0] if cnt else None


def _run_bbox(run):
    xs, ys = [], []
    for b in run:
        xs += [b['x0'], b['x1']]
        ys += [b['y0'], b['y1']]
    return min(xs), min(ys), max(xs), max(ys)


def _near_drawings(run, drawings):
    x0, y0, x1, y1 = _run_bbox(run)
    out = []
    for d in drawings:
        if d[3] < y0 - 25 or d[1] > y1 + 25:
            continue
        if d[2] < x0 - 40 or d[0] > x1 + 40:
            continue
        out.append(d)
    return out


def _line_groups(run, gap=13):
    """把连续碎片按 y 间距切成"一行/一组"，避免把两个公式拼进一张图。"""
    groups, cur = [], [run[0]]
    for b in run[1:]:
        if b['y0'] - max(x['y1'] for x in cur) > gap:
            groups.append(cur)
            cur = [b]
        else:
            cur.append(b)
    groups.append(cur)
    return groups


def _img_item(p, rect):
    if not rect:
        return None
    wpt, hpt = rect[2] - rect[0], rect[3] - rect[1]
    if wpt * hpt < 2000 or (wpt < 140 and hpt < 30):
        return None   # 太小的"图"多半是章节号、装饰线、单个词，丢弃
    return {'t': 'img', 'page': p, 'w': round(wpt, 1),
            'x0': rect[0], 'y0': rect[1], 'x1': rect[2], 'y1': rect[3]}


def heading_index(blocks, num):
    """在一页的文字块里找某个小节（或 Problems）标题的位置。"""
    if not num:
        return None
    if num.lower() == 'problems':
        for i, b in enumerate(blocks):
            if re.fullmatch(r'problems?', b['t'].strip().lower()):
                return i
        return None
    pat = re.compile(r'^' + re.escape(num) + r'\s+\S')
    for i, b in enumerate(blocks):
        if len(b['t']) < 170 and pat.match(b['t']):
            return i
    return None


def build_section(doc, a, b, start_num=None, end_num=None, keep_prefix=True, intro_as_content=False):
    paras, items = [], []
    started = start_num is None

    def emit(blks, drawings, w, h, p):
        if not blks:
            return
        kinds = [classify(x['t'], x.get('font')) for x in blks]
        i = 0
        while i < len(blks):
            if kinds[i] != 'f':
                t = blks[i]['t']
                # 页脚的版权/引用行：保留在纯文本里（AI 用），但不显示
                if re.match(r'^(©|R\.\s*W\.\s*Erickson|https?://doi)', t) or 'doi.org' in t:
                    paras.append(t)
                    i += 1
                    continue
                paras.append(t)
                items.append({'t': 'p', 'i': len(paras) - 1})
                i += 1
                continue
            j = i
            while j < len(blks) and kinds[j] == 'f':
                j += 1
            run = blks[i:j]
            letters = sum(len(LETTER_RE.findall(x['t'])) for x in run)
            prev_b = blks[i - 1] if i > 0 else None
            next_b = blks[j] if j < len(blks) else None
            near = _near_drawings(run, drawings)
            if near:
                # 有矢量图：整段（含图注）作为一张图片
                rect = band_rect(run, drawings, prev_b, next_b, w)
                it = _img_item(p, rect)
                if it:
                    paras.extend(x['t'] for x in run)
                    items.append(it)
                elif rect is None:
                    for x in run:
                        paras.append(x['t'])
                        if not re.fullmatch(r'\d{1,3}', x['t'].strip()):
                            items.append({'t': 'p', 'i': len(paras) - 1})
                else:
                    paras.extend(x['t'] for x in run)   # 太小的装饰，不显示
            else:
                # 纯文字：数字/页码之类的孤立碎片直接丢掉
                if letters == 0:
                    paras.extend(x['t'] for x in run)
                    i = j
                    continue
                # 公式：按行分组，每组一张紧贴的图片
                groups = _line_groups(run)
                for gi, g in enumerate(groups):
                    rect = band_rect(g, [],
                                     prev_b if gi == 0 else None,
                                     next_b if gi == len(groups) - 1 else None,
                                     w)
                    it = _img_item(p, rect)
                    if it:
                        paras.extend(x['t'] for x in g)
                        items.append(it)
                    elif rect is None:
                        for x in g:
                            paras.append(x['t'])
                            if not re.fullmatch(r'\d{1,3}', x['t'].strip()):
                                items.append({'t': 'p', 'i': len(paras) - 1})
                    else:
                        paras.extend(x['t'] for x in g)
            i = j

    for p in range(a, b + 1):
        if not (1 <= p <= len(doc)):
            continue
        blocks = page_blocks(doc, p - 1)
        if not blocks:
            continue
        intro_blocks = None
        # 起始裁剪：从本节标题所在位置开始
        if not started:
            idx = heading_index(blocks, start_num)
            if idx is None:
                if not intro_as_content:
                    continue
                intro_blocks = blocks          # 本章第一节：标题之前的整页都算章节导言
                blocks = []
            else:
                if idx > 0:
                    if intro_as_content:
                        intro_blocks = blocks[:idx]
                    elif keep_prefix:
                        for x in blocks[:idx]:
                            paras.append(x['t'])
                blocks = blocks[idx:]
                started = True
        drawings = page_drawings(doc, p - 1)
        w, h = doc[p - 1].rect.width, doc[p - 1].rect.height
        if intro_blocks:
            emit(intro_blocks, drawings, w, h, p)
        # 结束裁剪：遇到下一节标题就停
        end_here = False
        if started and end_num is not None:
            idx = heading_index(blocks, end_num)
            if idx is not None:
                blocks = blocks[:idx]
                end_here = True
        emit(blocks, drawings, w, h, p)
        if end_here:
            break
    # 找不到本节标题时，退回整段页面（避免整节为空）
    if start_num is not None and not started:
        return build_section(doc, a, b, None, end_num, keep_prefix, intro_as_content)
    # 同一页里相邻/重叠的图片合并成一张，避免同一块图被裁多次
    items = _merge_items(items)
    items = _dedup_imgs(items)
    return paras, items


def _area(r):
    return max(0, r[2] - r[0]) * max(0, r[3] - r[1])


def _inter(a, b):
    x0 = max(a[0], b[0]); y0 = max(a[1], b[1])
    x1 = min(a[2], b[2]); y1 = min(a[3], b[3])
    return max(0, x1 - x0) * max(0, y1 - y0)


def _dedup_imgs(items, ratio=0.35):
    out = []
    for it in items:
        if it['t'] == 'img':
            for o in out:
                if o['t'] != 'img' or o['page'] != it['page']:
                    continue
                a = (o['x0'], o['y0'], o['x1'], o['y1'])
                b = (it['x0'], it['y0'], it['x1'], it['y1'])
                if _inter(a, b) > ratio * min(_area(a), _area(b)):
                    o['x0'] = min(a[0], b[0]); o['y0'] = min(a[1], b[1])
                    o['x1'] = max(a[2], b[2]); o['y1'] = max(a[3], b[3])
                    o['w'] = round(o['x1'] - o['x0'], 1)
                    it = None
                    break
            if it is None:
                continue
        out.append(it)
    return out


def _merge_items(items, gap=30):
    out = []
    for it in items:
        if (out and it['t'] == 'img' and out[-1]['t'] == 'img'
                and out[-1]['page'] == it['page']):
            a, b = out[-1], it
            if (a['y0'] <= b['y1'] + gap and b['y0'] <= a['y1'] + gap
                    and a['x0'] < b['x1'] and b['x0'] < a['x1']):
                a['x0'] = min(a['x0'], b['x0'])
                a['y0'] = min(a['y0'], b['y0'])
                a['x1'] = max(a['x1'], b['x1'])
                a['y1'] = max(a['y1'], b['y1'])
                a['w'] = round(a['x1'] - a['x0'], 1)
                continue
        out.append(it)
    return out


def split_problem_paras(paras, items, ch_num):
    """把粘连的习题按题号切开：'2.1 ... 2.2 ...' → 两段（题号顺序校验，避开 Fig/Eq/Problem 引用）。"""
    expected = [1]
    pat = re.compile(r'(?:^|(?<=\s))' + str(ch_num) + r'\.(\d+)(?=\s+[A-Z(])')
    bad = re.compile(r'(?i)(problem|fig\.?|figure|eq\.?|equation|table|section|chapter)\s*$')
    raw, ranges = [], {}
    for i, t in enumerate(paras):
        pieces, start = [], 0
        for m in pat.finditer(t):
            k = int(m.group(1))
            if k not in (expected[0], expected[0] + 1):
                continue
            if bad.search(t[max(0, m.start() - 14):m.start()]):
                continue
            if m.start() <= start:
                expected[0] = max(expected[0], k + 1)
                continue
            pieces.append(t[start:m.start()].strip())
            start = m.start()
            expected[0] = k + 1
        pieces.append(t[start:].strip())
        pieces = [p for p in pieces if p] or [t]
        ranges[i] = (len(raw), len(raw) + len(pieces))
        raw.extend(pieces)

    # 处理 PDF 跨行连字符：上一段以 '-' 结尾、下一段小写开头 → 拼回去
    # （中间可能隔着一两个图内标签块，允许跨一个短标签块合并）
    final, raw_to_final = [], []
    i = 0
    while i < len(raw):
        t = raw[i]
        if final and final[-1].rstrip().endswith('-') and t[:1].islower() and len(t) > 3:
            final[-1] = final[-1].rstrip()[:-1] + t
            raw_to_final.append(len(final) - 1)
            i += 1
            continue
        if (final and final[-1].rstrip().endswith('-') and i + 1 < len(raw)
                and len(t) < 60 and raw[i + 1][:1].islower()):
            final[-1] = final[-1].rstrip()[:-1] + raw[i + 1]
            raw_to_final.append(len(final) - 1)
            raw_to_final.append(len(final) - 1)
            i += 2
            continue
        final.append(t)
        raw_to_final.append(len(final) - 1)
        i += 1

    new_items = []
    emitted = set()
    for it in items:
        if it['t'] == 'p':
            a, b = ranges.get(it['i'], (None, None))
            if a is None:
                new_items.append(it)
                continue
            seen = []
            for k in range(a, b):
                mi = raw_to_final[k]
                if mi not in seen and mi not in emitted:
                    seen.append(mi)
                    emitted.add(mi)
                    new_items.append({'t': 'p', 'i': mi})
        else:
            new_items.append(it)
    return final, new_items


def merge_problem_paragraphs(paras, items):
    """合并被 PDF 切断的句子：上一段没有句末标点、下一段小写开头 → 接上（跨图也可以）。"""
    out_paras, out_items, last = [], [], None
    for it in items:
        if it['t'] != 'p':
            out_items.append(it)
            continue
        t = paras[it['i']].strip()
        if not t:
            continue
        if last is not None:
            prev = out_paras[last].rstrip()
            if (prev and not re.match(r'^\d+\.\d+\s', t) and t[:1] not in '([' and
                    (prev.endswith('-') or
                     (prev[-1] not in '.?!:' and t[:1].islower()))):
                out_paras[last] = (prev[:-1] + t) if prev.endswith('-') else (prev + ' ' + t)
                continue
        out_paras.append(t)
        last = len(out_paras) - 1
        out_items.append({'t': 'p', 'i': last})
    return out_paras, out_items


def main():
    doc = pymupdf.open(BOOK)
    BODY_FONT[0] = detect_body_font(doc)
    print('body font:', BODY_FONT[0])
    toc = [[lvl, norm(t).replace('\r', '').strip(), p] for lvl, t, p in doc.get_toc(simple=True)]
    offset = 0

    # ---- structure ----
    parts = []
    part = {'id': 'front', 'title': 'Front Matter', 'page': 1, 'chapters': []}
    parts.append(part)
    chapters = []
    cur_part = part
    cur_ch = None
    cur_sec = None
    for lvl, title, p in toc:
        if lvl == 1 and title.startswith('Part '):
            cur_part = {'id': 'part' + str(len(parts)), 'title': title, 'page': p, 'chapters': []}
            parts.append(cur_part)
            cur_ch = None
            cur_sec = None
            continue
        m = re.match(r'^(\d+)\s+(.*)$', title)
        if m and lvl <= 2 and not re.match(r'^\d+\.\d+', title):
            cur_ch = {'id': 'ch' + m.group(1), 'num': int(m.group(1)), 'title': m.group(2),
                      'page': p, 'bookPage': p - offset, 'sections': [], 'problems': None}
            cur_part['chapters'].append(cur_ch)
            chapters.append(cur_ch)
            cur_sec = None
            continue
        if cur_ch is None:
            continue
        m = re.match(r'^(\d+)\.(\d+)\s+(.*)$', title)
        if m and lvl >= 2:
            cur_sec = {'id': f'{cur_ch["id"]}-{m.group(2)}', 'num': f'{m.group(1)}.{m.group(2)}',
                       'title': m.group(3), 'page': p, 'bookPage': p - offset}
            cur_ch['sections'].append(cur_sec)
            continue
        if re.match(r'^problems?$', title.lower()) and cur_ch is not None:
            cur_ch['problems'] = {'page': p, 'bookPage': p - offset}
            continue

    # ---- page ranges ----
    flat = []
    for prt in parts:
        for ch in prt['chapters']:
            flat.append(('ch', prt, ch, None))
            for s in ch['sections']:
                flat.append(('sec', prt, ch, s))
    for i, (kind, prt, ch, s) in enumerate(flat):
        nxt = None
        for j in range(i + 1, len(flat)):
            nxt = flat[j]
            break
        node = s if s else ch
        node['endPage'] = (nxt[3]['page'] - 1 if nxt and nxt[3] else
                           nxt[2]['page'] - 1 if nxt else len(doc))
    for prt in parts:
        for ch in prt['chapters']:
            ch['endPage'] = (ch['sections'][0]['page'] - 1) if ch['sections'] else ch['page']
            if ch['sections']:
                ch['endPage'] = ch['sections'][-1]['endPage']
            if ch['problems']:
                ch['problems']['endPage'] = ch['endPage']
                ch['endPage'] = ch['problems']['page'] - 1

    index = {'title': 'Fundamentals of Power Electronics',
             'edition': '3rd Edition',
             'author': 'Robert W. Erickson, Dragan Maksimović',
             'pageOffset': offset, 'pdfPages': len(doc), 'parts': []}
    total = 0
    n_img = 0
    for prt in parts:
        if not prt['chapters']:
            continue
        pj = {'id': prt['id'], 'title': prt['title'], 'chapters': []}
        for ch in prt['chapters']:
            cj = {'id': ch['id'], 'num': ch['num'], 'title': ch['title'], 'page': ch['page'],
                  'bookPage': ch['bookPage'], 'sections': [], 'probsPage': None, 'probsBookPage': None}
            secs = ch['sections']
            for si, s in enumerate(secs):
                first = (si == 0)
                if si + 1 < len(secs):
                    nxt = secs[si + 1]
                    a2, b2 = s['page'], nxt['page']       # 多带下一页，按标题裁掉后一节
                    end_num = nxt['num']
                elif ch['problems']:
                    a2, b2 = s['page'], ch['problems']['page']   # 末节可能和 Problems 同页
                    end_num = 'Problems'
                else:
                    a2, b2 = s['page'], ch['endPage']
                    end_num = None
                if first:
                    a2 = ch['page']       # 本章第一节：把章标题页到 4.1 之前的章节导言合并进来
                paras, items = build_section(doc, a2, b2, s['num'], end_num,
                                             intro_as_content=first)
                txt = '\n\n'.join(paras).strip()
                n_img += sum(1 for it in items if it['t'] == 'img')
                with open(os.path.join(SEC, s['id'] + '.json'), 'w', encoding='utf-8') as f:
                    json.dump({'id': s['id'], 'text': txt, 'paras': paras, 'items': items},
                              f, ensure_ascii=False)
                total += len(txt)
                cj['sections'].append({'id': s['id'], 'num': s['num'], 'title': s['title'],
                                       'page': (ch['page'] if si == 0 else s['page']),
                                       'bookPage': (ch['bookPage'] if si == 0 else s['bookPage']),
                                       'endPage': s['endPage'], 'chars': len(txt)})
            if ch['problems']:
                cj['probsPage'] = ch['problems']['page']
                cj['probsBookPage'] = ch['problems']['bookPage']
                paras, p_items = build_section(doc, ch['problems']['page'], ch['problems']['endPage'],
                                               'Problems', None, keep_prefix=False)
                paras, p_items = split_problem_paras(paras, p_items, ch['num'])
                orig_text = '\n\n'.join(paras).strip()
                paras, p_items = merge_problem_paragraphs(paras, p_items)
                pt = orig_text
                with open(os.path.join(SEC, ch['id'] + '-problems.json'), 'w', encoding='utf-8') as f:
                    json.dump({'id': ch['id'] + '-problems', 'text': pt, 'paras': paras,
                               'items': p_items}, f, ensure_ascii=False)
                cj['probsChars'] = len(pt)
            pj['chapters'].append(cj)
        index['parts'].append(pj)

    with open(os.path.join(DATA, 'book.json'), 'w', encoding='utf-8') as f:
        json.dump(index, f, ensure_ascii=False, indent=1)

    # 构建报告：供回归校验做"本次 vs 上次"对比
    report = {'generatedAt': time.strftime('%Y-%m-%d %H:%M:%S'),
              'sections': {}, 'problems': {}, 'images': n_img, 'totalChars': total}
    for prt in index['parts']:
        for ch in prt['chapters']:
            for s in ch['sections']:
                report['sections'][s['id']] = s.get('chars', 0)
            if ch.get('probsChars'):
                report['problems'][ch['id'] + '-problems'] = ch['probsChars']
    with open(os.path.join(DATA, '_build_report.json'), 'w', encoding='utf-8') as f:
        json.dump(report, f, ensure_ascii=False, indent=1)

    print('chapters:', len(chapters), 'total chars:', total, 'figure blocks:', n_img)
    for prt in index['parts']:
        print('==', prt['title'], [c['num'] for c in prt['chapters']])

    # 构建后自动跑回归校验（tools/verify_book.py）
    vpath = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'verify_book.py')
    if os.path.exists(vpath):
        try:
            rc = subprocess.call([sys.executable, vpath, '--quiet'])
            print('== 回归校验:', 'PASS' if rc == 0 else 'FAIL（详见 python tools/verify_book.py）')
        except Exception as e:
            print('== 回归校验跳过:', e)
    else:
        print('== 回归校验跳过: 缺少 tools/verify_book.py')


if __name__ == '__main__':
    main()

