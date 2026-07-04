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

from mirage import MountMode, Workspace
from mirage.resource.ram import RAMResource
from mirage.shell.node_kind import NodeKind

# Drift guard: every statement kind the executor supports must have a
# pinned provision expectation here. The map must cover the full enum
# (asserted below), so adding a NodeKind forces deciding what the
# planner reports for it; a construct can no longer be supported by
# the executor and silently mis-planned.
#
# The seeded file is 24 bytes. Expectations are
# (snippet, network_read, network_write, precision).
PLANS = {
    NodeKind.COMMENT: ("# a comment", "0", "0", "exact"),
    NodeKind.PROGRAM: ("cat /data/a.txt; cat /data/a.txt", "48", "0", "exact"),
    NodeKind.COMMAND: ("cat /data/a.txt", "24", "0", "exact"),
    NodeKind.PIPELINE: ("cat /data/a.txt | wc -l", "24", "0", "exact"),
    NodeKind.LIST: ("cat /data/a.txt && cat /data/a.txt", "48", "0", "exact"),
    NodeKind.REDIRECT:
    ("cat /data/a.txt > /data/out.txt", "24", "0-24", "range"),
    NodeKind.SUBSHELL: ("(cat /data/a.txt)", "24", "0", "exact"),
    NodeKind.COMPOUND: ("{ cat /data/a.txt; }", "24", "0", "exact"),
    NodeKind.IF: ("if true; then cat /data/a.txt; fi", "0-24", "0", "range"),
    NodeKind.FOR:
    ("for i in 1 2; do cat /data/a.txt; done", "48", "0", "exact"),
    NodeKind.SELECT:
    ("select x in a b; do cat /data/a.txt; done", "24", "0", "unknown"),
    NodeKind.WHILE:
    ("while true; do cat /data/a.txt; done", "24", "0", "unknown"),
    NodeKind.UNTIL: ("until false; do cat /data/a.txt; done", "24", "0",
                     "unknown"),
    NodeKind.CASE: ("case x in x) cat /data/a.txt;; esac", "24", "0", "range"),
    NodeKind.FUNCTION_DEF: ("f() { cat /data/a.txt; }", "0", "0", "exact"),
    NodeKind.DECLARATION: ("export FOO=1", "0", "0", "exact"),
    NodeKind.UNSET: ("unset FOO", "0", "0", "exact"),
    NodeKind.TEST: ("[[ -n x ]]", "0", "0", "exact"),
    NodeKind.NEGATED: ("! grep zzz /data/a.txt", "24", "0", "exact"),
    NodeKind.VAR_ASSIGN: ("FOO=1", "0", "0", "exact"),
    NodeKind.UNSUPPORTED: ("for ((i=0;i<2;i++)); do true; done", "0", "0",
                           "unknown"),
}


def test_plans_cover_the_full_enum():
    assert set(PLANS) == set(NodeKind)


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", list(NodeKind))
async def test_every_kind_plans(kind):
    snippet, net, write, precision = PLANS[kind]
    ws = Workspace({"/data": RAMResource()}, mode=MountMode.WRITE)
    await ws.execute("tee /data/a.txt > /dev/null", stdin=b"x" * 24)
    result = await ws.execute(snippet, provision=True)
    assert result.network_read == net, kind
    assert result.network_write == write, kind
    assert result.precision.value == precision, kind
    await ws.close()


@pytest.mark.asyncio
async def test_function_call_and_env_prefix_plan():
    ws = Workspace({"/data": RAMResource()}, mode=MountMode.WRITE)
    await ws.execute("tee /data/a.txt > /dev/null", stdin=b"x" * 24)
    result = await ws.execute("f() { cat /data/a.txt; }; f", provision=True)
    assert result.network_read == "24"
    assert result.precision.value == "exact"
    result = await ws.execute("f() { f; }; f", provision=True)
    assert result.precision.value == "unknown"
    result = await ws.execute("FOO=1 cat /data/a.txt", provision=True)
    assert result.network_read == "24"
    assert result.precision.value == "exact"
    result = await ws.execute("eval 'cat /data/a.txt'", provision=True)
    assert result.precision.value == "unknown"
    result = await ws.execute("wc -l < /data/a.txt", provision=True)
    assert result.network_read == "24"
    result = await ws.execute("cat /data/a.txt > /dev/null", provision=True)
    assert result.network_write == "0"
    assert result.precision.value == "exact"
    await ws.close()


@pytest.mark.asyncio
async def test_provision_follows_symlinks_and_spans_mounts():
    ws = Workspace({
        "/data": RAMResource(),
        "/data2": RAMResource()
    },
                   mode=MountMode.WRITE)
    await ws.execute("tee /data/a.txt > /dev/null", stdin=b"x" * 24)
    await ws.execute("tee /data2/b.txt > /dev/null", stdin=b"y" * 6)
    await ws.execute("ln -s /data/a.txt /data2/lnk.txt")
    result = await ws.execute("cat /data2/lnk.txt", provision=True)
    assert result.network_read == "24"
    assert result.precision.value == "exact"
    result = await ws.execute("cat /data/a.txt /data2/b.txt", provision=True)
    assert result.network_read == "30"
    assert result.read_ops == 2
    assert result.precision.value == "exact"
    result = await ws.execute("cat /data2/b.txt /data/a.txt", provision=True)
    assert result.network_read == "30"
    await ws.close()


@pytest.mark.asyncio
async def test_provision_is_dry_and_case_arms_run_fully():
    ws = Workspace({"/data": RAMResource()}, mode=MountMode.WRITE)
    await ws.execute("tee /data/a.txt > /dev/null", stdin=b"x" * 24)
    # a dry run must not execute command substitutions
    result = await ws.execute(
        "cat $(tee /data/leak.txt > /dev/null; echo /data/a.txt)",
        provision=True)
    assert result.precision.value == "unknown"
    listing = await (await ws.execute("ls /data")).stdout_str()
    assert "leak.txt" not in listing
    # a case arm runs every statement up to its ;; terminator
    out = await (
        await
        ws.execute("case x in x) echo one; echo two;; esac")).stdout_str()
    assert out == "one\ntwo\n"
    result = await ws.execute(
        "case x in x) cat /data/a.txt; cat /data/a.txt;; esac", provision=True)
    assert result.network_read == "48"
    # sed reads its operands; -i degrades to a floor
    result = await ws.execute("sed s/x/y/ /data/a.txt", provision=True)
    assert result.network_read == "24"
    assert result.precision.value == "exact"
    result = await ws.execute("sed -i s/x/y/ /data/a.txt", provision=True)
    assert result.precision.value == "unknown"
    await ws.close()


@pytest.mark.asyncio
async def test_stdin_driven_and_expanded_estimates():
    ws = Workspace({"/data": RAMResource()}, mode=MountMode.WRITE)
    await ws.execute("tee /data/a.txt > /dev/null", stdin=b"x" * 24)
    await ws.execute("mkdir /data/tree")
    await ws.execute("tee /data/tree/b.txt > /dev/null", stdin=b"y" * 10)
    # heredoc-fed stdin is local bytes: exact zero backend I/O
    result = await ws.execute("wc -l <<EOF\nabc\nEOF", provision=True)
    assert result.network_read == "0"
    assert result.precision.value == "exact"
    # globs expand during planning
    result = await ws.execute("cat /data/tree/*.txt", provision=True)
    assert result.network_read == "10"
    assert result.precision.value == "exact"
    # recursive search walks the tree
    result = await ws.execute("grep -r y /data/tree", provision=True)
    assert result.network_read == "10"
    assert result.precision.value == "exact"
    # a suppressed substitution degrades the loop count to a floor
    result = await ws.execute("for i in $(echo 1 2); do cat /data/a.txt; done",
                              provision=True)
    assert result.network_read == "24"
    assert result.precision.value == "unknown"
    # a suppressed substitution hides the redirect target
    result = await ws.execute("cat /data/a.txt > $(echo /data/out.txt)",
                              provision=True)
    assert result.precision.value == "unknown"
    await ws.close()
