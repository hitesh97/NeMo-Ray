"""Configuration loading. Thin wrapper around config.yaml."""
from __future__ import annotations

import os
from dataclasses import dataclass

import yaml

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load_config(path: str | None = None) -> dict:
    path = path or os.path.join(ROOT, "config.yaml")
    with open(path) as f:
        cfg = yaml.safe_load(f)
    # Resolve relative paths against the project root.
    p = cfg["paths"]
    for k, v in p.items():
        if isinstance(v, str) and not os.path.isabs(v):
            p[k] = os.path.join(ROOT, v)
    cfg["_root"] = ROOT
    return cfg
