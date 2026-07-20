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

from mirage.resource.linear.prompt import PROMPT, WRITE_PROMPT


def test_prompt_includes_path_anatomy_and_normalized_shapes():
    rendered = PROMPT.format(prefix="/linear")
    assert "team.json:" in rendered
    assert "issue.json:" in rendered
    assert "comments.jsonl:" in rendered
    assert "project.json:" in rendered
    assert "cycle.json:" in rendered
    assert "user.json:" in rendered
    assert "document.json:" in rendered
    assert "mirage-normalized" in rendered
    assert ".issue_key" in rendered
    assert ".label_names[]" in rendered
    assert "linear search" in rendered
    assert "linear issue list" in rendered
    assert "linear document list" in rendered
    assert "0=none 1=urgent" in rendered


def test_write_prompt_examples_match_actual_signatures():
    assert "linear issue create" in WRITE_PROMPT
    assert "linear issue update" in WRITE_PROMPT
    assert "linear issue assign" in WRITE_PROMPT
    assert "linear issue transition" in WRITE_PROMPT
    assert "linear issue set-priority" in WRITE_PROMPT
    assert "linear issue set-project" in WRITE_PROMPT
    assert "linear issue add-label" in WRITE_PROMPT
    assert "linear comment add" in WRITE_PROMPT
    assert "linear comment update" in WRITE_PROMPT
    assert "--team_id" in WRITE_PROMPT
    assert "--issue_key" in WRITE_PROMPT
    assert "--assignee_email" in WRITE_PROMPT
    assert "--state_name" in WRITE_PROMPT
    assert "--priority" in WRITE_PROMPT
    assert "--body_file" in WRITE_PROMPT
    assert "--description_file" in WRITE_PROMPT
    assert "UNDERSCORES" in WRITE_PROMPT
