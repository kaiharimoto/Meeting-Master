#!/usr/bin/env python3
"""argv-compatible Claude CLI stub for tests.

Mimics the shape `_claude_cli` relies on: the prompt arrives on stdin, the
system prompt on --append-system-prompt, and the answer goes to stdout.

Behaviour is steered by env vars so one stub covers every path:

  FAKE_CLAUDE_MODE=json     (default) print a canned combined JSON reply
  FAKE_CLAUDE_MODE=chatty   the same JSON wrapped in prose + a code fence,
                            which is what a real CLI answer tends to look like
                            and what _loads_loose has to survive
  FAKE_CLAUDE_MODE=fail     exit non-zero with a message on stderr
  FAKE_CLAUDE_MODE=limit    exit non-zero with a usage-limit message that
                            contains the word "context" — the string that must
                            NOT trigger the halve-NUM_CTX retry
  FAKE_CLAUDE_MODE=empty    exit 0 having printed nothing
  FAKE_CLAUDE_MODE=hang     sleep past any test timeout, so the caller's own
                            timeout is what ends it

It also records the prompt it was given to FAKE_CLAUDE_LOG, so a test can
assert the whole transcript arrived in ONE call rather than being chunked.
"""

import json
import os
import sys

CANNED = {
    "keyTakeaways": ["A key decision was reached."],
    "keyInsights": ["Start renewal talks earlier."],
    "decisions": ["Approved the vendor renewal at 12%."],
    "actionItems": [
        {"task": "Send the redlined contract.", "owner": "Alice", "due": "Nov 15", "priority": "high"}
    ],
    "keyFigures": ["12% price increase"],
    "topics": ["Pricing"],
    # The extract stage wants a list; including both shapes lets one payload
    # answer whichever stage is calling.
    "questions": [
        {
            "question": "What is the renewal price?",
            "answer": "A 12% increase locked for 24 months.",
            "answerer": "Bob",
            "directedTo": "Bob",
            "confidence": "high",
        }
    ],
    "ok": True,
}


def main() -> int:
    stdin = sys.stdin.read()

    log = os.environ.get("FAKE_CLAUDE_LOG")
    if log:
        with open(log, "a", encoding="utf-8") as fh:
            fh.write(json.dumps({"argv": sys.argv[1:], "stdin": stdin}) + "\n")

    mode = os.environ.get("FAKE_CLAUDE_MODE", "json")
    if mode == "fail":
        sys.stderr.write("claude: something went wrong\n")
        return 2
    if mode == "limit":
        # Deliberately contains "context": a usage-limit message is not a
        # context-window problem, and must not be treated as one.
        sys.stderr.write("Usage limit reached for this 5-hour context window.\n")
        return 1
    if mode == "empty":
        return 0
    if mode == "hang":
        import time

        time.sleep(120)
        return 0

    body = json.dumps(CANNED)
    if mode == "chatty":
        body = f"Sure — here is the combined JSON you asked for:\n\n```json\n{body}\n```\n"
    sys.stdout.write(body)
    return 0


if __name__ == "__main__":
    sys.exit(main())
