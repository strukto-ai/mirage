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

from mirage.workspace.executor.builtins.condition.shape import flat_shape
from mirage.workspace.executor.builtins.condition.types import (
    FlatAnd,
    FlatBinary,
    FlatFail,
    FlatNot,
    FlatOr,
    FlatString,
    FlatUnary,
)


@pytest.mark.parametrize(
    ("words", "reading"),
    [
        ([], None),
        (["x"], FlatString(0)),
        (["!", "-e", "x"], FlatNot(FlatUnary("-e", 2))),
        (["-e", "-o", "yes"], FlatOr((FlatString(0), FlatString(2)))),
        (
            ["-f", "-o", "-e", "x"],
            FlatOr((FlatString(0), FlatUnary("-e", 3))),
        ),
        (["a", "-nt", "b"], FlatBinary(0, "-nt", 2)),
        (["x", "y"], FlatFail("test: x: unary operator expected")),
        (
            ["1", "-eq", "x", "-a"],
            FlatAnd(
                (FlatBinary(0, "-eq", 2), FlatFail("test: argument expected"))
            ),
        ),
    ],
)
def test_flat_shape_reads_the_words_as_test_does(words, reading):
    # A grammar error stands after the terms test evaluates before it.
    assert flat_shape("test", words) == reading
