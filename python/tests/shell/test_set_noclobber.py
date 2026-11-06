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

# Every case pinned against GNU bash 5.2.37 on debian:stable-slim.
CASES = [
    # `>` onto an existing target is refused and the target is intact.
    (
        "echo a > /data/f; set -C; echo b > /data/f; echo rc=$?; cat /data/f",
        1,
        "rc=1\na\n",
        "bash: line 1: /data/f: cannot overwrite existing file\n",
    ),
    # Existence is the test, not size: an empty file still refuses.
    (
        ": > /data/f; set -C; echo b > /data/f; echo rc=$?",
        1,
        "rc=1\n",
        "bash: line 1: /data/f: cannot overwrite existing file\n",
    ),
    # `>|` overrides for one redirect, and does not clear the option.
    (
        "echo a > /data/f; set -C; echo b >| /data/f; echo rc=$?; cat /data/f",
        0,
        "rc=0\nb\n",
        "",
    ),
    (
        "echo a > /data/f; set -C; echo b >| /data/f; echo c > /data/f;"
        " echo rc=$?",
        1,
        "rc=1\n",
        "bash: line 1: /data/f: cannot overwrite existing file\n",
    ),
    # A new target and `>>` are both allowed.
    (
        "set -C; echo b > /data/new; echo rc=$?; cat /data/new",
        0,
        "rc=0\nb\n",
        "",
    ),
    (
        "echo a > /data/f; set -C; echo b >> /data/f; echo rc=$?; cat /data/f",
        0,
        "rc=0\na\nb\n",
        "",
    ),
    # `2>` and `&>` are refused the same way.
    (
        "echo a > /data/f; set -C; ls /nope 2> /data/f; echo rc=$?; cat /data/f",
        1,
        "rc=1\na\n",
        "bash: line 1: /data/f: cannot overwrite existing file\n",
    ),
    (
        "echo a > /data/f; set -C; echo b &> /data/f; echo rc=$?; cat /data/f",
        1,
        "rc=1\na\n",
        "bash: line 1: /data/f: cannot overwrite existing file\n",
    ),
    # bash stops at the first refused open: one message, neither written.
    (
        "echo a > /data/x; echo a > /data/y; set -C;"
        " echo b > /data/x > /data/y; echo rc=$?; cat /data/x /data/y",
        1,
        "rc=1\na\na\n",
        "bash: line 1: /data/x: cannot overwrite existing file\n",
    ),
    # A directory under the option answers in GNU's wording for that case.
    (
        "mkdir -p /data/d; set -C; echo b > /data/d; echo rc=$?",
        1,
        "rc=1\n",
        "bash: line 1: /data/d: Is a directory\n",
    ),
    # The letter and the long name are the same option, and `+C` clears it.
    (
        "echo a > /data/f; set -o noclobber; echo b > /data/f; echo rc=$?",
        1,
        "rc=1\n",
        "bash: line 1: /data/f: cannot overwrite existing file\n",
    ),
    (
        "echo a > /data/f; set -C; set +C; echo b > /data/f; echo rc=$?;"
        " cat /data/f",
        0,
        "rc=0\nb\n",
        "",
    ),
    # Off by default: the ordinary overwrite is untouched.
    (
        "echo a > /data/f; echo b > /data/f; echo rc=$?; cat /data/f",
        0,
        "rc=0\nb\n",
        "",
    ),
]


@pytest.mark.parametrize("cmd,last_rc,out,err", CASES)
def test_noclobber(shell, cmd, last_rc, out, err):
    _, got_out, got_err = shell.mirage_result(cmd)
    assert got_out == out
    assert got_err == err
    assert f"rc={last_rc}" in got_out or last_rc == 0


def test_a_refused_open_stops_the_command_from_running(shell):
    # bash opens every redirect before it forks, so a refused open means
    # the command never runs at all. Checking after the fact matched the
    # target's contents and nothing else: `touch marker > existing` still
    # created the marker.
    _, out, err = shell.mirage_result(
        "echo a > /data/f; set -C; touch /data/marker > /data/f;"
        " echo rc=$?; ls /data/marker"
    )
    assert err == (
        "bash: line 1: /data/f: cannot overwrite existing file\n"
        "ls: cannot access '/data/marker':"
        " No such file or directory\n"
    )
    assert out == "rc=1\n"


def test_a_command_cannot_clear_the_way_for_its_own_refused_redirect(shell):
    # The worst shape of the same bug: `rm f > f` ran first, so by the
    # time the probe looked there was nothing to refuse and the line
    # reported success while the file was gone.
    _, out, _ = shell.mirage_result(
        "echo one > /data/f; set -C;"
        " rm /data/f > /data/f; echo rc=$?;"
        " cat /data/f"
    )
    assert out == "rc=1\none\n"


def test_an_earlier_redirect_is_visible_to_a_later_one(shell):
    # Each open is visible to the next, so the second `>` finds what the
    # first one created even though the target was absent when the
    # statement began. Probing every target against one pre-command
    # snapshot passed both and wrote the output.
    _, out, err = shell.mirage_result(
        "set -C; echo x > /data/dup > /data/dup; echo rc=$?;"
        " cat /data/dup; echo end"
    )
    assert err == "bash: line 1: /data/dup: cannot overwrite existing file\n"
    # The first redirect still created it, and the command never ran, so
    # the file is there and empty.
    assert out == "rc=1\nend\n"


def test_append_and_override_opens_count_as_creating(shell):
    # `>>` and `>|` never refuse, but they do open, so a later `>` onto
    # the same absent target refuses against what they created.
    _, out, err = shell.mirage_result(
        "set -C; echo x >> /data/ap > /data/ap; echo rc=$?; cat /data/ap;"
        " echo end"
    )
    assert err == "bash: line 1: /data/ap: cannot overwrite existing file\n"
    assert out == "rc=1\nend\n"
    _, out2, err2 = shell.mirage_result(
        "set -C; echo x >| /data/ov > /data/ov; echo rc=$?; cat /data/ov;"
        " echo end"
    )
    assert err2 == "bash: line 1: /data/ov: cannot overwrite existing file\n"
    assert out2 == "rc=1\nend\n"


def test_noclobber_shows_in_the_option_listing(shell):
    # The fixture reuses one session across calls, so the default is
    # asserted before anything sets the option.
    assert "noclobber      \toff\n" in shell.mirage("set -o")
    assert "noclobber      \ton\n" in shell.mirage("set -C; set -o")
    assert "set -o noclobber\n" in shell.mirage("set +o")
