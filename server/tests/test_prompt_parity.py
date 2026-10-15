"""The laptop app builds the external-AI prompt itself when the home server is
unreachable (app/src/renderer/js/aiPrompt.js + the generated aiPromptText.js).
It must stay identical to summarize.external_prompt(), the source of truth."""

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from app.models import MeetingMeta
from app.pipeline.summarize import external_prompt
from app.tools import export_ai_prompt

_JS_DIR = Path(__file__).resolve().parents[2] / "app" / "src" / "renderer" / "js"

# Load both ES modules from data: URLs (the app's package.json is CommonJS),
# resolving aiPrompt.js's one relative import by hand.
_NODE_SCRIPT = r"""
const fs = require('fs'), path = require('path');
const [dir, payload] = [process.argv[1], JSON.parse(process.argv[2])];
const url = (src) => 'data:text/javascript,' + encodeURIComponent(src);
const text = url(fs.readFileSync(path.join(dir, 'aiPromptText.js'), 'utf8'));
const main = fs.readFileSync(path.join(dir, 'aiPrompt.js'), 'utf8')
  .replace("'./aiPromptText.js'", JSON.stringify(text));
import(url(main)).then((m) => {
  process.stdout.write(m.buildExternalPrompt(payload.transcript, payload.details));
});
"""


def test_generated_prompt_file_is_current():
    assert (_JS_DIR / "aiPromptText.js").read_text(encoding="utf-8") == export_ai_prompt.render_js(), (
        "app/src/renderer/js/aiPromptText.js is stale — run "
        "`cd server && python -m app.tools.export_ai_prompt`"
    )


@pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")
@pytest.mark.parametrize(
    "details",
    [
        {"title": "Weekly denials review", "date": "2026-10-14", "time": "09:00",
         "attendees": ["Herbert", "Steve", "Dr. Wu"]},
        {"title": "", "date": "", "time": "", "attendees": []},
    ],
)
def test_js_prompt_matches_server(details):
    transcript = "Okay, good morning.\nIt's a \"quoted\" — $& line ✓."
    meeting = MeetingMeta.model_validate({"schemaVersion": 1, "details": details, "cards": []})
    out = subprocess.run(
        ["node", "-e", _NODE_SCRIPT, str(_JS_DIR),
         json.dumps({"transcript": transcript, "details": details})],
        capture_output=True, check=True, timeout=30,
    )
    assert out.stdout.decode("utf-8") == external_prompt(transcript, meeting)
