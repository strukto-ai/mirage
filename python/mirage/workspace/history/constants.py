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


from mirage.shell.types import NodeType as NT

WORDS = frozenset(
    {
        NT.STRING,
        NT.RAW_STRING,
        NT.ANSI_C_STRING,
        NT.TRANSLATED_STRING,
        NT.COMMAND_SUBSTITUTION,
        NT.ARITHMETIC_EXPANSION,
        NT.PROCESS_SUBSTITUTION,
        NT.EXPANSION,
    }
)
"""The words a line break inside of stays in an entry as typed."""

OPENERS = frozenset(
    {
        "then",
        "do",
        "else",
        "elif",
        "if",
        "while",
        "until",
        "{",
        "(",
        "in",
        "|",
        "|&",
        "||",
        "&&",
        ";",
        ";;",
        ";&",
        ";;&",
        "&",
        "!",
        "case",
        "for",
        "select",
        "function",
        "time",
    }
)
"""The tokens a command reads on after, so a line break after one joins
as a space."""
