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

import pytest

from mirage.shell.parse.heredoc import (ansi_c_end, clean_delimiter,
                                        delimiter_quoted)


@pytest.mark.parametrize("token, expected", [
    ("EOF", "EOF"),
    ("'EOF'", "EOF"),
    ('"EOF"', "EOF"),
    ("EN'D'", "END"),
    ("\\EOF", "EOF"),
    ("E\\OF", "EOF"),
    ("E\\$F", "E$F"),
    ("'EO F'", "EO F"),
    ("'E\\xF'", "E\\xF"),
    ("'E\\$F'", "E\\$F"),
    ('"E\\$F"', "E$F"),
    ('"E\\"F"', 'E"F'),
    ('"E\\`F"', "E`F"),
    ('"E\\\\F"', "E\\F"),
    ('"E\\xF"', "E\\xF"),
    ("E'", "E"),
    ("$'EOF'", "EOF"),
    ("$'E\\tF'", "E\tF"),
    ("E$'\\t'F", "E\tF"),
    ("$'E'F", "EF"),
    ("$'\\''", "'"),
    ('$"EOF"', "EOF"),
    ('E$"O"F', "EOF"),
    ("\\$'EOF'", "$EOF"),
    ("'$EOF'", "$EOF"),
    ('"$\'EOF\'"', "$'EOF'"),
    ("$EOF", "$EOF"),
    ("EOF$", "EOF$"),
    ("EO\\\nF", "EOF"),
    ('"EO\\\nF"', "EOF"),
    ('$"EO\\\nF"', "EOF"),
    ("'EO\\\nF'", "EO\\\nF"),
    ("$'A\\\nB'", "A\\\nB"),
])
def test_clean_delimiter(token: str, expected: str):
    assert clean_delimiter(token) == expected


@pytest.mark.parametrize("token, expected", [
    ("$'A'", 3),
    ("$'\\''", 4),
    ("$'A", 3),
])
def test_ansi_c_end(token: str, expected: int):
    assert ansi_c_end(token, 2) == expected


@pytest.mark.parametrize("token, quoted", [
    ("EOF", False),
    ("$EOF", False),
    ("'EOF'", True),
    ('"EOF"', True),
    ("EN'D'", True),
    ("\\EOF", True),
    ("E\\OF", True),
    ("$'EOF'", True),
    ('$"EOF"', True),
    ("EO\\\nF", False),
    ("E\\\nO\\\nF", False),
    ("EO\\\nF\\G", True),
    ('"EO\\\nF"', True),
    ("'EO\\\nF'", True),
])
def test_delimiter_quoted(token: str, quoted: bool):
    assert delimiter_quoted(token) is quoted
