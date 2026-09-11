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

from mirage.shell.constants import FD_BOTH, FD_CLOSE
from mirage.shell.descriptors import (bad_descriptor_line,
                                      unsupported_descriptor)
from mirage.shell.helpers import get_redirects
from mirage.shell.parse import parse
from mirage.shell.types import Redirect, RedirectKind


def _redirects(line: str) -> list[Redirect]:
    return get_redirects(parse(line).named_children[0])[1]


@pytest.mark.parametrize("line,fd,target,kind", [
    ("echo x > f", 1, "f", RedirectKind.STDOUT),
    ("echo x 2> f", 2, "f", RedirectKind.STDERR),
    ("echo x 2>&1", 2, 1, RedirectKind.STDERR_TO_STDOUT),
    ("echo x >&2", 1, 2, RedirectKind.STDOUT),
    ("echo x >&-", 1, FD_CLOSE, RedirectKind.STDOUT),
    ("echo x 2>&-", 2, FD_CLOSE, RedirectKind.STDERR),
    ("echo x <&-", 0, FD_CLOSE, RedirectKind.STDIN),
    ("echo x <&0", 0, 0, RedirectKind.STDIN),
    ("echo x 3> f", 3, "f", RedirectKind.STDOUT),
    ("echo x 3< f", 3, "f", RedirectKind.STDIN),
    ("echo x <&3", 0, 3, RedirectKind.STDIN),
    ("echo x >&3", 1, 3, RedirectKind.STDOUT),
    ("echo x 2>&3", 2, 3, RedirectKind.STDERR),
    ("echo x 3>&1", 3, 1, RedirectKind.STDOUT),
    ("echo x 3>&-", 3, FD_CLOSE, RedirectKind.STDOUT),
    ("echo x &> f", FD_BOTH, "f", RedirectKind.STDOUT),
    ("echo x >& f", FD_BOTH, "f", RedirectKind.STDOUT),
])
def test_parser_keeps_the_descriptor_as_typed(line, fd, target, kind):
    (r, ) = _redirects(line)
    assert (r.fd, r.target, r.kind) == (fd, target, kind)


def test_parser_append_and_clobber_flags():
    (r, ) = _redirects("echo x >> f")
    assert r.append and not r.clobber
    (r, ) = _redirects("echo x >| f")
    assert r.clobber and not r.append
    (r, ) = _redirects("echo x &>> f")
    assert r.append and r.fd == FD_BOTH


@pytest.mark.parametrize("line", [
    "echo x > f", "echo x 2>&1", "echo x >&-", "echo x <&-", "echo x &> f",
    "echo x >&2", "echo x 1>&1", "cat < f"
])
def test_shell_descriptors_are_supported(line):
    assert unsupported_descriptor(_redirects(line)) is None


@pytest.mark.parametrize("line,fd", [
    ("echo x 3> f", 3),
    ("echo x 3< f", 3),
    ("echo x <&3", 3),
    ("echo x >&3", 3),
    ("echo x 2>&3", 3),
    ("echo x 3>&1", 3),
    ("echo x 3>&-", 3),
    ("echo x > f 4>&1", 4),
])
def test_descriptors_above_two_are_refused(line, fd):
    assert unsupported_descriptor(_redirects(line)) == fd
    assert bad_descriptor_line(fd) == f"{fd}: Bad file descriptor\n".encode()
