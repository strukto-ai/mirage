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

from mirage.resource.gmail.prompt import PROMPT, WRITE_PROMPT


def test_prompt_includes_path_anatomy_and_processed_shape():
    rendered = PROMPT.format(prefix="/gmail")
    assert "<label>" in rendered
    assert "INBOX" in rendered
    assert "after:/before:" in rendered
    assert "mirage-processed" in rendered
    assert ".body_text" in rendered
    assert "gws gmail +read" in rendered
    assert "gws gmail +triage" in rendered


def test_prompt_documents_file_per_message_layout():
    rendered = PROMPT.format(prefix="/gmail")
    assert "<subject>__<message-id>.gmail.json" in rendered
    assert "<subject>__<message-id>/" in rendered
    assert "attachments dir" in rendered
    assert ".attachments[]" in rendered


def test_prompt_mentions_grep_skips_binary_attachments():
    rendered = PROMPT.format(prefix="/gmail")
    assert "grep" in rendered
    assert "binary" in rendered.lower()


def test_write_prompt_examples_match_actual_signatures():
    assert "gws gmail +send" in WRITE_PROMPT
    assert "--to" in WRITE_PROMPT
    assert "--subject" in WRITE_PROMPT
    assert "--body" in WRITE_PROMPT
    assert "gws gmail +reply" in WRITE_PROMPT
    assert "gws gmail +reply-all" in WRITE_PROMPT
    assert "gws gmail +forward" in WRITE_PROMPT
    assert "--message-id" in WRITE_PROMPT


def test_write_prompt_documents_rm_and_newline_gotcha():
    assert "rm " in WRITE_PROMPT
    assert ".gmail.json" in WRITE_PROMPT
    assert "Trash" in WRITE_PROMPT
    assert "$'" in WRITE_PROMPT
