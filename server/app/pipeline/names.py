"""Transcript name tools.

Whisper guesses names from audio, so one person arrives as "Kai", "Ky" and
"Kye". Before the AI stages run (and hallucinate structure around the wrong
names), the operator reviews every candidate name the transcript contains and
merges/corrects them — these helpers find the candidates and apply the fixes.
"""

import re

from ..models import MeetingMeta, Transcript

# Capitalized words that are almost never names in meeting speech. Small on
# purpose: a false candidate costs one glance; a filtered-out real name costs
# a wrong PDF.
_STOPWORDS = {
    "i", "a", "an", "the", "and", "but", "or", "so", "if", "then", "than",
    "we", "you", "he", "she", "it", "they", "them", "us", "our", "your",
    "my", "his", "her", "its", "their", "me", "him", "who", "what", "when",
    "where", "why", "how", "which", "that", "this", "these", "those",
    "there", "here", "now", "today", "tomorrow", "yesterday", "yes", "no",
    "not", "okay", "ok", "yeah", "yep", "well", "right", "sure", "thanks",
    "thank", "please", "hello", "hi", "hey", "bye", "let", "lets", "just",
    "like", "also", "again", "still", "maybe", "perhaps", "actually",
    "basically", "anyway", "alright", "all", "everyone", "everybody",
    "someone", "somebody", "anything", "something", "nothing", "one", "two",
    "three", "monday", "tuesday", "wednesday", "thursday", "friday",
    "saturday", "sunday", "january", "february", "march", "april", "may",
    "june", "july", "august", "september", "october", "november", "december",
    "q1", "q2", "q3", "q4", "am", "pm", "is", "was", "are", "were", "do",
    "does", "did", "can", "could", "will", "would", "should", "have", "has",
    "had", "be", "been", "get", "got", "go", "going", "gonna", "want",
    "need", "think", "know", "see", "look", "good", "great", "new", "next",
    "last", "first", "second", "third",
}

_WORD_RE = re.compile(r"[A-Za-z][a-z']{1,24}")


def _levenshtein(a: str, b: str, cap: int = 3) -> int:
    """Tiny bounded edit distance — names are short, inputs are few."""
    if abs(len(a) - len(b)) > cap:
        return cap + 1
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        if min(cur) > cap:
            return cap + 1
        prev = cur
    return prev[-1]


def _closest_attendee(name: str, attendees: list[str]) -> str:
    """The attendee this token most likely means, or "" if none is close.
    First names count: "Kai" matches attendee "Kai Harimoto"."""
    low = name.lower()
    best, best_d = "", 3
    for attendee in attendees:
        for part in [attendee] + attendee.split():
            d = _levenshtein(low, part.lower(), cap=2)
            # Short names tolerate less fuzz: "Ky"->"Kai" (d=2, len 2-3) is
            # plausible; "Bob"->"Rob" (d=1) is a different person — require
            # a shared initial so we only bridge sound-alike spellings.
            if d < best_d and part and low[0] == part[0].lower():
                best, best_d = attendee, d
    return best if best.lower() != low else ""


def candidate_names(transcript_text: str, meeting: MeetingMeta) -> list[dict]:
    """Candidate person names in the transcript, most frequent first.

    Heuristic: capitalized tokens that appear MID-sentence (not just after
    .!? or a newline), minus a stopword list. Attendees are always included
    (count = their transcript occurrences, possibly 0) since they are the
    canonical spellings the operator merges INTO.
    """
    attendees = list(meeting.details.attendees or [])
    counts: dict[str, int] = {}
    mid_sentence: set[str] = set()
    for match in _WORD_RE.finditer(transcript_text or ""):
        word = match.group(0)
        if not word[0].isupper():
            continue
        low = word.lower()
        if low in _STOPWORDS or len(word) < 2:
            continue
        counts[word] = counts.get(word, 0) + 1
        start = match.start()
        prefix = (transcript_text[:start].rstrip() or ".")
        if prefix[-1] not in ".!?…:–—\"'":
            mid_sentence.add(word)

    names: dict[str, dict] = {}
    for attendee in attendees:
        key = attendee.lower()
        if not key:
            continue
        first = key.split()[0]
        occurrences = sum(c for w, c in counts.items() if w.lower() in (key, first))
        names[key] = {"name": attendee, "count": occurrences, "suggest": ""}
    for word, count in counts.items():
        low = word.lower()
        if low in names:
            names[low]["count"] = max(names[low]["count"], count)
            continue
        # Only mid-sentence capitalized tokens qualify as NEW candidates —
        # sentence starters are capitalized for grammar, not identity.
        if word not in mid_sentence:
            continue
        names[low] = {
            "name": word,
            "count": count,
            "suggest": _closest_attendee(word, attendees),
        }
    ordered = sorted(names.values(), key=lambda n: (-n["count"], n["name"].lower()))
    return ordered[:40]


def apply_mapping(transcript: Transcript, mapping: dict[str, str]) -> tuple[Transcript, int]:
    """Whole-word replace every mapped name in the transcript text (and its
    segments). Returns (new transcript, number of replacements)."""
    replaced = 0

    def fix(text: str) -> str:
        nonlocal replaced
        for frm, to in mapping.items():
            frm, to = str(frm).strip(), str(to).strip()
            if not frm or not to or frm == to:
                continue
            pattern = re.compile(r"\b" + re.escape(frm) + r"\b")
            text, n = pattern.subn(to, text)
            replaced += n
        return text

    new_text = fix(transcript.text or "")
    new_segments = []
    for seg in transcript.segments or []:
        new_segments.append(seg.model_copy(update={"text": fix(seg.text)}))
    # Replacement counts above double-count text+segments; report text hits.
    return transcript.model_copy(update={"text": new_text, "segments": new_segments}), replaced
