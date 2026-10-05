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

from mirage.agents.langchain.messages import extract_text


def test_extract_text_from_string():
    class Msg:
        content = "hello world"

    assert extract_text([Msg()]) == ["hello world"]


def test_extract_text_from_blocks():
    class Msg:
        content = [
            {"type": "text", "text": "hello"},
            {"type": "tool_use", "name": "ls", "input": {}},
            {"type": "text", "text": "goodbye"},
        ]

    assert extract_text([Msg()]) == ["hello", "goodbye"]


def test_extract_text_skips_empty():
    class Msg:
        content = [
            {"type": "text", "text": "  "},
            {"type": "text", "text": "real"},
        ]

    assert extract_text([Msg()]) == ["real"]


def test_extract_text_no_content():
    class Msg:
        pass

    assert extract_text([Msg()]) == []
