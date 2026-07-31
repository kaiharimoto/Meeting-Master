"""Fit a model + context window to the GPU you actually have.

The dashboard's old "Suggest settings" button guessed a context window from the
parameter count alone (>=20B → 16384, and so on). That is the wrong variable:
what fills VRAM is the WEIGHTS plus the KV cache, and the KV cache per token
depends on the model's layer count, its number of key/value heads, and the head
dimension — three numbers Ollama will tell us. Two 27B models can differ by 4x
in KV cost per token, so a parameter-count rule of thumb is guaranteed to be
badly wrong for some of them.

So this module does the arithmetic properly, from ``/api/show`` metadata:

    KV bytes per token = 2 (K and V) x layers x kv_heads x head_dim x bytes/elem

and then the largest context that fits:

    max_ctx = (VRAM - weights - headroom) / KV bytes per token

Everything here is pure arithmetic over numbers the server was given — no
hard-coded model catalogue to go stale, and no guessing. Models this server has
never seen are handled the same way as the ones it has.

NOTE: this predicts. ``/api/ps`` (see loaded_summary) reports what Ollama
ACTUALLY did, including whether it had to push layers onto the CPU, and that
readout is the ground truth the dashboard shows alongside these estimates.
"""

from __future__ import annotations

# Bytes per stored element for each KV cache type Ollama supports. The quantized
# ones are block formats: q8_0 is 32 values + one f16 scale = 34 bytes / 32
# values, q4_0 is 16 bytes + one f16 scale = 18 bytes / 32 values.
KV_CACHE_BYTES = {
    "f16": 2.0,
    "q8_0": 34 / 32,
    "q4_0": 18 / 32,
}

# Held back for CUDA/ROCm compute buffers, the graph, and fragmentation. Scales
# a little with context; a flat allowance is honest at this precision and errs
# toward leaving the card some room.
HEADROOM_BYTES = 1_200_000_000

GB = 1_000_000_000

# Contexts are reported rounded down to this, so the numbers look like settings
# a person would type rather than 17_408.
_CTX_GRANULARITY = 1024

# Below this a transcript stops fitting in any useful piece — see
# _ollama.MIN_INPUT_BUDGET_TOKENS, which is the same argument from the pipeline
# side. A model that cannot reach this on the operator's card is not usable
# here, however good it is.
MIN_USABLE_CTX = 4096

# What the pipeline wants if the card can afford it. Beyond this the chunked
# map-reduce path handles longer transcripts perfectly well, so more context
# buys latency, not quality.
TARGET_CTX = 32768


def _metric(model_info: dict, suffix: str) -> int | None:
    """A numeric value from Ollama's model_info by key SUFFIX.

    Keys are architecture-prefixed ("llama.block_count", "gemma3.block_count",
    …), so matching on the suffix is what makes this work for architectures
    this code has never heard of.
    """
    if not isinstance(model_info, dict):
        return None
    for key, value in model_info.items():
        if key.endswith(suffix) and isinstance(value, (int, float)) and value > 0:
            return int(value)
    return None


def kv_bytes_per_token(model_info: dict, cache_type: str = "f16") -> float | None:
    """KV cache cost of ONE token, or None when the metadata is incomplete."""
    layers = _metric(model_info, ".block_count")
    kv_heads = _metric(model_info, ".attention.head_count_kv")
    heads = _metric(model_info, ".attention.head_count")
    embedding = _metric(model_info, ".embedding_length")
    if not layers or not kv_heads:
        return None
    # Prefer the explicit key/value length when the model states it (models with
    # a head_dim that isn't embedding/heads — MLA and friends — need this).
    head_dim = _metric(model_info, ".attention.key_length")
    if not head_dim:
        if not heads or not embedding:
            return None
        head_dim = embedding // heads
    per_element = KV_CACHE_BYTES.get(cache_type, KV_CACHE_BYTES["f16"])
    return 2 * layers * kv_heads * head_dim * per_element


def _floor_to(value: int, step: int = _CTX_GRANULARITY) -> int:
    return (value // step) * step


def plan_model(
    *,
    name: str,
    weights_bytes: int,
    model_info: dict,
    vram_bytes: int,
    cache_type: str = "f16",
    quantization: str = "",
    param_size: str = "",
    headroom_bytes: int = HEADROOM_BYTES,
) -> dict:
    """One model's verdict on this card. Never raises — an unknown shape is
    reported as unknown, because a missing number must not look like a fit."""
    kv_per_token = kv_bytes_per_token(model_info, cache_type)
    trained_ctx = _metric(model_info, ".context_length") or 0
    spare = vram_bytes - weights_bytes - headroom_bytes

    out = {
        "name": name,
        "paramSize": param_size,
        "quantization": quantization,
        "weightsGB": round(weights_bytes / GB, 1),
        "trainedCtx": trained_ctx,
        "kvCache": cache_type,
        "kvMBPer1k": round(kv_per_token * 1024 / 1_000_000, 1) if kv_per_token else None,
        "maxCtx": 0,
        "recommendedCtx": 0,
        "verdict": "unknown",
        "note": "",
    }

    if kv_per_token is None:
        out["note"] = (
            "Ollama did not report this model's layer/head counts, so its "
            "context cost can't be computed. Set a context window by hand and "
            "use 'Test AI now' to confirm it loads."
        )
        return out

    if spare <= 0:
        out["verdict"] = "too big"
        out["note"] = (
            f"The weights alone ({out['weightsGB']} GB) plus compute headroom "
            f"exceed {round(vram_bytes / GB, 1)} GB of VRAM — this model would "
            "run partly on the CPU, which is many times slower. Choose a "
            "smaller model or a smaller quantization."
        )
        return out

    fits = _floor_to(int(spare // kv_per_token))
    if trained_ctx:
        fits = min(fits, _floor_to(trained_ctx))
    out["maxCtx"] = fits

    if fits < MIN_USABLE_CTX:
        out["verdict"] = "too big"
        out["note"] = (
            f"Only {fits} tokens of context fit after the weights, below the "
            f"{MIN_USABLE_CTX} this pipeline needs to work in. A smaller model "
            "or quantization, or a quantized KV cache, would fix it."
        )
        return out

    if fits >= TARGET_CTX:
        # The target is already well under what fits, so it carries its own
        # margin — no need to shave it further.
        recommended = TARGET_CTX
    else:
        # Leave a margin below the theoretical maximum: this is arithmetic, not
        # a measurement, and a context that *just* fits is the one that spills
        # to the CPU on a bad day.
        recommended = _floor_to(int(fits * 0.85))
    out["recommendedCtx"] = max(recommended, MIN_USABLE_CTX)

    if fits >= TARGET_CTX:
        out["verdict"] = "comfortable"
        capped = bool(trained_ctx) and fits >= _floor_to(trained_ctx)
        out["note"] = (
            f"Fits the full {TARGET_CTX} context"
            + (
                " — that is everything this model was trained for."
                if capped
                else f", with room for up to about {fits} tokens."
            )
        )
    else:
        out["verdict"] = "tight"
        out["note"] = (
            f"About {fits} tokens of context fit. Long meetings are summarized "
            "in overlapping chunks automatically, so this is slower on a long "
            "recording but not less accurate."
        )
    return out


def rank(plans: list[dict]) -> list[dict]:
    """Best first: usable models by how much context they afford, then the rest.

    Deliberately NOT by parameter count — a model that has to spill onto the
    CPU is worse in practice than a smaller one that fits, whatever its
    benchmark scores say.
    """
    order = {"comfortable": 0, "tight": 1, "unknown": 2, "too big": 3}
    return sorted(
        plans,
        key=lambda p: (order.get(p["verdict"], 9), -(p.get("maxCtx") or 0), p["name"]),
    )


def loaded_summary(ps_payload: dict) -> list[dict]:
    """What Ollama has resident RIGHT NOW, from ``GET /api/ps``.

    The one number worth staring at is ``onGpuPercent``: Ollama silently runs a
    model that doesn't fit partly on the CPU, which reads as "the AI is slow"
    rather than as a configuration error. The dashboard says it out loud.
    """
    out = []
    for entry in (ps_payload or {}).get("models") or []:
        total = int(entry.get("size") or 0)
        in_vram = int(entry.get("size_vram") or 0)
        percent = round(in_vram / total * 100) if total else None
        out.append({
            "name": entry.get("name") or entry.get("model") or "",
            "sizeGB": round(total / GB, 1),
            "vramGB": round(in_vram / GB, 1),
            "onGpuPercent": percent,
            "contextLength": int(entry.get("context_length") or 0) or None,
            "fullyOnGpu": bool(total) and in_vram >= total,
        })
    return out
