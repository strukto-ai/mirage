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

import asyncio
from unittest.mock import AsyncMock, MagicMock

from mirage.io import IOResult
from mirage.shell import parse
from mirage.shell.call_stack import CallStack
from mirage.shell.helpers import get_parts
from mirage.types import PathSpec
from mirage.workspace.expand import (classify_parts, classify_word,
                                     expand_and_classify, expand_node,
                                     expand_parts)
from mirage.workspace.session import Session


def _session(env=None, cwd="/"):
    return Session(session_id="test", cwd=cwd, env=env or {})


def _execute_fn():
    return AsyncMock(return_value=IOResult())


def _run(coro):
    return asyncio.run(coro)


def _cmd_parts(cmd: str):
    """Parse a command and return its parts nodes."""
    root = parse(cmd)
    return get_parts(root.named_children[0])


def _first_arg(cmd: str):
    """Parse and return the second child (first argument)."""
    return _cmd_parts(cmd)[1]


def _mock_registry(prefixes=None):
    """Create a mock registry that matches given prefixes.

    Args:
        prefixes: list of mount prefixes, e.g. ["/data/", "/s3/"].
            If None, matches everything.
    """
    reg = MagicMock()

    def _mount_for(path):
        if prefixes is None:
            root = MagicMock()
            root.prefix = "/"
            return root
        norm = "/" + path.strip("/")
        for p in sorted(prefixes, key=len, reverse=True):
            norm_p = p.rstrip("/")
            if norm == norm_p or norm.startswith(p):
                m = MagicMock()
                m.prefix = p
                return m
        raise ValueError(f"no mount matches: {path}")

    reg.mount_for = MagicMock(side_effect=_mount_for)
    return reg


# ── word ────────────────────────────────────────


def test_expand_word():
    node = _cmd_parts("echo hello")[1]
    result = _run(expand_node(node, _session(), _execute_fn()))
    assert result == "hello"


def test_expand_command_name():
    node = _cmd_parts("echo hello")[0]
    result = _run(expand_node(node, _session(), _execute_fn()))
    assert result == "echo"


# ── simple expansion $VAR ───────────────────────


def test_expand_simple_var():
    node = _first_arg("echo $FOO")
    session = _session(env={"FOO": "bar"})
    result = _run(expand_node(node, session, _execute_fn()))
    assert result == "bar"


def test_expand_simple_var_missing():
    node = _first_arg("echo $MISSING")
    result = _run(expand_node(node, _session(), _execute_fn()))
    assert result == ""


def test_expand_special_question():
    node = _first_arg("echo $?")
    session = _session()
    session.last_exit_code = 42
    result = _run(expand_node(node, session, _execute_fn()))
    assert result == "42"


def test_expand_special_at():
    node = _first_arg("echo $@")
    cs = CallStack()
    cs.push(["a", "b", "c"])
    result = _run(expand_node(node, _session(), _execute_fn(), call_stack=cs))
    assert result == "a b c"


def test_expand_positional():
    node = _first_arg("echo $1")
    cs = CallStack()
    cs.push(["first", "second"])
    result = _run(expand_node(node, _session(), _execute_fn(), call_stack=cs))
    assert result == "first"


def test_expand_dollar_zero():
    node = _first_arg("echo $0")
    result = _run(expand_node(node, _session(), _execute_fn()))
    assert result == "mirage"


# ── brace expansion ${VAR} ─────────────────────


def test_expand_braces():
    node = _first_arg("echo ${FOO}")
    session = _session(env={"FOO": "hello"})
    result = _run(expand_node(node, session, _execute_fn()))
    assert result == "hello"


def test_expand_braces_default():
    node = _first_arg("echo ${FOO:-default_val}")
    result = _run(expand_node(node, _session(), _execute_fn()))
    assert result == "default_val"


def test_expand_braces_default_not_used():
    node = _first_arg("echo ${FOO:-default_val}")
    session = _session(env={"FOO": "exists"})
    result = _run(expand_node(node, session, _execute_fn()))
    assert result == "exists"


# ── command substitution $(cmd) ─────────────────


def test_expand_command_sub():
    node = _first_arg("echo $(whoami)")
    execute_fn = AsyncMock()
    io = IOResult()
    io.stdout = b"testuser\n"
    execute_fn.return_value = io
    result = _run(expand_node(node, _session(), execute_fn))
    assert result == "testuser"
    execute_fn.assert_called_once()


# ── arithmetic expansion $((expr)) ──────────────


def test_expand_arithmetic():
    node = _first_arg("echo $((1 + 2))")
    result = _run(expand_node(node, _session(), _execute_fn()))
    assert result == "3"


def test_expand_arithmetic_multiply():
    node = _first_arg("echo $((3 * 4))")
    result = _run(expand_node(node, _session(), _execute_fn()))
    assert result == "12"


# ── concatenation $VAR/file.txt ─────────────────


def test_expand_concatenation():
    node = _first_arg("echo $DIR/file.txt")
    session = _session(env={"DIR": "/data"})
    result = _run(expand_node(node, session, _execute_fn()))
    assert result == "/data/file.txt"


# ── string "hello $VAR" ────────────────────────


def test_expand_double_quoted():
    node = _first_arg('echo "hello $NAME"')
    session = _session(env={"NAME": "world"})
    result = _run(expand_node(node, session, _execute_fn()))
    assert result == "hello world"


def test_expand_double_quoted_no_var():
    node = _first_arg('echo "plain text"')
    result = _run(expand_node(node, _session(), _execute_fn()))
    assert result == "plain text"


# ── raw string 'no expansion' ──────────────────


def test_expand_raw_string():
    node = _first_arg("echo 'no $expansion'")
    session = _session(env={"expansion": "SHOULD_NOT_SEE"})
    result = _run(expand_node(node, session, _execute_fn()))
    assert result == "no $expansion"


# ── expand_parts ───────────────────────────────


def test_expand_parts_basic():
    parts = _cmd_parts("echo hello world")
    session = _session()
    result = _run(expand_parts(parts, session, _execute_fn()))
    assert result == ["echo", "hello", "world"]


def test_expand_parts_with_var():
    parts = _cmd_parts("echo $A $B")
    session = _session(env={"A": "foo", "B": "bar"})
    result = _run(expand_parts(parts, session, _execute_fn()))
    assert result == ["echo", "foo", "bar"]


def test_expand_parts_cmd_sub_splits():
    parts = _cmd_parts("echo $(ls)")
    execute_fn = AsyncMock()
    io = IOResult()
    io.stdout = b"file1\nfile2\nfile3\n"
    execute_fn.return_value = io
    session = _session()
    result = _run(expand_parts(parts, session, execute_fn))
    assert "file1" in result
    assert "file2" in result
    assert "file3" in result


def test_expand_parts_empty_var_skipped():
    parts = _cmd_parts("echo $EMPTY")
    session = _session()
    result = _run(expand_parts(parts, session, _execute_fn()))
    assert result == ["echo"]


def test_expand_parts_splits_unquoted_var():
    parts = _cmd_parts("echo $VAR")
    session = _session(env={"VAR": "a b c"})
    result = _run(expand_parts(parts, session, _execute_fn()))
    assert result == ["echo", "a", "b", "c"]


def test_expand_parts_no_split_quoted_var():
    parts = _cmd_parts('echo "$VAR"')
    session = _session(env={"VAR": "a b c"})
    result = _run(expand_parts(parts, session, _execute_fn()))
    assert result == ["echo", "a b c"]


def test_expand_parts_splits_dollar_at():
    parts = _cmd_parts("echo $@")
    cs = CallStack()
    cs.push(["a", "b", "c"])
    session = _session()
    result = _run(expand_parts(parts, session, _execute_fn(), call_stack=cs))
    assert result == ["echo", "a", "b", "c"]


def test_expand_parts_no_split_empty_var():
    parts = _cmd_parts("echo $EMPTY")
    session = _session(env={"EMPTY": ""})
    result = _run(expand_parts(parts, session, _execute_fn()))
    assert result == ["echo"]


def test_expand_parts_splits_expansion_braces():
    parts = _cmd_parts("echo ${VAR}")
    session = _session(env={"VAR": "x y z"})
    result = _run(expand_parts(parts, session, _execute_fn()))
    assert result == ["echo", "x", "y", "z"]


def test_expand_parts_keeps_empty_raw_string():
    """A quoted empty literal '' is a real (empty) argument, not dropped."""
    parts = _cmd_parts("echo a '' b")
    result = _run(expand_parts(parts, _session(), _execute_fn()))
    assert result == ["echo", "a", "", "b"]


def test_expand_parts_keeps_empty_double_quote():
    """A quoted empty literal "" is a real (empty) argument, not dropped."""
    parts = _cmd_parts('echo a "" b')
    result = _run(expand_parts(parts, _session(), _execute_fn()))
    assert result == ["echo", "a", "", "b"]


def test_expand_parts_keeps_empty_quoted_var():
    """A quoted expansion that yields empty stays a word (bash keeps "$x")."""
    parts = _cmd_parts('echo a "$EMPTY" b')
    session = _session(env={"EMPTY": ""})
    result = _run(expand_parts(parts, session, _execute_fn()))
    assert result == ["echo", "a", "", "b"]


def test_expand_parts_drops_empty_quoted_dollar_at():
    """Quoted "$@" with no positional args yields zero words, not one empty."""
    parts = _cmd_parts('echo a "$@" b')
    result = _run(expand_parts(parts, _session(), _execute_fn()))
    assert result == ["echo", "a", "b"]


# ══════════════════════════════════════════════
# classify_word
# ══════════════════════════════════════════════


def test_classify_relative_text():
    reg = _mock_registry(["/data/"])
    result = classify_word("hello", reg, "/data")
    assert result == "hello"
    assert isinstance(result, str)


def test_classify_absolute_file():
    reg = _mock_registry(["/data/"])
    result = classify_word("/data/file.txt", reg, "/")
    assert isinstance(result, PathSpec)
    assert result.virtual == "/data/file.txt"
    assert result.directory == "/data/"
    assert result.pattern is None
    assert result.resolved is True


def test_classify_absolute_directory():
    reg = _mock_registry(["/data/"])
    result = classify_word("/data/subdir/", reg, "/")
    assert isinstance(result, PathSpec)
    assert result.resolved is False


def test_classify_absolute_glob():
    reg = _mock_registry(["/data/"])
    result = classify_word("/data/*.csv", reg, "/")
    assert isinstance(result, PathSpec)
    assert result.virtual == "/data/*.csv"
    assert result.directory == "/data/"
    assert result.pattern == "*.csv"
    assert result.resolved is False


def test_classify_absolute_glob_question():
    reg = _mock_registry(["/s3/"])
    result = classify_word("/s3/file?.txt", reg, "/")
    assert isinstance(result, PathSpec)
    assert result.pattern == "file?.txt"


def test_classify_absolute_glob_bracket():
    reg = _mock_registry(["/s3/"])
    result = classify_word("/s3/file[0-9].txt", reg, "/")
    assert isinstance(result, PathSpec)
    assert result.pattern == "file[0-9].txt"


def test_classify_relative_glob():
    reg = _mock_registry(["/data/"])
    result = classify_word("*.txt", reg, "/data")
    assert isinstance(result, PathSpec)
    assert result.virtual == "/data/*.txt"
    assert result.directory == "/data/"
    assert result.pattern == "*.txt"


def test_classify_relative_dotdot_glob():
    reg = _mock_registry(["/data/"])
    result = classify_word("../*.txt", reg, "/data/sub")
    assert isinstance(result, PathSpec)
    assert result.virtual == "/data/*.txt"
    assert result.directory == "/data/"
    assert result.pattern == "*.txt"


def test_classify_no_mount_returns_text():
    reg = _mock_registry(["/data/"])
    result = classify_word("/unknown/file.txt", reg, "/")
    assert result == "/unknown/file.txt"
    assert isinstance(result, str)


def test_classify_no_mount_glob_returns_text():
    reg = _mock_registry(["/data/"])
    result = classify_word("/unknown/*.txt", reg, "/")
    assert result == "/unknown/*.txt"
    assert isinstance(result, str)


def test_classify_relative_no_glob_always_text():
    reg = _mock_registry(["/data/"])
    result = classify_word("error", reg, "/data")
    assert result == "error"
    assert isinstance(result, str)


def test_classify_relative_glob_no_mount_returns_text():
    reg = _mock_registry(["/data/"])
    result = classify_word("*.txt", reg, "/nomount")
    assert result == "*.txt"
    assert isinstance(result, str)


# ══════════════════════════════════════════════
# classify_parts
# ══════════════════════════════════════════════


def test_classify_parts_command_name_stays_str():
    reg = _mock_registry(["/data/"])
    result = classify_parts(["cat", "/data/file.txt"], reg, "/")
    assert result[0] == "cat"
    assert isinstance(result[0], str)
    assert isinstance(result[1], PathSpec)
    assert result[1].virtual == "/data/file.txt"


def test_classify_parts_mixed():
    reg = _mock_registry(["/data/"])
    result = classify_parts(["grep", "-n", "pattern", "/data/file.txt"], reg,
                            "/")
    assert result[0] == "grep"
    assert result[1] == "-n"
    assert result[2] == "pattern"
    assert isinstance(result[3], PathSpec)


def test_classify_parts_multiple_paths():
    reg = _mock_registry(["/data/"])
    result = classify_parts(["diff", "/data/a.txt", "/data/b.txt"], reg, "/")
    assert isinstance(result[1], PathSpec)
    assert isinstance(result[2], PathSpec)
    assert result[1].virtual == "/data/a.txt"
    assert result[2].virtual == "/data/b.txt"


def test_classify_parts_glob_in_args():
    reg = _mock_registry(["/data/"])
    result = classify_parts(["cat", "/data/*.csv"], reg, "/")
    assert isinstance(result[1], PathSpec)
    assert result[1].pattern == "*.csv"


def test_classify_parts_no_paths():
    reg = _mock_registry(["/data/"])
    result = classify_parts(["echo", "hello", "world"], reg, "/")
    assert all(isinstance(r, str) for r in result)


def test_classify_parts_empty():
    reg = _mock_registry()
    result = classify_parts([], reg, "/")
    assert result == []


# ══════════════════════════════════════════════
# expand_and_classify
# ══════════════════════════════════════════════


def test_expand_and_classify_text():
    parts = _cmd_parts("echo hello world")[1:]
    reg = _mock_registry(["/data/"])
    session = _session()
    result = _run(expand_and_classify(parts, session, _execute_fn(), reg, "/"))
    assert result == ["hello", "world"]


def test_expand_and_classify_glob():
    parts = _cmd_parts("echo *.txt")[1:]
    reg = _mock_registry(["/data/"])
    session = _session(cwd="/data")
    result = _run(
        expand_and_classify(parts, session, _execute_fn(), reg, "/data"))
    assert len(result) == 1
    assert isinstance(result[0], PathSpec)
    assert result[0].pattern == "*.txt"


def test_expand_and_classify_absolute_path():
    parts = _cmd_parts("echo /data/file.txt")[1:]
    reg = _mock_registry(["/data/"])
    session = _session()
    result = _run(expand_and_classify(parts, session, _execute_fn(), reg, "/"))
    assert len(result) == 1
    assert isinstance(result[0], PathSpec)
    assert result[0].virtual == "/data/file.txt"
    assert result[0].resolved is True


def test_expand_and_classify_var_to_glob():
    parts = _cmd_parts("echo $PATTERN")[1:]
    reg = _mock_registry(["/s3/"])
    session = _session(env={"PATTERN": "/s3/*.csv"})
    result = _run(expand_and_classify(parts, session, _execute_fn(), reg, "/"))
    assert len(result) == 1
    assert isinstance(result[0], PathSpec)
    assert result[0].pattern == "*.csv"


def test_expand_and_classify_var_to_path():
    parts = _cmd_parts("echo $FILE")[1:]
    reg = _mock_registry(["/data/"])
    session = _session(env={"FILE": "/data/report.csv"})
    result = _run(expand_and_classify(parts, session, _execute_fn(), reg, "/"))
    assert len(result) == 1
    assert isinstance(result[0], PathSpec)
    assert result[0].virtual == "/data/report.csv"
    assert result[0].resolved is True


def test_expand_and_classify_no_mount_stays_text():
    parts = _cmd_parts("echo /unknown/file.txt")[1:]
    reg = _mock_registry(["/data/"])
    session = _session()
    result = _run(expand_and_classify(parts, session, _execute_fn(), reg, "/"))
    assert result == ["/unknown/file.txt"]
    assert isinstance(result[0], str)
