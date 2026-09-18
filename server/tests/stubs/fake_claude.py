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

  The three modes below put the failure on STDOUT with stderr EMPTY, which is
  what the real CLI does in -p mode: a failed turn is reported as the turn's
  output. Every failure mode here used to write to stderr, so the suite proved
  the opposite of production and the handler's stderr-only read went unnoticed
  until a meeting's notes were lost to "no error output".

  FAKE_CLAUDE_MODE=login    exit 1, sign-in message on stdout, stderr empty
  FAKE_CLAUDE_MODE=oauth    exit 1, the VERBATIM expired-session line seen in
                            production on 2026-09-18, on stdout
  FAKE_CLAUDE_MODE=quota    exit 1, usage-limit message on stdout, stderr empty
  FAKE_CLAUDE_MODE=silent   exit 1 printing nothing on EITHER stream — the only
                            case that genuinely has no error text to report
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
    if mode == "login":
        # Real shape: the CLI's own words, on stdout, nothing on stderr.
        sys.stdout.write("Invalid API key \u00b7 Please run /login\n")
        return 1
    if mode == "oauth":
        # VERBATIM from the home server's log, 2026-09-18. Not paraphrased, and
        # not to be "tidied up": this exact string is what the hint table has to
        # recognize, and an earlier guess at the wording missed it.
        sys.stdout.write(
            "Failed to authenticate: OAuth session expired and could not be "
            "refreshed\n"
        )
        return 1
    if mode == "quota":
        sys.stdout.write(
            "Claude usage limit reached. Your limit will reset at 3pm.\n"
        )
        return 1
    if mode == "silent":
        return 1
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
