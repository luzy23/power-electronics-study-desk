# -*- coding: utf-8 -*-
"""
电力电子学习台 —— 本地服务器
- 提供静态页面 + 教材数据（章节文本 / PDF 页面渲染）
- /api/chat 代理到任意 OpenAI 兼容接口（DeepSeek 等），支持 SSE 流式

用法:  python server.py [--port 8765] [--no-browser]
"""
import argparse
import json
import mimetypes
import os
import socket
import sys
import threading
import time
import urllib.error
import urllib.request
import webbrowser
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs, unquote

try:
    import pymupdf
except Exception:
    pymupdf = None

try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

ROOT = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(ROOT, 'static')
DATA = os.path.join(ROOT, 'data')
CACHE = os.path.join(ROOT, '_cache', 'pages')
os.makedirs(CACHE, exist_ok=True)

CONF_FILE = os.path.join(ROOT, 'config.json')


def load_pdf_path():
    """按优先级找教材 PDF：环境变量 > config.json > 项目根目录常见文件名。"""
    env = os.environ.get('PE_PDF') or os.environ.get('STUDY_PDF')
    if env and os.path.exists(env):
        return os.path.abspath(env)
    if os.path.exists(CONF_FILE):
        try:
            c = json.load(open(CONF_FILE, encoding='utf-8-sig'))
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
    return ''


PDF_PATH = load_pdf_path()


def pdf_missing_error():
    return RuntimeError(
        '未找到教材 PDF。请把 PDF 放到项目根目录并命名为 book.pdf，'
        '或复制 config.example.json 为 config.json 填写 "pdf" 路径，然后重启。'
    )

_doc = None
_doc_lock = threading.Lock()


def get_doc():
    global _doc
    if _doc is None:
        if pymupdf is None:
            raise RuntimeError('PyMuPDF 未安装: pip install pymupdf')
        if not PDF_PATH or not os.path.exists(PDF_PATH):
            raise pdf_missing_error()
        _doc = pymupdf.open(PDF_PATH)
    return _doc


def page_jpeg(n, dpi=120):
    n = max(1, min(int(n), 4000))
    dpi = max(72, min(int(dpi), 240))
    path = os.path.join(CACHE, f'p{n}_{dpi}.jpg')
    if os.path.exists(path):
        with open(path, 'rb') as f:
            return f.read()
    with _doc_lock:
        doc = get_doc()
        if n > doc.page_count:
            raise ValueError('page out of range')
        page = doc[n - 1]
        zoom = dpi / 72.0
        pix = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), alpha=False)
        data = pix.tobytes('jpeg', jpg_quality=82)
    with open(path, 'wb') as f:
        f.write(data)
    return data


BAND_DIR = os.path.join(ROOT, '_cache', 'bands')
os.makedirs(BAND_DIR, exist_ok=True)

BACKUP_DIR = os.path.join(ROOT, 'backups')
os.makedirs(BACKUP_DIR, exist_ok=True)


def chapter_full(chid):
    """整章完整原文（不截断），用于前端分块-归并生成。"""
    for part in book_index()['parts']:
        for ch in part['chapters']:
            if ch['id'] != chid:
                continue
            texts, total = [], 0
            for s in ch['sections']:
                try:
                    t = section_text(s['id'])
                except FileNotFoundError:
                    continue
                texts.append('### %s %s\n%s' % (s['num'], s['title'], t))
                total += len(t)
            return {'id': chid, 'text': '\n\n'.join(texts), 'chars': total}
    raise KeyError(chid)


def save_backup(payload):
    data = payload.get('data')
    if not isinstance(data, (dict, list)):
        raise ValueError('data 必须是 JSON 对象')
    stamp = time.strftime('%Y%m%d-%H%M%S')
    name = 'backup-%s.json' % stamp
    path = os.path.join(BACKUP_DIR, name)
    with open(path, 'w', encoding='utf-8') as f:
        json.dump({'savedAt': time.strftime('%Y-%m-%d %H:%M:%S'),
                   'note': payload.get('note') or '', 'data': data},
                  f, ensure_ascii=False)
    files = sorted(fn for fn in os.listdir(BACKUP_DIR) if fn.startswith('backup-'))
    for old in files[:-30]:
        try:
            os.remove(os.path.join(BACKUP_DIR, old))
        except OSError:
            pass
    return {'ok': True, 'name': name, 'file': path, 'count': len(files[-30:])}


def list_backups():
    out = []
    for fn in sorted(os.listdir(BACKUP_DIR), reverse=True):
        if not fn.startswith('backup-'):
            continue
        p = os.path.join(BACKUP_DIR, fn)
        try:
            st = os.stat(p)
        except OSError:
            continue
        out.append({'name': fn, 'size': st.st_size,
                    'time': time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(st.st_mtime))})
    return out[:30]


def band_jpeg(n, x0, y0, x1, y1, dpi=170):
    """把教材某页的一块区域（图表/公式）渲染成图片。"""
    n = max(1, min(int(n), 4000))
    dpi = max(96, min(int(dpi), 260))
    key = 'p%d_%d_%d_%d_%d_%d.jpg' % (n, round(float(x0)), round(float(y0)),
                                      round(float(x1)), round(float(y1)), dpi)
    path = os.path.join(BAND_DIR, key)
    if os.path.exists(path):
        with open(path, 'rb') as f:
            return f.read()
    with _doc_lock:
        doc = get_doc()
        page = doc[n - 1]
        pr = page.rect
        clip = pymupdf.Rect(max(0, x0), max(0, y0), min(pr.width, x1), min(pr.height, y1))
        if clip.width < 8 or clip.height < 8:
            raise ValueError('region too small')
        zoom = dpi / 72.0
        pix = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), clip=clip, alpha=False)
        data = pix.tobytes('jpeg', jpg_quality=88)
    with open(path, 'wb') as f:
        f.write(data)
    return data


# ---------------------------------------------------------------- data helpers
_book_cache = {}


def book_index():
    if 'book' not in _book_cache:
        with open(os.path.join(DATA, 'book.json'), encoding='utf-8') as f:
            _book_cache['book'] = json.load(f)
    return _book_cache['book']


def section_text(sid):
    safe = ''.join(ch for ch in sid if ch.isalnum() or ch in '-_')
    path = os.path.join(DATA, 'sections', safe + '.json')
    if not os.path.exists(path):
        raise FileNotFoundError(sid)
    with open(path, encoding='utf-8') as f:
        return json.load(f)['text']


def chapter_context(chid, max_chars=24000):
    """整章原文，按节等比截断，保证每节都有代表内容。"""
    for part in book_index()['parts']:
        for ch in part['chapters']:
            if ch['id'] != chid:
                continue
            texts = []
            for s in ch['sections']:
                try:
                    texts.append((s['num'] + ' ' + s['title'], section_text(s['id'])))
                except FileNotFoundError:
                    pass
            total = sum(len(t) for _, t in texts) or 1
            budget = max_chars
            out = []
            for head, t in texts:
                share = max(600, int(budget * len(t) / total))
                if len(t) > share:
                    t = t[:share] + '\n[... 本节后文从略 ...]'
                out.append(f'### {head}\n{t}')
            joined = '\n\n'.join(out)
            return {'chapter': ch, 'text': joined[:int(max_chars * 1.2)],
                    'chars': len(joined), 'full_chars': total}
    raise KeyError(chid)


# ------------------------------------------------------------------- chat proxy
def proxy_chat(payload, auth, on_chunk):
    """把请求转发到 OpenAI 兼容接口，on_chunk(bytes) 逐块回调。"""
    base = (payload.get('baseUrl') or 'https://api.deepseek.com/v1').rstrip('/')
    if not base.endswith('/chat/completions'):
        base = base + '/chat/completions'
    body = {
        'model': payload.get('model') or 'deepseek-chat',
        'messages': payload.get('messages') or [],
        'temperature': payload.get('temperature', 0.4),
        'stream': bool(payload.get('stream', True)),
    }
    if payload.get('max_tokens'):
        body['max_tokens'] = int(payload['max_tokens'])
    data = json.dumps(body, ensure_ascii=False).encode('utf-8')
    req = urllib.request.Request(base, data=data, method='POST')
    req.add_header('Content-Type', 'application/json')
    req.add_header('Authorization', 'Bearer ' + (auth or ''))
    try:
        resp = urllib.request.urlopen(req, timeout=300)
    except urllib.error.HTTPError as e:
        raw = e.read().decode('utf-8', 'replace')
        detail = raw[:1200]
        # OpenAI 兼容错误体：{"error":{"message": "...", ...}}
        try:
            j = json.loads(raw)
            err = j.get('error')
            if isinstance(err, dict) and err.get('message'):
                detail = err['message']
            elif isinstance(err, str) and err:
                detail = err
            elif j.get('message'):
                detail = j['message']
        except Exception:
            pass
        low = detail.lower()
        if e.code == 400 and ('model' in low or '模型' in detail):
            hint = '当前接口不支持这个模型名，请在「设置 → 获取可用模型」里选一个接口支持的模型'
        elif e.code == 400:
            hint = '请求参数被拒绝，常见原因是模型名或请求格式不被该接口支持'
        elif e.code == 401:
            hint = 'API Key 无效或未授权，请检查设置里的 Key'
        elif e.code == 402:
            hint = '账户余额不足'
        elif e.code == 403:
            hint = '无访问权限（模型或地区限制）'
        elif e.code == 404:
            hint = '接口地址错误，Base URL 应形如 https://api.deepseek.com/v1'
        elif e.code == 429:
            hint = '请求过于频繁或额度用尽，稍后重试'
        else:
            hint = ''
        raise RuntimeError(f'上游 HTTP {e.code}：{detail}' + (f'（{hint}）' if hint else ''))
    except urllib.error.URLError as e:
        reason = getattr(e, 'reason', e)
        raise RuntimeError(f'无法连接 API 服务器：{reason}（检查网络、代理，或 Base URL 是否正确）')
    except Exception as e:
        raise RuntimeError(f'{type(e).__name__}: {e}')
    with resp:
        while True:
            chunk = resp.read(2048)
            if not chunk:
                break
            on_chunk(chunk)


# ----------------------------------------------------------------- http server
class Handler(BaseHTTPRequestHandler):
    server_version = 'PowerElectronicsStudyDesk/1.0'
    protocol_version = 'HTTP/1.1'

    def log_message(self, fmt, *args):
        if os.environ.get('PE_QUIET'):
            return
        sys.stderr.write('[%s] %s\n' % (time.strftime('%H:%M:%S'), fmt % args))

    # -- helpers ------------------------------------------------------------
    def send_json(self, obj, status=200):
        data = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(data)

    def send_bytes(self, data, ctype, cache='no-store'):
        self.send_response(200)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', cache)
        self.end_headers()
        self.wfile.write(data)

    def send_file(self, path):
        if not os.path.isfile(path):
            self.send_json({'error': 'not found'}, 404)
            return
        ctype = mimetypes.guess_type(path)[0] or 'application/octet-stream'
        if path.endswith('.js'):
            ctype = 'application/javascript; charset=utf-8'
        elif path.endswith('.css'):
            ctype = 'text/css; charset=utf-8'
        elif path.endswith('.html'):
            ctype = 'text/html; charset=utf-8'
        elif path.endswith('.json'):
            ctype = 'application/json; charset=utf-8'
        elif path.endswith('.woff2'):
            ctype = 'font/woff2'
        with open(path, 'rb') as f:
            data = f.read()
        self.send_bytes(data, ctype, 'no-cache')

    # -- routing ------------------------------------------------------------
    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        path = u.path
        try:
            if path == '/api/health':
                try:
                    doc = get_doc()
                    pages = doc.page_count
                except Exception:
                    pages = 0
                self.send_json({'ok': True, 'pages': pages, 'pdf': PDF_PATH,
                                'pdfExists': os.path.exists(PDF_PATH)})
                return
            if path == '/api/book':
                self.send_json(book_index())
                return
            if path == '/api/section':
                sid = (q.get('id') or [''])[0]
                safe = ''.join(ch for ch in sid if ch.isalnum() or ch in '-_')
                f = os.path.join(DATA, 'sections', safe + '.json')
                if not os.path.exists(f):
                    raise FileNotFoundError(sid)
                with open(f, encoding='utf-8') as fh:
                    data = json.load(fh)
                out = {'id': sid, 'text': data.get('text', '')}
                if data.get('paras'):
                    out['paras'] = data['paras']
                if data.get('items'):
                    out['items'] = data['items']
                self.send_json(out)
                return
            if path == '/api/chapterfull':
                chid = (q.get('id') or [''])[0]
                try:
                    self.send_json(chapter_full(chid))
                except KeyError:
                    self.send_json({'error': 'not found'}, 404)
                return
            if path == '/api/backups':
                self.send_json({'backups': list_backups()})
                return
            if path == '/api/chapter':
                chid = (q.get('id') or [''])[0]
                mx = int((q.get('max') or ['24000'])[0])
                self.send_json(chapter_context(chid, mx))
                return
            if path == '/api/probs':
                chid = (q.get('id') or [''])[0]
                sid = chid + '-problems'
                try:
                    self.send_json({'id': chid, 'text': section_text(sid)})
                except FileNotFoundError:
                    self.send_json({'id': chid, 'text': ''})
                return
            if path == '/api/models':
                base = (q.get('baseUrl') or [''])[0].rstrip('/')
                if not base.startswith('http'):
                    self.send_json({'error': 'Base URL 无效'}, 400)
                    return
                auth = self.headers.get('Authorization', '')
                token = auth[7:].strip() if auth.lower().startswith('bearer ') else auth.strip()
                url = base + '/models'
                req = urllib.request.Request(url, method='GET')
                req.add_header('Authorization', 'Bearer ' + token)
                try:
                    with urllib.request.urlopen(req, timeout=40) as r:
                        data = json.loads(r.read().decode('utf-8', 'replace'))
                    ids = []
                    for m in (data.get('data') or []):
                        if isinstance(m, dict) and m.get('id'):
                            ids.append(m['id'])
                    self.send_json({'models': ids})
                except urllib.error.HTTPError as e:
                    self.send_json({'error': 'HTTP %d: %s' % (
                        e.code, e.read().decode('utf-8', 'replace')[:400])}, 502)
                except Exception as e:
                    self.send_json({'error': '%s: %s' % (type(e).__name__, e)}, 502)
                return
            if path == '/api/page':
                n = int((q.get('n') or ['1'])[0])
                dpi = int((q.get('dpi') or ['120'])[0])
                self.send_bytes(page_jpeg(n, dpi), 'image/jpeg',
                                'public, max-age=86400')
                return
            if path == '/api/band':
                n = int((q.get('page') or ['1'])[0])
                x0 = float((q.get('x0') or ['0'])[0])
                y0 = float((q.get('y0') or ['0'])[0])
                x1 = float((q.get('x1') or ['500'])[0])
                y1 = float((q.get('y1') or ['700'])[0])
                dpi = int((q.get('dpi') or ['170'])[0])
                self.send_bytes(band_jpeg(n, x0, y0, x1, y1, dpi), 'image/jpeg',
                                'public, max-age=86400')
                return
            # static
            if path == '/':
                path = '/index.html'
            rel = unquote(path).lstrip('/')
            full = os.path.normpath(os.path.join(STATIC, rel))
            if not full.startswith(STATIC):
                self.send_json({'error': 'forbidden'}, 403)
                return
            self.send_file(full)
        except FileNotFoundError as e:
            self.send_json({'error': 'not found: %s' % e}, 404)
        except Exception as e:
            self.send_json({'error': '%s: %s' % (type(e).__name__, e)}, 500)

    def do_POST(self):
        u = urlparse(self.path)
        if u.path == '/api/backup':
            try:
                length = int(self.headers.get('Content-Length') or 0)
                payload = json.loads(self.rfile.read(length).decode('utf-8'))
                self.send_json(save_backup(payload))
            except Exception as e:
                self.send_json({'error': str(e)}, 400)
            return
        if u.path != '/api/chat':
            self.send_json({'error': 'not found'}, 404)
            return
        try:
            length = int(self.headers.get('Content-Length') or 0)
            raw = self.rfile.read(length)
            payload = json.loads(raw.decode('utf-8'))
        except Exception as e:
            self.send_json({'error': 'bad request: %s' % e}, 400)
            return
        auth = self.headers.get('Authorization', '')
        auth = auth[7:].strip() if auth.lower().startswith('bearer ') else auth.strip()
        stream = bool(payload.get('stream', True))

        if not stream:
            out = []
            try:
                proxy_chat(payload, auth, lambda b: out.append(b))
                self.send_json(json.loads(b''.join(out).decode('utf-8')))
            except RuntimeError as e:
                self.send_json({'error': str(e)}, 502)
            return

        try:
            first = {}

            def on_chunk(b):
                if 'sent' not in first:
                    first['sent'] = True
                    self.close_connection = True
                    self.send_response(200)
                    self.send_header('Content-Type', 'text/event-stream; charset=utf-8')
                    self.send_header('Cache-Control', 'no-cache')
                    self.send_header('Connection', 'close')
                    self.send_header('X-Accel-Buffering', 'no')
                    self.end_headers()
                self.wfile.write(b)
                self.wfile.flush()

            proxy_chat(payload, auth, on_chunk)
        except RuntimeError as e:
            if 'sent' not in first:
                self.send_json({'error': str(e)}, 502)
            else:
                try:
                    self.wfile.write(('data: ' + json.dumps({'error': str(e)}) + '\n\n').encode('utf-8'))
                    self.wfile.flush()
                except Exception:
                    pass
        except (BrokenPipeError, ConnectionResetError):
            pass


def find_port(start):
    for p in range(start, start + 40):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(('127.0.0.1', p))
                return p
            except OSError:
                continue
    raise SystemExit('没有可用端口')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=8765)
    ap.add_argument('--no-browser', action='store_true')
    args = ap.parse_args()
    port = find_port(args.port)
    httpd = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    httpd.daemon_threads = True
    url = f'http://127.0.0.1:{port}/'
    print('=' * 62)
    print('  电力电子学习台（Fundamentals of Power Electronics）')
    print('  本地地址: ' + url)
    print('  教材 PDF : ' + ('已找到' if os.path.exists(PDF_PATH) else '未找到（页面图不可用）'))
    print('  API Key 在页面右上角「设置」里填写（只存本机浏览器）')
    print('  关闭本窗口即停止服务')
    print('=' * 62)
    if not args.no_browser:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print('\n已停止')


if __name__ == '__main__':
    main()
