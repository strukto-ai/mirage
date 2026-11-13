from mirage.core.generic.find_eval import (
    args_to_tree,
    bind_tree,
    build_tree,
    display_path,
    emit_start_path,
    evaluate,
    keep,
    tree_has_action,
    tree_has_prune,
    tree_has_time,
    unrespell_raw,
    verdict,
    without_prune,
)
from mirage.core.generic.types import (
    Action,
    And,
    Effects,
    Empty,
    FindArgs,
    FindEntry,
    Mtime,
    Name,
    Not,
    Or,
    Path,
    Prune,
    Size,
    TrueNode,
    Type,
)
from mirage.types import FileStat, FileType
from mirage.utils.stat_view import DIR_SIZE


def _entry(
    key="/data/a.txt",
    name="a.txt",
    kind="f",
    depth=1,
    is_empty=None,
    mtime=None,
):
    return FindEntry(
        key=key,
        name=name,
        kind=kind,
        depth=depth,
        is_empty=is_empty,
        mtime=mtime,
    )


def test_size_node_needs_a_stat_for_anything_but_a_directory():
    small = FileStat(name="a.txt", type=FileType.FILE, size=None)
    assert evaluate(Size(max=0), _entry(), Effects()) is False
    assert evaluate(
        Size(max=0),
        FindEntry("/data/a.txt", "a.txt", "f", 1, stat=small),
        Effects(),
    )
    assert evaluate(Size(min=DIR_SIZE), _entry(kind="d"), Effects()) is True


def test_empty_node():
    assert evaluate(Empty(), _entry(is_empty=True), Effects()) is True
    assert evaluate(Empty(), _entry(is_empty=False), Effects()) is False
    assert evaluate(Empty(), _entry(is_empty=None), Effects()) is False


def test_build_tree_empty_adds_empty_node():
    tree = build_tree(empty=True)
    assert evaluate(tree, _entry(is_empty=True), Effects()) is True
    assert evaluate(tree, _entry(is_empty=False), Effects()) is False


def test_build_tree_empty_combined_with_type():
    tree = build_tree(type="d", empty=True)
    assert evaluate(tree, _entry(kind="d", is_empty=True), Effects()) is True
    assert evaluate(tree, _entry(kind="d", is_empty=False), Effects()) is False
    assert evaluate(tree, _entry(kind="f", is_empty=True), Effects()) is False


def test_name_matches_glob():
    assert evaluate(Name("*.txt"), _entry(), Effects()) is True
    assert evaluate(Name("*.md"), _entry(), Effects()) is False


def test_iname_is_case_insensitive():
    e = _entry(name="A.TXT")
    assert evaluate(Name("*.txt", icase=True), e, Effects()) is True
    assert evaluate(Name("*.txt", icase=False), e, Effects()) is False


def test_path_matches_key():
    e = _entry(key="/data/sub/x", name="x")
    assert evaluate(Path("*/sub/*"), e, Effects()) is True
    assert evaluate(Path("*/other/*"), e, Effects()) is False


def test_type_matches_kind():
    assert evaluate(Type("f"), _entry(kind="f"), Effects()) is True
    assert evaluate(Type("d"), _entry(kind="f"), Effects()) is False
    assert evaluate(Type("d"), _entry(kind="d"), Effects()) is True


def test_not_negates():
    assert evaluate(Not(Name("*.txt")), _entry(), Effects()) is False
    assert evaluate(Not(Name("*.md")), _entry(), Effects()) is True


def test_and_all():
    node = And([Name("*.txt"), Type("f")])
    assert evaluate(node, _entry(), Effects()) is True
    assert (
        evaluate(And([Name("*.txt"), Type("d")]), _entry(), Effects()) is False
    )


def test_or_any():
    node = Or([Name("*.md"), Name("*.txt")])
    assert evaluate(node, _entry(), Effects()) is True
    assert (
        evaluate(Or([Name("*.md"), Name("*.rst")]), _entry(), Effects())
        is False
    )


def test_true_node_matches_everything():
    assert evaluate(TrueNode(), _entry(), Effects()) is True


def test_keep_applies_mindepth():
    e = _entry(depth=1)
    assert keep(e, TrueNode(), min_depth=None) is True
    assert keep(e, TrueNode(), min_depth=1) is True
    assert keep(e, TrueNode(), min_depth=2) is False


def test_args_to_tree_empty_args_is_true():
    tree = args_to_tree(FindArgs())
    assert evaluate(tree, _entry(), Effects()) is True


def test_args_to_tree_name_and_type():
    tree = args_to_tree(FindArgs(name="*.txt", type="f"))
    assert evaluate(tree, _entry(kind="f"), Effects()) is True
    assert evaluate(tree, _entry(name="a.md", kind="f"), Effects()) is False
    assert evaluate(tree, _entry(kind="d"), Effects()) is False


def test_args_to_tree_name_exclude_is_negated():
    tree = args_to_tree(FindArgs(name_exclude="*.txt"))
    assert evaluate(tree, _entry(name="a.txt"), Effects()) is False
    assert evaluate(tree, _entry(name="a.md"), Effects()) is True


def test_args_to_tree_or_names():
    tree = args_to_tree(FindArgs(or_names=["*.md", "*.txt"]))
    assert evaluate(tree, _entry(name="a.txt"), Effects()) is True
    assert evaluate(tree, _entry(name="a.md"), Effects()) is True
    assert evaluate(tree, _entry(name="a.rst"), Effects()) is False


def test_args_to_tree_iname():
    tree = args_to_tree(FindArgs(iname="*.txt"))
    assert evaluate(tree, _entry(name="A.TXT"), Effects()) is True


def test_build_tree_from_params_matches_args_to_tree():
    tree = build_tree(name="*.txt", type="f")
    assert evaluate(tree, _entry(kind="f"), Effects()) is True
    assert evaluate(tree, _entry(kind="d"), Effects()) is False


def test_build_tree_file_directory_string_aliases():
    assert (
        evaluate(build_tree(type="file"), _entry(kind="f"), Effects()) is True
    )
    assert (
        evaluate(build_tree(type="file"), _entry(kind="d"), Effects()) is False
    )
    assert (
        evaluate(build_tree(type="directory"), _entry(kind="d"), Effects())
        is True
    )


def test_path_matches_display_path():
    # -path matches the path as printed (mount prefix + key), so a
    # pattern naming the mount segment matches once the tree is stamped
    # with the prefix (#396).
    tree = bind_tree(Path("*data/sub*"), "/data")
    assert (
        evaluate(tree, _entry(key="/sub", name="sub", kind="d"), Effects())
        is True
    )
    assert evaluate(tree, _entry(key="/other"), Effects()) is False
    exact = bind_tree(Path("/data/sub"), "/data")
    assert evaluate(exact, _entry(key="/sub", kind="d"), Effects()) is True


def test_path_matches_the_row_as_typed():
    # `find . -path ./skip` prints and matches `./skip`: the row is the
    # display path respelled under the operand as typed (#1147).
    tree = bind_tree(Path("./skip"), "/w", "/w", ".")
    assert (
        evaluate(tree, _entry(key="/skip", name="skip", kind="d"), Effects())
        is True
    )
    assert evaluate(tree, _entry(key="/skip/a", name="a"), Effects()) is False
    absolute = bind_tree(Path("./skip"), "/w", "/w", "/w")
    assert (
        evaluate(absolute, _entry(key="/skip", kind="d"), Effects()) is False
    )
    nested = bind_tree(Path("sub/deep"), "/data", "/data/sub", "sub")
    assert (
        evaluate(nested, _entry(key="/sub/deep", kind="d"), Effects()) is True
    )


def test_bind_tree_rewrites_nested():
    tree = bind_tree(And([Path("/data/*"), Name("x")]), "/data")
    assert evaluate(tree, _entry(key="/x", name="x"), Effects()) is True
    shared = And([Path("*a*"), Prune()])
    first = bind_tree(shared, "")
    assert first == shared and first is not shared
    entry = _entry(key="/a", name="a", kind="d")
    assert verdict(entry, first, None) == (True, True)


def test_action_marks_the_entry_and_keep_reports_only_reached_actions():
    # `-path ./skip -prune -o -type f -print` holds for ./skip yet never
    # reaches the print, so the directory is not a row.
    tree = bind_tree(
        Or(
            [And([Path("./skip"), Prune()]), And([Type("f"), Action("print")])]
        ),
        "/w",
        "/w",
        ".",
    )
    assert evaluate(tree, _entry(key="/skip", kind="d"), Effects()) is True
    assert (
        keep(_entry(key="/skip", name="skip", kind="d"), tree, None) is False
    )
    assert keep(_entry(key="/keep/f", name="f"), tree, None) is True
    assert (
        keep(_entry(key="/keep", name="keep", kind="d"), tree, None) is False
    )
    # Without an action the rows are what the whole expression holds for.
    plain = bind_tree(
        Or([And([Path("./skip"), Prune()]), Type("f")]), "/w", "/w", "."
    )
    assert (
        keep(_entry(key="/skip", name="skip", kind="d"), plain, None) is True
    )


def test_prune_names_the_directories_it_reaches():
    tree = bind_tree(Or([And([Name("skip"), Prune()]), Action("print")]), "")
    rows = [
        "/",
        "/keep",
        "/keep/f",
        "/skip",
        "/skip/inner",
        "/skip/inner/d",
        "/skipped",
    ]
    answers = {
        r: verdict(
            _entry(
                key=r,
                name=r.rsplit("/", 1)[-1],
                kind="d"
                if r in ("/", "/keep", "/skip", "/skip/inner")
                else "f",
            ),
            tree,
            None,
        )
        for r in rows
    }
    assert [r for r, (kept, _) in answers.items() if kept] == [
        "/",
        "/keep",
        "/keep/f",
        "/skip/inner",
        "/skip/inner/d",
        "/skipped",
    ]
    assert [r for r, (_, pruned) in answers.items() if pruned] == ["/skip"]
    # A pruned file (an object store key that is also a directory prefix)
    # drops nothing.
    file_tree = bind_tree(And([Name("data"), Prune()]), "")
    entry = _entry(key="/data", name="data", kind="f")
    assert verdict(entry, file_tree, None) == (True, False)


def test_mtime_node_answers_from_the_entry_and_defers_without_one():
    node = Mtime(100.0, None)
    assert evaluate(node, _entry(mtime=150.0), Effects()) is True
    assert evaluate(node, _entry(mtime=50.0), Effects()) is False
    assert evaluate(node, _entry(), Effects()) is True
    assert (
        evaluate(Mtime(None, 100.0), _entry(mtime=150.0), Effects()) is False
    )


def test_prune_past_an_undecided_time_test_counts():
    tree = bind_tree(And([Mtime(100.0, None), Prune()]), "")
    for key in ("/old", "/new"):
        entry = _entry(key=key, name=key[1:], kind="d")
        assert verdict(entry, tree, None) == (True, True)


def test_prune_before_a_time_test_fires_whatever_the_time():
    tree = bind_tree(And([Prune(), Mtime(100.0, None)]), "")
    old = _entry(key="/old", name="old", kind="d", mtime=50.0)
    assert verdict(old, tree, None) == (False, True)


def test_prune_with_a_known_mtime_follows_the_test():
    tree = bind_tree(And([Mtime(100.0, None), Prune()]), "")
    old = _entry(key="/old", name="old", kind="d", mtime=50.0)
    new = _entry(key="/new", name="new", kind="d", mtime=150.0)
    assert verdict(old, tree, None) == (False, False)
    assert verdict(new, tree, None) == (True, True)


def test_deferred_tests_stay_with_the_branch_that_needs_them():
    # `( -mtime 1 -type f ) -o ( -type d -prune )`: the first arm fails on
    # -type f whatever the mtime, so the second arm prunes (GNU prunes
    # every directory here).
    tree = bind_tree(
        Or(
            [
                And([Mtime(100.0, None), Type("f")]),
                And([Type("d"), Prune()]),
            ]
        ),
        "",
    )
    entry = _entry(key="/d", name="d", kind="d")
    assert verdict(entry, tree, None) == (True, True)
    # The same failed arm leaves nothing to wait on when the other arm
    # reaches no prune.
    tree = bind_tree(
        Or(
            [
                And([Mtime(100.0, None), Type("f")]),
                And([Name("skip"), Prune()]),
            ]
        ),
        "",
    )
    assert verdict(entry, tree, None) == (False, False)
    # `( ! -mtime +N -type d ) -o -prune`: the failing factor's own test
    # is the one that may flip, so the prune counts.
    tree = bind_tree(
        Or([And([Not(Mtime(None, 100.0)), Type("d")]), Prune()]), ""
    )
    assert verdict(entry, tree, None) == (True, True)


def test_a_time_test_steering_past_every_prune_still_prunes():
    # `-mtime 1 -o -prune`: without its mtime the directory takes the
    # first arm, but GNU prunes it when the test fails, so it counts.
    tree = bind_tree(Or([Mtime(100.0, None), Prune()]), "")
    entry = _entry(key="/d", name="d", kind="d")
    assert verdict(entry, tree, None) == (True, True)
    # A file has nothing to prune, a known mtime decides at once, and a
    # tree without -prune has nothing to wait for.
    assert verdict(_entry(key="/f", name="f"), tree, None) == (True, False)
    known = _entry(key="/d", name="d", kind="d", mtime=150.0)
    assert verdict(known, tree, None) == (True, False)
    plain = bind_tree(Or([Mtime(100.0, None), Type("d")]), "")
    assert verdict(entry, plain, None) == (True, False)


def test_mindepth_prunes_nothing_above_its_level():
    tree = bind_tree(Or([And([Name("skip"), Prune()]), Action("print")]), "")
    entry = _entry(key="/skip", name="skip", kind="d", depth=1)
    assert verdict(entry, tree, 2) == (False, False)


def test_without_prune_and_tree_has_helpers():
    tree = Or([And([Path("./skip"), Prune()]), Not(Action("print"))])
    assert tree_has_prune(tree) and tree_has_action(tree)
    assert without_prune(tree) == Or(
        [And([Path("./skip"), TrueNode()]), Not(Action("print"))]
    )
    assert not tree_has_prune(without_prune(tree))
    assert not tree_has_action(Or([Path("x"), Prune()]))
    assert tree_has_time(And([Path("x"), Not(Mtime(None, 1.0))]))
    assert not tree_has_time(tree)


def test_display_path_joins_the_prefix_and_the_key_with_one_slash():
    assert display_path("", "/sub/x") == "/sub/x"
    assert display_path("/data", "/sub/x") == "/data/sub/x"
    assert display_path("/data", "/") == "/data"


def test_emit_start_path_counts_a_directory_as_dir_size():
    def emit(min_size: int | None, max_size: int | None) -> list[str]:
        results: list[str] = []
        emit_start_path(
            results,
            "/data",
            "data",
            kind="d",
            is_empty=None,
            exists=True,
            tree=TrueNode(),
            maxdepth=None,
            mindepth=None,
            min_size=min_size,
            max_size=max_size,
        )
        return results

    assert emit(5, None) == ["/data"]
    assert emit(None, 5) == []
    assert emit(DIR_SIZE, DIR_SIZE) == ["/data"]
    assert emit(DIR_SIZE + 1, None) == []


def test_unrespell_raw_round_trip():
    assert unrespell_raw("./sub/x", "/data", ".") == "/data/sub/x"
    assert unrespell_raw(".", "/data", ".") == "/data"
    assert unrespell_raw("/data/x", "/data", "/data") == "/data/x"
