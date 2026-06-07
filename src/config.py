"""Configuration loading. Thin wrapper around config.yaml."""
from __future__ import annotations

import os
from dataclasses import dataclass

import yaml

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _load_dotenv() -> None:
    """Best-effort load of a project-root .env into os.environ (no dependency).

    Only sets keys that aren't already in the real environment, so a real env var
    always wins. Secrets (cuOpt/NGC keys) live here, never in tracked config.yaml.
    """
    env_path = os.path.join(ROOT, ".env")
    if not os.path.isfile(env_path):
        return
    with open(env_path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            key, val = key.strip(), val.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = val


def load_config(path: str | None = None) -> dict:
    _load_dotenv()
    path = path or os.path.join(ROOT, "config.yaml")
    with open(path) as f:
        cfg = yaml.safe_load(f)
    # Resolve relative paths against the project root.
    p = cfg["paths"]
    for k, v in p.items():
        if isinstance(v, str) and not os.path.isabs(v):
            p[k] = os.path.join(ROOT, v)
    # Secrets: prefer the environment (.env) over the tracked placeholder in config.yaml.
    env_key = os.environ.get("CUOPT_API_KEY")
    if env_key:
        cfg.setdefault("cuopt", {})["api_key"] = env_key
    cfg["_root"] = ROOT
    return cfg
