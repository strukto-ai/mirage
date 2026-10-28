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


class StreamRefusal(Exception):
    """A failure after the command had already written ``output``: a
    mirage-rs stream that refused its input, or a CLI leaf that prints as
    it goes (``gh --jq``), whose output stays on stdout ahead of the
    diagnostic.

    Args:
        message (str): The refusal, without a newline: the command's
            stderr wording, or what the caller reports it as (``sort -c``
            gets the disordered record's number).
        output (bytes): What the command wrote before it failed.
    """

    def __init__(self, message: str, output: bytes) -> None:
        super().__init__(message)
        self.message = message
        self.output = output

    def __reduce__(self) -> tuple[type["StreamRefusal"], tuple[str, bytes]]:
        return type(self), (self.message, self.output)


class SearchLimit(Exception):
    """A -P line search gave up at PCRE2's match limit.

    Args:
        message (str): the refusal in GNU grep's words.
        spans (list[tuple[int, int]]): the matches -o found on the line
            before the search gave up.
    """

    def __init__(self, message: str, spans: list[tuple[int, int]]) -> None:
        super().__init__(message)
        self.message = message
        self.spans = spans


class RegexError(Exception):
    """A pattern mirage-rs refused to compile.

    Args:
        message (str): the refusal as the program words it, without its
            ``prog: `` prefix (``Unmatched ( or \\(``).
    """

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message
