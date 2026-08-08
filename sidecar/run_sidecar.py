from __future__ import annotations

import sys
import subprocess
from pathlib import Path


SIDECAR_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SIDECAR_DIR))

REQUIREMENTS = [
    "fastapi>=0.115.0",
    "uvicorn>=0.34.0",
    "pydantic>=2.10.0",
    "pydantic-settings>=2.7.0",
    "requests>=2.32.0",
    "psutil>=6.1.0",
    "keyring>=25.6.0",
]
IMPORT_CHECKS = ["fastapi", "uvicorn", "pydantic", "requests", "psutil", "keyring"]


def ensure_runtime_dependencies() -> None:
    missing = []
    for module in IMPORT_CHECKS:
        try:
            __import__(module)
        except ModuleNotFoundError:
            missing.append(module)
    if not missing:
        return
    print(f"Installing sidecar Python dependencies: {', '.join(missing)}", flush=True)
    subprocess.check_call([sys.executable, "-m", "pip", "install", *REQUIREMENTS])


if __name__ == "__main__":
    ensure_runtime_dependencies()
    import uvicorn

    uvicorn.run("raylab_sidecar.main:app", host="127.0.0.1", port=8765, log_level="info")
