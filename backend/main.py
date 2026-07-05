import os
import sys

import uvicorn
from dotenv import load_dotenv

load_dotenv()

# Ensure the SDK package is importable from the project root
_project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_sdk_path = os.path.join(_project_root, "sdk")
if _sdk_path not in sys.path:
    sys.path.insert(0, _sdk_path)

if __name__ == "__main__":
    port = int(os.getenv("PORT", "8050"))
    # Canonical ASGI target: backend/app/api/main.py
    # Run from the project root: PORT=8050 python backend/main.py
    # Or directly: PYTHONPATH=./backend uvicorn app.api.main:app --host 127.0.0.1 --port 8050 --reload
    uvicorn.run("app.api.main:app", host="127.0.0.1", port=port, reload=True)
