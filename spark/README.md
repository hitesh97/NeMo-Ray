# Running NeMo-Ray locally on an NVIDIA DGX Spark (GB10)

Run the whole NeMo-Ray stack on **one local DGX Spark**, all on-device. (`brev/` is the
cloud-H200 mirror for when you don't have the Spark to hand.)

1. **Sionna RT coverage pipeline** (`src/`) — generates `nemoray/public/raytracing/*`.
2. **Nemotron agent stack:**
   - **NIM** — `scripts/serve_nemotron.sh` (vLLM **NVFP4** in Docker, already GB10-tuned) on **:8080**
   - **twin** — `python -m src.serve` on **:8000** (`TWIN_URL`, drives the re-sim API)
   - **agent** — `agent/` SSE bridge on **:8001** (`AGENT_PORT`)
   - **HUD** — Next.js on **:3000**

> **Why the Spark:** the GB10's **128 GB unified memory** holds the Sionna
> radio-map buffers **and** the Nemotron context in one shared pool — no host↔device copies —
> while **all inference stays local** (privacy + latency for an emergency-services operator).

## The box

**GB10 Grace Blackwell, aarch64, CUDA 13, ~128 GB unified memory** (CPU+GPU share one pool).
DGX OS ships the driver, Docker, and the NVIDIA container runtime, so there's no toolkit build
to do. On the GB10 `nvidia-smi` reports `memory.total` as **N/A** (unified) — that's expected.

Unlike a Brev instance, **the Spark is persistent**: provision once, nothing is lost on stop,
and the ~62 GB NVFP4 weight cache lives on local NVMe under `~/.cache/huggingface`.

## Software config

Everything is preinstalled on DGX OS (verify Docker's GPU runtime with `docker info` →
`Runtimes: nvidia`). `spark/setup.sh` installs the rest: the Sionna `.venv`
(**`--system-site-packages`**, so it sees the system CUDA/Mitsuba on aarch64), the agent venv
(`uv sync`), and it pre-pulls the multi-arch vLLM image.

> ⚠️ The Sionna venv on the Spark is **not** the same as on Brev. Brev installs clean CUDA
> wheels via `uv pip` (x86). On the GB10 the CUDA/Mitsuba stack comes from the **system**, so
> the venv must include `--system-site-packages`. `setup.sh` handles this — don't "fix" it to
> the Brev path.

## Step by step (on the Spark)

```bash
cd ~/NeMo-Ray
cp .env.example .env           # set CUOPT_API_KEY (for --opt). NEMOTRON_MODEL=nemotron-3-super.
nano .env

bash spark/setup.sh            # provisions both workloads (idempotent; first time only)

bash spark/run-pipeline.sh     # coverage solve → public/raytracing/* (add --opt for cuOpt+verify)

# One command for the whole serving stack (detached, logs in ~/nemoray-logs):
bash spark/up.sh --hud         # nemotron super (120B NVFP4) + twin + agent + HUD
#   …or run each in its own terminal:
#   bash spark/serve-nemotron.sh   # vLLM NVFP4 super (120B) on :8080
#   bash spark/serve-twin.sh       # twin on :8000
#   bash spark/serve-agent.sh      # agent SSE on :8001
#   bash spark/serve-hud.sh        # HUD on :3000

curl -s localhost:8080/v1/models   # NIM is ready once it lists the model (first run downloads weights)
bash spark/down.sh             # stop everything
```

It's all local — open the HUD at **<http://localhost:3000>**. The HUD proxies its agent calls
to `:8001`, which talks to the twin on `:8000` and Nemotron on `:8080`.

**Viewing from a laptop on the LAN** (services bind `0.0.0.0`):

```bash
ssh -L 3000:localhost:3000 -L 8001:localhost:8001 <spark-host>
# then open http://localhost:3000 on the laptop
```

## The model

The stack runs **Nemotron-3 Super (120B-A12B, NVFP4)** locally via vLLM — ~78 GB of weights
at `gpu-memory-utilization 0.85`, owning most of the 121 GB unified pool. Run the Sionna
pipeline FIRST (`spark/run-pipeline.sh`), then bring the NIM up; avoid launching heavy
solves while the model is loading. Live re-simulation via the twin (`/api/coverage`) uses
only ~2 GB and co-exists fine once the NIM is resident.

## Files

| File | Does |
|---|---|
| `setup.sh` | Provision the Spark: data (LFS), Sionna venv (`--system-site-packages`), agent venv, pull the vLLM image |
| `up.sh` / `down.sh` | One-command bring-up / teardown of the whole serving stack (detached) |
| `run-pipeline.sh` | Sionna solve for `westminster_canary` (+ `--opt` for cuOpt+verify) |
| `serve-nemotron.sh` | vLLM NVFP4 NIM (Nemotron-3 Super 120B) on :8080 — wraps `scripts/serve_nemotron.sh` |
| `serve-twin.sh` | Coverage twin (`python -m src.serve`) on :8000 |
| `serve-agent.sh` | Agent SSE bridge (`agent/`) on :8001 |
| `serve-hud.sh` | Next.js HUD on :3000 |

Config/secrets come from the **root `.env`** (`cp .env.example .env`). Never commit real keys.
