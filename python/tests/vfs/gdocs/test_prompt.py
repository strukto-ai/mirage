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

from mirage.core.jq.eval import jq_eval
from mirage.vfs.gdocs.prompt import PROMPT, WRITE_PROMPT

ALL_TEXT = "[.. | .textRun? // empty | .content] | add"
TAB_NAMES = "[.. | .tabProperties? // empty | .title]"
TAB_COUNT = "[.. | .tabProperties? // empty] | length"
FIRST_TAB = ("[.tabs[0].documentTab.body.content[]\n"
             "      | .paragraph?.elements[]?.textRun.content] | add")
OLD_FLAT_RECIPE = ".body.content[].paragraph.elements[].textRun.content"


def _tab(tab_id: str,
         title: str,
         text: str,
         children: list | None = None) -> dict:
    tab: dict = {
        "tabProperties": {
            "tabId": tab_id,
            "title": title,
            "index": 0,
            "nestingLevel": 0,
        },
        "documentTab": {
            "body": {
                "content": [
                    {
                        "sectionBreak": {
                            "sectionStyle": {}
                        }
                    },
                    {
                        "paragraph": {
                            "elements": [{
                                "textRun": {
                                    "content": text + "\n",
                                    "textStyle": {}
                                }
                            }]
                        }
                    },
                ]
            },
            "documentStyle": {},
            "namedStyles": {},
        },
    }
    if children:
        tab["childTabs"] = children
    return tab


def _doc() -> dict:
    return {
        "documentId":
        "doc1",
        "title":
        "Log",
        "tabs": [
            _tab("t.0", "Tab 1", "first tab"),
            _tab("t.1", "Tab 2", "second tab",
                 [_tab("t.2", "Child", "child tab")]),
        ],
        "revisionId":
        "rev-3",
    }


def test_prompt_includes_buckets_and_structure():
    rendered = PROMPT.format(prefix="/gdocs")
    assert "owned/" in rendered
    assert "shared/" in rendered
    assert "shared with you by others" in rendered
    assert "still in owned/" in rendered
    assert "gdoc.json structure" in rendered
    assert ".tabs[].documentTab" in rendered
    assert "childTabs" in rendered
    assert "tabProperties" in rendered


def test_prompt_no_longer_promises_a_top_level_body():
    # includeTabsContent=true leaves the singleton fields empty, so the
    # old recipe would return nothing at all on a live document.
    rendered = PROMPT.format(prefix="/gdocs")
    assert OLD_FLAT_RECIPE not in rendered
    assert "There is no top-level .body" in rendered


def test_prompt_recipes_are_the_ones_this_test_runs():
    rendered = PROMPT.format(prefix="/gdocs")
    for recipe in (ALL_TEXT, TAB_NAMES, TAB_COUNT, FIRST_TAB):
        assert recipe in rendered


def test_all_text_recipe_reads_every_tab_at_any_depth():
    out = jq_eval(_doc(), ALL_TEXT)
    assert out == ["first tab\nsecond tab\nchild tab\n"]


def test_tab_name_recipe_includes_child_tabs():
    assert jq_eval(_doc(), TAB_NAMES) == [["Tab 1", "Tab 2", "Child"]]
    assert jq_eval(_doc(), TAB_COUNT) == [3]


def test_first_tab_recipe_survives_the_leading_section_break():
    # The `?` in the recipe is load-bearing: content[0] is a sectionBreak
    # with no .paragraph, and the un-guarded path raises "Cannot iterate
    # over null" on every real document.
    assert jq_eval(_doc(), FIRST_TAB) == ["first tab\n"]


def test_write_prompt_examples_match_actual_signatures():
    assert "gws docs write" in WRITE_PROMPT
    assert "--document" in WRITE_PROMPT
    assert "--text" in WRITE_PROMPT
    assert "--tab" in WRITE_PROMPT
    assert "gws docs --help" in WRITE_PROMPT
    assert "gws docs documents batchUpdate --json" in WRITE_PROMPT


def test_write_prompt_says_an_unnamed_tab_is_the_first_one():
    assert "FIRST tab" in WRITE_PROMPT
    assert "[.. | .tabProperties? // empty | .tabId]" in WRITE_PROMPT


def test_write_prompt_documents_rm_and_newline_gotcha():
    assert "rm " in WRITE_PROMPT
    assert ".gdoc.json" in WRITE_PROMPT
    assert "$'" in WRITE_PROMPT
