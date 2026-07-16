#!/usr/bin/env python3
"""argv-compatible whisper-cli stub for tests.

Finds the '-of <base>' argument and writes <base>.json with a canned payload
in whisper.cpp's -oj output shape (offsets in MILLISECONDS). A '-m <model>'
argument may or may not be present — and the model file need not exist —
this stub does not care, just like the tests require.
"""

import json
import sys

PAYLOAD = {
    "transcription": [
        {
            "offsets": {"from": 0, "to": 4200},
            "text": " This is a stub transcript segment.",
        },
        {
            "offsets": {"from": 4200, "to": 9000},
            "text": " It covers the whole fake meeting.",
        },
    ]
}


def main() -> int:
    argv = sys.argv[1:]
    try:
        out_base = argv[argv.index("-of") + 1]
    except (ValueError, IndexError):
        print("fake_whisper: missing -of <base> argument", file=sys.stderr)
        return 2
    with open(out_base + ".json", "w", encoding="utf-8") as fh:
        json.dump(PAYLOAD, fh)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
