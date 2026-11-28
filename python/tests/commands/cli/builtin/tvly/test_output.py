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

import re

from mirage.commands.cli.builtin.tvly.output import (
    Streams,
    output_slug,
    resolve_output,
)
from mirage.commands.config import Context
from mirage.commands.spec.flag_view import FlagView
from mirage.types import PathSpec


def test_a_label_slugs_to_its_words():
    assert output_slug("What is RAG? (2026)") == "what-is-rag-2026"
    assert output_slug("!!!") == "result"
    assert output_slug("a" * 50) == "a" * 40


def test_no_dash_o_saves_nothing():
    assert resolve_output(FlagView({}), Context(), "search", "q") is None


def test_a_named_file_is_kept_as_typed():
    path = PathSpec.from_str_path("out.json", cwd="/work")
    flags = {"output": path}
    assert resolve_output(FlagView(flags), Context(), "search", "q") is path


def test_a_bare_dash_o_picks_a_fresh_name_under_dot_tavily():
    found = resolve_output(
        FlagView({"output": True}),
        Context(cwd=PathSpec.from_str_path("/work")),
        "map",
        "docs.example.com",
    )
    assert found is not None
    assert re.fullmatch(
        r"\.tavily/map-docs-example-com-\d{6}-[0-9a-f]{6}\.json",
        found.raw_path,
    )
    assert found.virtual.startswith("/work/.tavily/")


def test_the_streams_answer_with_their_text_and_status():
    streams = Streams()
    streams.out("a")
    streams.err("b")
    out, result = streams.result(3)
    assert out == b"a\n"
    assert result.stderr == b"b\n"
    assert result.exit_code == 3
