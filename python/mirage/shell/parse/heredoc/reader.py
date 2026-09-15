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

from mirage.shell.parse.heredoc import constants
from mirage.shell.parse.heredoc.delimiter import (clean_delimiter,
                                                  delimiter_quoted)
from mirage.shell.parse.heredoc.line import (construct_closer, construct_end,
                                             operator_line_end, quote_end)
from mirage.shell.parse.heredoc.types import BodyRead, Heredoc, HeredocOperator


def delimiter_end(data: bytes, start: int) -> int | None:
    """Read a delimiter word without performing any expansion.

    Args:
        data (bytes): shell source.
        start (int): beginning of the delimiter word.
    """
    index = start
    while index < len(data):
        byte = data[index]
        closer = construct_closer(data, index,
                                  False) if byte == constants.DOLLAR else None
        if byte == constants.BACKSLASH:
            index += min(2, len(data) - index)
        elif byte in constants.QUOTE_OPENERS:
            end = quote_end(data, index)
            if end is None:
                return None
            index = end
        elif closer is not None:
            end = construct_end(data, index, closer)
            if end is None:
                return None
            index = end
        elif byte in constants.COMMENT_PRECEDERS:
            break
        else:
            index += 1
    return index


def read_body(data: bytes, start: int, delimiter: bytes, quoted: bool,
              dash: bool) -> BodyRead:
    """Read physical lines into a body, testing whole logical lines.

    Args:
        data (bytes): shell source.
        start (int): first body byte.
        delimiter (bytes): quote-removed delimiter.
        quoted (bool): suppress expansions and continuation removal.
        dash (bool): strip leading tabs on logical lines.
    """
    body = bytearray()
    offsets: list[int] = []
    position = start
    eof_line = data.count(b"\n") + (not data.endswith(b"\n"))
    while position < len(data):
        line = bytearray()
        places: list[int] = []
        continued = False
        while position < len(data):
            newline = data.find(b"\n", position)
            end = len(data) if newline < 0 else newline
            begin = position
            line.extend(data[begin:end])
            places.extend(range(begin, end))
            position = len(data) if newline < 0 else newline + 1
            trailing = len(line) - len(line.rstrip(b"\\"))
            continued = not quoted and trailing % 2 != 0 and newline >= 0
            if continued:
                line.pop()
                places.pop()
                continue
            break
        if continued and not line:
            break
        if dash:
            tabs = len(line) - len(line.lstrip(b"\t"))
            del line[:tabs]
            del places[:tabs]
        if line == delimiter:
            return BodyRead(bytes(body), tuple(offsets), position, True,
                            eof_line)
        if continued:
            eof_line += 1
        body.extend(line)
        offsets.extend(places)
        body.append(constants.NEWLINE)
        offsets.append(min(position - 1, len(data)))
    return BodyRead(bytes(body), tuple(offsets), position, False, eof_line)


def read_heredocs(data: bytes,
                  operators: list[HeredocOperator]) -> list[Heredoc]:
    """Gather pending bodies in source order at each operator-line newline.

    Args:
        data (bytes): untouched source.
        operators (list[HeredocOperator]): parser hints, including errors.
    """
    documents: list[Heredoc] = []
    previous_line = -1
    cursor = 0
    for operator in operators:
        if any(doc.body_start <= operator.word_start < doc.end
               for doc in documents):
            continue
        end = delimiter_end(data, operator.word_start)
        if end is None:
            continue
        token = data[operator.word_start:end].decode()
        delimiter = clean_delimiter(token)
        quoted = delimiter_quoted(token)
        line_end = operator_line_end(data, end)
        if line_end is None:
            line_end = len(data)
        start = cursor if line_end == previous_line else min(
            line_end + 1, len(data))
        result = read_body(data, start, delimiter.encode(), quoted,
                           operator.allows_indent)
        cursor = result.end
        line = (data.count(b"\n", 0, max(0, start - 1)) +
                1 if line_end == previous_line else
                data.count(b"\n", 0, operator.word_start) + 1)
        if line_end == previous_line and documents and not documents[
                -1].terminated:
            line = documents[-1].eof_line
        eof_line = max(result.eof_line, line)
        previous_line = line_end
        op_start = operator.word_start
        while op_start and data[op_start - 1] in b" \t":
            op_start -= 1
        op_start -= 3 if operator.allows_indent else 2
        documents.append(
            Heredoc(op_start, end, delimiter, quoted, start, cursor,
                    result.body, result.offsets, result.terminated, line,
                    eof_line))
    return documents


def discover_heredocs(data: bytes,
                      hints: list[HeredocOperator]) -> list[Heredoc]:
    """Complete parser hints with operators its error recovery omitted.

    Args:
        data (bytes): untouched shell source.
        hints (list[HeredocOperator]): includes operators in substitutions.
    """
    operators = list(hints)
    documents = read_heredocs(data, operators)
    index = 0
    while index < len(data):
        containing = next(
            (doc for doc in documents if doc.body_start <= index < doc.end),
            None)
        if containing is not None:
            index = containing.end
            continue
        byte = data[index]
        if data[index:index + 2] == b"${":
            end = construct_end(data, index, constants.CLOSE_BRACE)
            index = len(data) if end is None else end
        elif data[index:index + 2] == b"$[":
            end = construct_end(data, index, constants.CLOSE_BRACKET)
            index = len(data) if end is None else end
        elif data[index:index + 2] == b"((":
            end = construct_end(data, index, constants.CLOSE_PAREN)
            index = len(data) if end is None else end
        elif byte == constants.BACKSLASH:
            index += 2
        elif byte in constants.QUOTE_OPENERS:
            end = quote_end(data, index)
            index = len(data) if end is None else end
        elif byte == constants.HASH and (index == 0 or data[index - 1]
                                         in constants.COMMENT_PRECEDERS):
            newline = data.find(b"\n", index)
            index = len(data) if newline < 0 else newline
        elif data[index:index + 3] == b"<<<":
            index += 3
        elif data[index:index + 2] == b"<<":
            dash = data[index + 2:index + 3] == b"-"
            start = index + (3 if dash else 2)
            while start < len(data) and data[start] in b" \t":
                start += 1
            end = delimiter_end(data, start)
            if end is None:
                break
            if end == start:
                index += 2
                continue
            if not any(op.word_start == start for op in operators):
                operators.append(
                    HeredocOperator(start, end,
                                    clean_delimiter(data[start:end].decode()),
                                    dash))
                operators.sort(key=lambda op: op.word_start)
                documents = read_heredocs(data, operators)
            index = end
        else:
            index += 1
    return documents
