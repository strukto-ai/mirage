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

from mirage.resource.gdocs.prompt import PROMPT, WRITE_PROMPT


def test_prompt_includes_buckets_and_structure():
    rendered = PROMPT.format(prefix="/gdocs")
    assert "owned/" in rendered
    assert "shared/" in rendered
    assert "shared with you by others" in rendered
    assert "still in owned/" in rendered
    assert "gdoc.json structure" in rendered
    assert ".body.content[].paragraph.elements[].textRun.content" in rendered


def test_write_prompt_examples_match_actual_signatures():
    assert "gws docs +write" in WRITE_PROMPT
    assert "--document" in WRITE_PROMPT
    assert "--text" in WRITE_PROMPT
    assert "gws docs documents create" in WRITE_PROMPT
    assert "--json" in WRITE_PROMPT
    assert '{"title":' in WRITE_PROMPT
    assert "gws docs documents batchUpdate" in WRITE_PROMPT
    assert "documentId" in WRITE_PROMPT


def test_write_prompt_documents_rm_and_newline_gotcha():
    assert "rm " in WRITE_PROMPT
    assert ".gdoc.json" in WRITE_PROMPT
    assert "$'" in WRITE_PROMPT
