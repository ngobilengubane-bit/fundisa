#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created backend/.env for local development."
  echo "The backend will start with a temporary local admin credential."
  echo "Add GEMINI_API_KEY to backend/.env to enable the live AI features."
fi
node server.js
