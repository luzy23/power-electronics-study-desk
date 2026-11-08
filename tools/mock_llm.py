# -*- coding: utf-8 -*-
"""本地 mock 的 OpenAI 兼容接口，用于验证学习台的链路（不调用真实 API）。"""
import json
import os
import time
import sys
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

MODELS = ['deepseek-flash', 'deepseek-v4-pro']
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8790

REPLY = """## 本地 mock 模型回复

这是一段用于验证链路的示例内容，包含 **Markdown** 与公式。

### 公式
$$M(D)=\\frac{1}{1-D}$$

- 伏秒平衡：$\\langle v_L \\rangle = 0$
- 电荷平衡：$\\langle i_C \\rangle = 0$

| 项 | 含义 |
| --- | --- |
| $D$ | duty cycle（占空比） |
"""


class H(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *a):
        pass

    def _json(self, obj, code=200):
        data = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.startswith('/v1/models'):
            self._json({'data': [{'id': m, 'object': 'model'} for m in MODELS]})
        else:
            self._json({'error': {'message': 'not found'}}, 404)

    def do_POST(self):
        if not self.path.startswith('/v1/chat/completions'):
            self._json({'error': {'message': 'not found'}}, 404)
            return
        n = int(self.headers.get('Content-Length') or 0)
        payload = json.loads(self.rfile.read(n) or b'{}')
        # 记录请求，方便核对提示词是否按预期发送
        try:
            with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), '_mock_log.jsonl'), 'a', encoding='utf-8') as f:
                f.write(json.dumps({'model': payload.get('model'),
                                    'max_tokens': payload.get('max_tokens'),
                                    'stream': payload.get('stream'),
                                    'messages': payload.get('messages')}, ensure_ascii=False) + '\n')
        except Exception:
            pass
        model = payload.get('model')
        if model not in MODELS:
            self._json({
                'error': {
                    'message': 'The supported API model names are %s, but you passed %s.'
                               % (', '.join(MODELS), model),
                    'type': 'invalid_request_error',
                    'param': None,
                    'code': 'invalid_request_error'
                }
            }, 400)
            return
        if not payload.get('stream'):
            self._json({'choices': [{'message': {'content': '可用'}}]})
            return
        self.close_connection = True
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream; charset=utf-8')
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('Connection', 'close')
        self.end_headers()
        for i in range(0, len(REPLY), 10):
            chunk = {'choices': [{'delta': {'content': REPLY[i:i + 10]}}]}
            self.wfile.write(('data: ' + json.dumps(chunk, ensure_ascii=False) + '\n\n').encode('utf-8'))
            self.wfile.flush()
            time.sleep(0.008)
        self.wfile.write(b'data: [DONE]\n\n')
        self.wfile.flush()


if __name__ == '__main__':
    srv = ThreadingHTTPServer(('127.0.0.1', PORT), H)
    srv.daemon_threads = True
    print('mock llm on http://127.0.0.1:%d/v1  models=%s' % (PORT, MODELS))
    srv.serve_forever()
