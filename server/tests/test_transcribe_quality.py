"""Transcript damage that would otherwise become notes silently.

Whisper hallucinates a filler phrase over quiet or non-speech audio and, with
prompt carry-over on, repeats it — sometimes for pages. The transcript still
looks like a transcript, so it flows into the summary and the Q&A extraction as
if it were speech, and the notes come out thin and strange with no clue why.
"""

from app.models import TranscriptSegment
from app.pipeline import transcribe


def seg(text, start=0.0):
    return TranscriptSegment(start=start, end=start + 2.0, text=text)


def test_a_real_conversation_is_not_flagged():
    segments = [
        seg("So where did the renewal quote land?"),
        seg("Twelve percent up, locked for twenty-four months."),
        seg("Right. And the migration deadline?"),
        seg("November fifteenth, with a two week buffer."),
        seg("Okay."),
        seg("Okay."),  # people do repeat themselves a little
    ]
    assert transcribe.detect_repetition_loop(segments) is None


def test_the_loop_is_caught_and_quoted_back():
    segments = [seg("Let's get started.")] + [seg("I don't know.")] * 40
    warning = transcribe.detect_repetition_loop(segments)
    assert warning is not None
    assert "I don't know." in warning
    assert "40 times in a row" in warning
    # It has to say what to DO, not just that something is wrong.
    assert "levels" in warning and "WHISPER_MAX_CONTEXT" in warning


def test_repetition_must_be_consecutive_to_count():
    """A phrase used often across a meeting is speech; back-to-back is a loop."""
    scattered = []
    for i in range(20):
        scattered.append(seg("Yeah."))
        scattered.append(seg(f"Point number {i} about the contract."))
    assert transcribe.detect_repetition_loop(scattered) is None


def test_case_and_padding_do_not_hide_a_loop():
    segments = [seg(" I don't know. "), seg("i don't know."), seg("I DON'T KNOW.")] * 3
    assert transcribe.detect_repetition_loop(segments) is not None


def test_blank_segments_do_not_break_a_run_or_start_one():
    # whisper emits empty segments for silence; they are neither speech nor loop.
    assert transcribe.detect_repetition_loop([seg("")] * 30) is None
    segments = [seg("Mm-hmm.")] * 3 + [seg("")] + [seg("Mm-hmm.")] * 3
    assert transcribe.detect_repetition_loop(segments) is not None


def test_an_empty_transcript_is_clean_not_crashing():
    assert transcribe.detect_repetition_loop([]) is None


def test_carry_over_is_disabled_by_default():
    """WHISPER_MAX_CONTEXT=0 is the actual fix, not just the detection.

    Carry-over is what makes a loop self-sustaining: the filler phrase lands in
    the prompt for the next window, which makes it likelier again.
    """
    from app.config import Settings

    assert Settings().WHISPER_MAX_CONTEXT == 0
