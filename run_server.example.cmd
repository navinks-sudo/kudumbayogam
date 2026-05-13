@echo off
REM Copy this file to run_server.cmd and fill in your real key.
REM run_server.cmd is gitignored so secrets stay local.

cd /d "%~dp0"

REM ============================================================
REM  Required: a Gemini API key (https://aistudio.google.com/apikey)
REM ============================================================
set GEMINI_API_KEY=PUT_YOUR_KEY_HERE

REM Models — defaults work; override if you have a custom plan.
REM   gemini-2.5-flash       — best for OCR (rotates, handles ornaments)
REM   gemini-2.5-flash-lite  — cheap chat/translate
set GEMINI_OCR_MODEL=gemini-2.5-flash
set GEMINI_CHAT_MODEL=gemini-2.5-flash-lite
set GEMINI_FAST_MODEL=gemini-2.5-flash-lite

set PYTHONUNBUFFERED=1
python -m uvicorn server:app --host 127.0.0.1 --port 5434 --log-level info > server_out.log 2>&1
