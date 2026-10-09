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

from mirage.shell.call_stack import CallStack


def test_initial_frame():
    cs = CallStack()
    assert cs.depth == 1
    assert cs.get_all_positional() == []


def test_push_pop():
    cs = CallStack()
    cs.push(["a", "b", "c"])
    assert cs.depth == 2
    assert cs.get_all_positional() == ["a", "b", "c"]
    cs.pop()
    assert cs.depth == 1
    assert cs.get_all_positional() == []


def test_get_all_positional():
    cs = CallStack()
    cs.push(["x", "y"])
    assert cs.get_all_positional() == ["x", "y"]


def test_set_positional():
    cs = CallStack()
    cs.set_positional(["a", "b"])
    assert cs.get_all_positional() == ["a", "b"]


def test_pop_bottom_frame_safe():
    cs = CallStack()
    cs.pop()
    assert cs.depth == 1


def test_local_vars():
    cs = CallStack()
    cs.push()
    cs.set_local("x", "inner")
    assert cs.get_local("x") == "inner"
    cs.pop()
    assert cs.get_local("x") is None


def test_local_vars_nested():
    cs = CallStack()
    cs.push()
    cs.set_local("x", "outer")
    cs.push()
    cs.set_local("x", "inner")
    assert cs.get_local("x") == "inner"
    cs.pop()
    assert cs.get_local("x") == "outer"


def test_function_name():
    cs = CallStack()
    cs.push(["a"], function_name="greet")
    assert cs.current.function_name == "greet"
    cs.pop()
    assert cs.current.function_name == ""


def test_loop_level_reset_on_push():
    cs = CallStack()
    cs.current.loop_level = 3
    cs.push([], function_name="f")
    assert cs.current.loop_level == 0
    cs.pop()
    assert cs.current.loop_level == 3


def test_fork_copies_every_frame_without_sharing_mutable_state():
    parent = CallStack()
    parent.set_positional(["outer"])
    parent.set_local("x", "outer")
    parent.push(["a", "b"], function_name="f")
    parent.set_local("x", "inner")
    parent.current.loop_level = 2
    child = parent.fork()
    parent.current.positional.append("c")
    parent.set_local("x", "changed")
    parent.pop()
    assert child.depth == 2
    assert child.get_all_positional() == ["a", "b"]
    assert child.get_local("x") == "inner"
    assert child.current.function_name == "f"
    assert child.current.loop_level == 2
    child.pop()
    child.set_local("x", "child")
    child.current.positional.append("child")
    assert parent.get_local("x") == "outer"
    assert parent.get_all_positional() == ["outer"]
