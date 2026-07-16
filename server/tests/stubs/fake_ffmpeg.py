#!/usr/bin/env python3
"""argv-compatible ffmpeg stub for tests.

Finds the argument after '-i' (the input) and treats the last argument as the
output, then just copies input -> output. Optionally sleeps for
FAKE_FFMPEG_SLEEP seconds first, so a test can hold a job in the
'normalizing' state deterministically.
"""

import os
import shutil
import sys
import time


def main() -> int:
    argv = sys.argv[1:]

    delay = float(os.environ.get("FAKE_FFMPEG_SLEEP", "0") or 0)
    if delay > 0:
        time.sleep(delay)

    try:
        src = argv[argv.index("-i") + 1]
    except (ValueError, IndexError):
        print("fake_ffmpeg: missing -i <input> argument", file=sys.stderr)
        return 2
    dst = argv[-1]
    shutil.copyfile(src, dst)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
