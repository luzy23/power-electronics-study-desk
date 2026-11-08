@echo off
chcp 65001 >nul
title 电力电子学习台 - Fundamentals of Power Electronics
cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 (
  echo.
  echo [错误] 没有找到 python。
  echo 请先安装 Python 3.9 以上版本，安装时勾选 "Add Python to PATH"。
  echo 下载地址: https://www.python.org/downloads/
  echo.
  pause
  exit /b 1
)

python -c "import pymupdf" >nul 2>nul
if errorlevel 1 (
  echo 首次运行：正在安装 PDF 解析依赖 pymupdf ...
  python -m pip install -r requirements.txt
)

if not exist "data\book.json" (
  if not exist "book.pdf" if not exist "config.json" (
    echo.
    echo [提示] 没有找到教材 PDF。
    echo 本项目不附带教材，请使用你自己合法获得的 PDF：
    echo   1^) 把 PDF 放到本目录并命名为 book.pdf
    echo   2^) 或复制 config.example.json 为 config.json，把 pdf 改成你的路径
    echo 准备好后重新双击本文件。
    echo.
    pause
    exit /b 1
  )
  echo 首次运行：正在从 PDF 构建教材数据，约 1-3 分钟 ...
  python tools\build_book.py
  if errorlevel 1 (
    echo 构建失败，请检查上面的报错。
    pause
    exit /b 1
  )
)

python server.py %*
pause
