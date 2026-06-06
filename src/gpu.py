"""Lightweight GPU telemetry: samples GPU utilisation and this process's GPU memory
while heavy Sionna RT computation runs.

On the GB10 (unified memory) nvidia-smi reports total memory as N/A, but per-process
GPU memory (`--query-compute-apps`) and `utilization.gpu` are both available.
"""
from __future__ import annotations

import os
import subprocess
import threading
import time


def _smi(args: list[str]) -> str:
    try:
        return subprocess.run(["nvidia-smi", *args], capture_output=True,
                              text=True, timeout=3).stdout
    except Exception:
        return ""


def device_name() -> str:
    out = _smi(["--query-gpu=name", "--format=csv,noheader"]).strip()
    return out.split("\n")[0] if out else "unknown"


class GpuMonitor:
    """Background sampler. Use as a context manager around the heavy section."""

    def __init__(self, interval: float = 0.2):
        self.pid = os.getpid()
        self.interval = interval
        self._stop = False
        self._thread: threading.Thread | None = None
        self.util: list[int] = []      # GPU utilisation %, every sample
        self.mem: list[int] = []       # this process's GPU memory (MiB), when reported

    def _gpu_util(self) -> int:
        out = _smi(["--query-gpu=utilization.gpu", "--format=csv,noheader,nounits"])
        try:
            return int(out.strip().split("\n")[0])
        except Exception:
            return 0

    def _proc_mem(self):
        out = _smi(["--query-compute-apps=pid,used_gpu_memory",
                    "--format=csv,noheader,nounits"])
        for line in out.strip().split("\n"):
            parts = [p.strip() for p in line.split(",")]
            if len(parts) == 2 and parts[0] == str(self.pid):
                try:
                    return int(parts[1])
                except ValueError:
                    return None
        return None

    def _run(self):
        while not self._stop:
            self.util.append(self._gpu_util())
            m = self._proc_mem()
            if m is not None:
                self.mem.append(m)
            time.sleep(self.interval)

    def start(self):
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()
        return self

    def stop(self):
        self._stop = True
        if self._thread:
            self._thread.join(timeout=2)

    def __enter__(self):
        return self.start()

    def __exit__(self, *exc):
        self.stop()

    def summary(self) -> dict:
        active = [u for u in self.util if u > 5]      # samples while the GPU was busy
        return {
            "peak_gpu_util_pct": max(self.util) if self.util else None,
            "mean_gpu_util_pct": round(sum(active) / len(active), 1) if active else None,
            "peak_gpu_mem_mib": max(self.mem) if self.mem else None,
            "samples": len(self.util),
        }
