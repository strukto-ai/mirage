from functools import partial

import pytest

from mirage.types import PathSpec
from mirage.utils.path import CycleError, resolve_symlinks
from mirage.workspace.executor.builtins.dirs.dirs import (
    join_raw,
    norm,
    resolve_target,
    split_mode_options,
    typed_path,
)


def test_split_mode_options_cluster_and_last_wins():
    operands, bad, physical = split_mode_options(["-LP", "x"])
    assert operands == ["x"]
    assert bad is None
    assert physical is True
    _, _, physical = split_mode_options(["-P", "-L"])
    assert physical is False


def test_split_mode_options_reports_the_first_unknown_letter():
    operands, bad, physical = split_mode_options(["-Lz", "x"], "LP")
    assert bad == "z"
    assert operands == []


def test_split_mode_options_bare_dash_and_double_dash():
    operands, bad, _ = split_mode_options(["-"])
    assert operands == ["-"] and bad is None
    operands, bad, physical = split_mode_options(["--", "-P"])
    assert operands == ["-P"] and bad is None and physical is False


def test_split_mode_options_reads_a_pathspec_operand():
    spec = PathSpec.from_str_path("/data/x")
    operands, bad, physical = split_mode_options([spec], default=True)
    assert operands == [spec] and bad is None and physical is True


def test_norm_and_join_raw():
    assert norm("//a/./b/../c") == "/a/c"
    assert join_raw("x/..", "/data") == "/data/x/.."
    assert join_raw("/abs", "/data") == "/abs"


def test_typed_path_keeps_the_spelling():
    spec = PathSpec.from_str_path("/data/x")
    assert typed_path(spec) == (spec.raw_path or spec.virtual)
    assert typed_path("y") == "y"


def test_resolve_target_logical_vs_physical():
    follow = partial(resolve_symlinks, links={"/data/lk": "/data/deep/real"})
    assert resolve_target("/data/lk/..", follow, physical=False) == "/data"
    assert resolve_target("/data/lk/..", follow, physical=True) == "/data/deep"


def test_resolve_target_refuses_a_loop():
    with pytest.raises(CycleError):
        resolve_target(
            "/a",
            partial(resolve_symlinks, links={"/a": "/b", "/b": "/a"}),
            physical=True,
        )
