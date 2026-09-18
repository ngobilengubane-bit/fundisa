@echo off
cd /d "%~dp0"
if not exist .env (
  copy .env.example .env >nul
  echo Created backend\.env for local development.
  echo The backend will start with a temporary local admin credential.
  echo Add GEMINI_API_KEY to backend\.env to enable the live AI features.
)
node server.js
pause
