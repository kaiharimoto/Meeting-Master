"""The VRAM/context arithmetic behind "Fit to your GPU".

Pure functions over numbers Ollama reports, so they are tested directly with
synthetic model metadata — no Ollama, no GPU. The point of these tests is that
the arithmetic is right, because the whole feature exists to stop the operator
guessing.
"""

import pytest

from app.setup import modelfit

GB = modelfit.GB


def info(*, layers=48, kv_heads=8, heads=32, embedding=4096, ctx=32768, key_length=None):
    """model_info as Ollama reports it — architecture-prefixed keys."""
    data = {
        "general.architecture": "testarch",
        "testarch.block_count": layers,
        "testarch.attention.head_count": heads,
        "testarch.attention.head_count_kv": kv_heads,
        "testarch.embedding_length": embedding,
        "testarch.context_length": ctx,
    }
    if key_length:
        data["testarch.attention.key_length"] = key_length
    return data


def test_kv_bytes_per_token_is_the_documented_formula():
    # 2 (K+V) x layers x kv_heads x head_dim x bytes/elem, head_dim = 4096/32.
    expected = 2 * 48 * 8 * 128 * 2.0
    assert modelfit.kv_bytes_per_token(info(), "f16") == expected

    # Quantizing the cache is the big context lever: q8_0 ~half, q4_0 ~quarter.
    assert modelfit.kv_bytes_per_token(info(), "q8_0") == pytest.approx(expected * (34 / 64))
    assert modelfit.kv_bytes_per_token(info(), "q4_0") == pytest.approx(expected * (18 / 64))


def test_grouped_query_attention_is_what_makes_context_cheap():
    """kv_heads, not parameter count, decides the cache cost.

    This is the whole reason the old parameter-count heuristic was wrong: two
    models of identical size differ 4x here.
    """
    many = modelfit.kv_bytes_per_token(info(kv_heads=32), "f16")
    few = modelfit.kv_bytes_per_token(info(kv_heads=8), "f16")
    assert many == 4 * few


def test_explicit_key_length_wins_over_embedding_divided_by_heads():
    # Models whose head_dim isn't embedding/heads state it; trust the statement.
    assert modelfit.kv_bytes_per_token(info(key_length=64), "f16") == 2 * 48 * 8 * 64 * 2.0


def test_incomplete_metadata_is_unknown_not_a_guess():
    assert modelfit.kv_bytes_per_token({}, "f16") is None
    plan = modelfit.plan_model(
        name="mystery:9b", weights_bytes=5 * GB, model_info={},
        vram_bytes=24 * GB,
    )
    assert plan["verdict"] == "unknown"
    assert plan["recommendedCtx"] == 0  # never invent a number
    assert "did not report" in plan["note"]


def test_a_model_that_fits_a_24gb_card_comfortably():
    # ~16 GB of weights on a 24 GB card, cheap KV: full target context.
    plan = modelfit.plan_model(
        name="fits:27b", weights_bytes=16 * GB, model_info=info(),
        vram_bytes=24 * GB, quantization="Q4_K_M", param_size="27B",
    )
    assert plan["verdict"] == "comfortable"
    assert plan["recommendedCtx"] == modelfit.TARGET_CTX
    assert plan["weightsGB"] == 16.0
    # 48 layers x 8 kv heads x 128 head dim x 2 (K+V) x 2 bytes = 192 KiB/token,
    # so ~201 MB per 1k tokens of context — i.e. a 32k context is ~6.4 GB of
    # cache, which is exactly the number the operator needs to see.
    assert plan["kvMBPer1k"] == pytest.approx(201, abs=1)


def test_the_recommendation_leaves_margin_below_the_maximum():
    """A context that *just* fits is the one that spills to CPU on a bad day."""
    plan = modelfit.plan_model(
        name="tight:27b", weights_bytes=20 * GB, model_info=info(ctx=131072),
        vram_bytes=24 * GB,
    )
    assert plan["verdict"] == "tight"
    assert 0 < plan["recommendedCtx"] < plan["maxCtx"]
    assert plan["recommendedCtx"] % 1024 == 0
    assert "overlapping chunks" in plan["note"]


def test_weights_alone_overflowing_the_card_is_refused():
    plan = modelfit.plan_model(
        name="huge:70b", weights_bytes=40 * GB, model_info=info(),
        vram_bytes=24 * GB,
    )
    assert plan["verdict"] == "too big"
    assert plan["recommendedCtx"] == 0
    assert "run partly on the CPU" in plan["note"]


def test_a_model_with_no_room_left_for_a_usable_context_is_refused():
    # Weights fit, but an expensive cache leaves less context than the pipeline
    # can work in — worse than useless, so it must not be recommended.
    plan = modelfit.plan_model(
        name="fat-cache:32b", weights_bytes=22 * GB,
        model_info=info(layers=80, kv_heads=64), vram_bytes=24 * GB,
    )
    assert plan["verdict"] == "too big"
    assert plan["recommendedCtx"] == 0


def test_the_trained_context_is_a_ceiling():
    """Offering more context than the model was trained for is nonsense."""
    plan = modelfit.plan_model(
        name="short:7b", weights_bytes=4 * GB, model_info=info(ctx=8192),
        vram_bytes=24 * GB,
    )
    assert plan["maxCtx"] == 8192
    assert plan["recommendedCtx"] <= 8192


def test_quantizing_the_cache_buys_context_on_the_same_card():
    args = dict(name="m", weights_bytes=18 * GB, model_info=info(ctx=131072),
                vram_bytes=24 * GB)
    f16 = modelfit.plan_model(**args, cache_type="f16")
    q8 = modelfit.plan_model(**args, cache_type="q8_0")
    q4 = modelfit.plan_model(**args, cache_type="q4_0")
    assert q8["maxCtx"] > f16["maxCtx"]
    assert q4["maxCtx"] > q8["maxCtx"]


def test_ranking_prefers_what_actually_fits_over_what_is_biggest():
    plans = [
        modelfit.plan_model(name="huge:70b", weights_bytes=40 * GB,
                            model_info=info(), vram_bytes=24 * GB),
        modelfit.plan_model(name="small:7b", weights_bytes=4 * GB,
                            model_info=info(layers=32), vram_bytes=24 * GB),
        modelfit.plan_model(name="mystery", weights_bytes=5 * GB,
                            model_info={}, vram_bytes=24 * GB),
        modelfit.plan_model(name="tight:27b", weights_bytes=20 * GB,
                            model_info=info(ctx=131072), vram_bytes=24 * GB),
    ]
    ranked = [p["name"] for p in modelfit.rank(plans)]
    assert ranked[0] == "small:7b"          # comfortable first
    assert ranked.index("tight:27b") < ranked.index("mystery")
    assert ranked[-1] == "huge:70b"         # never recommend a CPU spill


def test_loaded_summary_names_a_cpu_spill_out_loud():
    """The single most useful diagnostic for "the AI is slow"."""
    loaded = modelfit.loaded_summary({
        "models": [
            {"name": "fits:27b", "size": 18 * GB, "size_vram": 18 * GB,
             "context_length": 32768},
            {"name": "spilled:70b", "size": 40 * GB, "size_vram": 20 * GB},
        ]
    })
    assert loaded[0]["fullyOnGpu"] is True
    assert loaded[0]["onGpuPercent"] == 100
    assert loaded[0]["contextLength"] == 32768
    assert loaded[1]["fullyOnGpu"] is False
    assert loaded[1]["onGpuPercent"] == 50


def test_loaded_summary_tolerates_an_older_ollama():
    assert modelfit.loaded_summary({}) == []
    assert modelfit.loaded_summary({"models": []}) == []
    # No size_vram at all (very old): reported, not crashed, and not claimed
    # to be on the GPU.
    only = modelfit.loaded_summary({"models": [{"name": "x", "size": GB}]})
    assert only[0]["fullyOnGpu"] is False
