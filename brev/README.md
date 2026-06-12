# Running NeMo-Ray on a Brev cloud instance (no DGX Spark, no NVFP4)

The cloud mirror of `spark/` for when you don't have a GB10 to hand. Same stack —
Sionna RT pipeline, coverage twin, Nemotron agent bridge, Next.js HUD — on an x86
GPU instance with **discrete VRAM** and **without NVFP4** (NVFP4 needs Blackwell;
Hopper/Ampere cloud GPUs serve the model in BF16 or FP8 instead).

## Picking an instance

The Sionna solve itself is light (~2 GB VRAM). The sizing question is entirely
**which Nemotron you serve**:

| GPUs | Nemotron profile | How |
|---|---|---|
| 2× H200 (141 GB) | **Super 120B BF16** (~240 GB weights) | `--tensor-parallel-size 2` (the default script auto-detects) |
| 4× H100 (80 GB) | **Super 120B BF16** | `--tensor-parallel-size 4` |
| 1× H200 / 2× H100 | **Super 120B FP8** (~120 GB) | `QUANT=fp8 brev/serve-nemotron.sh` — vLLM quantises on the fly on Hopper; if your vLLM build rejects FP8 for this architecture, fall back to BF16 on more GPUs |
| 1× H100/A100 80 GB | Super does **not** fit | serve any OpenAI-compatible model you like and point `NEMOTRON_BASE_URL`/`NEMOTRON_MODEL` at it — the agent only needs the wire format (quality will differ from Super) |

CPU/RAM: ≥16 vCPU, ≥64 GB RAM, ≥400 GB disk (BF16 weights are ~240 GB on disk).

## Steps

```bash
# on the Brev instance (Ubuntu, NVIDIA driver + docker preinstalled by the image)
git clone https://github.com/Harrishayy/NeMo-Ray.git && cd NeMo-Ray
git lfs pull                       # seed artifacts + OSM/building data

cp .env.example .env               # set CUOPT_API_KEY (hosted MILP); HF_TOKEN optional
nano .env

bash brev/setup.sh                 # venvs (clean x86 CUDA wheels — NOT the Spark path)

bash spark/run-pipeline.sh         # coverage solve → nemoray/public/raytracing/*
bash brev/up.sh --hud              # nemotron (BF16/FP8) + twin + agent + HUD
# first run downloads the weights (~240 GB BF16) — watch: docker logs -f nemoray-nemotron

# open http://localhost:3000  (or tunnel: brev port-forward / ssh -L 3000:localhost:3000)
bash brev/down.sh                  # stop everything
```

## Differences from the Spark

- **Precision**: BF16 (or on-the-fly FP8) via the same vLLM container — no NVFP4
  flags, no `nano_v3`/NVFP4 checkpoints. The served name stays `nemotron-3-super`,
  so nothing else in the stack changes.
- **Memory model**: discrete VRAM, so vLLM's default `--gpu-memory-utilization 0.9`
  is correct here (the Spark's 0.75 exists because of its CPU+GPU unified pool).
  Solves and the NIM don't compete for one memory pool.
- **Venvs**: clean x86 CUDA wheels via `uv pip` (`brev/setup.sh`). Do NOT use
  `spark/setup.sh` — its `--system-site-packages` venv is a GB10/aarch64 workaround.
- **Everything else is shared**: the twin, agent bridge and HUD launchers are the
  same scripts (`spark/serve-twin.sh`, `spark/serve-agent.sh`, `spark/serve-hud.sh`),
  driven by `brev/up.sh`.
