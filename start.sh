#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

if ! command -v python3 >/dev/null 2>&1; then
  echo "未找到 python3，请先安装 Python 3.9+"
  exit 1
fi

python3 -m pip install -r requirements.txt

if [ ! -f data/book.json ]; then
  echo "首次运行：正在从 PDF 构建教材数据（需要项目根目录有 book.pdf 或 config.json）..."
  python3 tools/build_book.py
fi

exec python3 server.py "$@"
