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

from mirage.utils.ranges import (is_unsatisfiable_range, range_header,
                                 slice_window)

DATA = b"0123456789"


def test_the_whole_file_needs_no_header():
    assert range_header(0, None) is None


def test_a_bounded_window_is_inclusive_at_both_ends():
    # HTTP ranges name the last byte, not the one after it, so a 4-byte
    # window from 2 ends at 5.
    assert range_header(2, 4) == "bytes=2-5"


def test_an_open_ended_window_leaves_the_end_blank():
    assert range_header(7, None) == "bytes=7-"


def test_a_single_byte_names_the_same_offset_twice():
    assert range_header(3, 1) == "bytes=3-3"


def test_an_offset_with_no_size_from_zero_is_still_the_whole_file():
    assert range_header(0, None) is None


def test_a_negative_offset_is_refused():
    with pytest.raises(ValueError):
        range_header(-1, 4)


def test_a_negative_size_is_refused():
    with pytest.raises(ValueError):
        range_header(0, -4)


def test_a_zero_length_window_is_refused():
    # bytes=2--1 is malformed and no header means the opposite of what
    # was asked, so the caller has to short-circuit instead.
    with pytest.raises(ValueError):
        range_header(2, 0)


def test_slicing_a_bounded_window():
    assert slice_window(DATA, 2, 4) == b"2345"


def test_slicing_to_the_end():
    assert slice_window(DATA, 7, None) == b"789"


def test_slicing_the_whole_thing():
    assert slice_window(DATA, 0, None) == DATA


def test_slicing_past_the_end_stops_there():
    assert slice_window(DATA, 8, 99) == b"89"


def test_slicing_from_past_the_end_is_empty():
    assert slice_window(DATA, 99, 4) == b""


class _BotoError(Exception):

    def __init__(self, code: str, status: int) -> None:
        super().__init__(code)
        self.response = {
            "Error": {
                "Code": code
            },
            "ResponseMetadata": {
                "HTTPStatusCode": status
            },
        }


class _AiohttpError(Exception):

    def __init__(self, status: int) -> None:
        super().__init__("boom")
        self.status = status


def test_the_botocore_shape_is_unsatisfiable():
    # A POSIX read at or past EOF is empty, an HTTP store answers 416,
    # and no two clients spell the refusal the same way.
    assert is_unsatisfiable_range(_BotoError("InvalidRange", 416))


def test_a_bare_status_is_enough():
    assert is_unsatisfiable_range(_AiohttpError(416))


def test_the_status_line_is_the_last_resort():
    assert is_unsatisfiable_range(RuntimeError("416 Range Not Satisfiable"))


def test_a_real_failure_is_not_swallowed():
    # Anything broader here would turn a missing object or a denied
    # request into a silent empty read, the bug this guards against.
    assert not is_unsatisfiable_range(_BotoError("NoSuchKey", 404))
    assert not is_unsatisfiable_range(_AiohttpError(500))
    assert not is_unsatisfiable_range(RuntimeError("AccessDenied"))
