# 贡献指南

感谢愿意改进这个学习工具！提交前请先看下面几条。

## 本地开发

```bash
python -m pip install -r requirements.txt
# 需要你自己合法获得的教材 PDF：放到项目根目录 book.pdf，或写 config.json
python tools/build_book.py      # 首次构建 data/（约 1–3 分钟）
python server.py --port 8765
```

前端是原生 JS，改 `static/` 后刷新页面即可（`Ctrl+F5` 清缓存）。

## 不要提交的内容

- 教材 PDF、`data/`、`_cache/`（版权 + 体积原因，已在 `.gitignore`）
- API Key、个人 API 地址
- 个人学习数据（`backups/`、截图里的真实笔记）

## 提交前自测

```bash
python -m py_compile server.py tools/build_book.py tools/verify_book.py tools/mock_llm.py
for f in static/js/*.js; do node --check "$f"; done
python tools/verify_book.py        # 需要先构建 data/
```

新增页面/交互建议附截图。

## 方向

- 提取质量（图表/公式/习题切分）的改进
- 提示词与学习流程的可配置化
- 新的学习功能（但保持本地优先、隐私友好）
- 文档、截图、英文翻译

## 行为准则

友善、就事论事；不要提交受版权保护的教材内容。
