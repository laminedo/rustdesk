#!/bin/bash
# Double-click this file in Finder to start Remote on a Mac.
cd "$(dirname "$0")"
if [ ! -d .venv ]; then
  echo "First run: installing (takes a minute)..."
  python3 -m venv .venv && .venv/bin/pip install -q -r requirements.txt || { echo "Install failed."; read -r; exit 1; }
fi
.venv/bin/python server.py "$@"
