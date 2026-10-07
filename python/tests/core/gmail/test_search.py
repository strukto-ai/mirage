# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

from typing import Any

from mirage.core.gmail.search import format_grep_results
from mirage.vfs.types import SearchResult

LABEL = "INBOX"

EMOJI = "\U0001f600"


def _row(body_text: str) -> dict[str, Any]:
    return {
        "id": "m1",
        "subject": "note",
        "snippet": "fallback snippet",
        "sender": "a@b.c",
        "date": "2026-08-19",
        "label": "INBOX",
        "body_text": body_text,
    }


def _excerpt(lines: list[SearchResult]) -> str:
    """Everything after the ``<path>:[<sender>] `` header."""
    line = lines[0][1]
    return line[line.index("] ") + 2 :]


def test_no_match_budget_counts_code_points():
    # Gmail matched the message server-side on something the literal scan
    # does not find, so the excerpt falls back to the head of the body. 200
    # emoji are 200 code points and 400 UTF-16 units, which is the input the
    # typescript twin cut to 117 -- splitting the 118th surrogate pair.
    body = EMOJI * 200
    excerpt = _excerpt(
        format_grep_results([_row(body)], LABEL, "/gmail", "zzz")
    )
    assert excerpt == f"note {body}"
    assert len(excerpt) == 205
    assert "�" not in excerpt


def test_match_window_cuts_on_code_point_boundaries():
    pad = EMOJI * 200
    excerpt = _excerpt(
        format_grep_results(
            [_row(f"{pad} needle {pad}")], LABEL, "/gmail", "needle"
        )
    )
    assert excerpt == f"...{EMOJI * 119} needle {EMOJI * 119}..."
    assert "�" not in excerpt


def test_match_window_on_ascii():
    body = "a" * 300 + " needle " + "b" * 300
    excerpt = _excerpt(
        format_grep_results([_row(body)], LABEL, "/gmail", "needle")
    )
    assert excerpt == f"...{'a' * 119} needle {'b' * 119}..."


def test_empty_pattern_falls_back_to_the_snippet():
    lines = format_grep_results([_row("body")], LABEL, "/gmail")
    assert [text for _, text in lines] == [
        "/gmail/INBOX/2026-08-19/note__m1.gmail.json:[a@b.c] fallback snippet"
    ]
