# yapf: disable
from mirage.commands.builtin.find_eval import (Action, And, Empty, FindArgs,
                                               FindEntry, Mtime, Name, Not, Or,
                                               Path, PendingPrune, Prune,
                                               TrueNode, Type, args_to_tree,
                                               bind_tree, build_tree,
                                               compute_nonempty_dirs,
                                               display_path, drop_pruned,
                                               emit_start_path, eval_predicate,
                                               keep, pending_prunes,
                                               pruned_keys, settle_prunes,
                                               tree_has_action, tree_has_prune,
                                               tree_has_type, unrespell_raw,
                                               without_prune)
# yapf: enable
from mirage.types import FindType


def _entry(key="/data/a.txt",
           name="a.txt",
           kind="f",
           depth=1,
           is_empty=None,
           mtime=None):
    return FindEntry(key=key,
                     name=name,
                     kind=kind,
                     depth=depth,
                     is_empty=is_empty,
                     mtime=mtime)


def test_empty_node():
    assert eval_predicate(Empty(), _entry(is_empty=True)) is True
    assert eval_predicate(Empty(), _entry(is_empty=False)) is False
    assert eval_predicate(Empty(), _entry(is_empty=None)) is False


def test_build_tree_empty_adds_empty_node():
    tree = build_tree(empty=True)
    assert eval_predicate(tree, _entry(is_empty=True)) is True
    assert eval_predicate(tree, _entry(is_empty=False)) is False


def test_build_tree_empty_combined_with_type():
    tree = build_tree(type="d", empty=True)
    assert eval_predicate(tree, _entry(kind="d", is_empty=True)) is True
    assert eval_predicate(tree, _entry(kind="d", is_empty=False)) is False
    assert eval_predicate(tree, _entry(kind="f", is_empty=True)) is False


def test_compute_nonempty_dirs():
    keys = [
        "/data", "/data/a.txt", "/data/sub", "/data/sub/nested.txt",
        "/data/emptydir"
    ]
    nonempty = compute_nonempty_dirs(keys)
    assert "/data" in nonempty
    assert "/data/sub" in nonempty
    assert "/data/emptydir" not in nonempty


def test_name_matches_glob():
    assert eval_predicate(Name("*.txt"), _entry()) is True
    assert eval_predicate(Name("*.md"), _entry()) is False


def test_iname_is_case_insensitive():
    e = _entry(name="A.TXT")
    assert eval_predicate(Name("*.txt", icase=True), e) is True
    assert eval_predicate(Name("*.txt", icase=False), e) is False


def test_path_matches_key():
    e = _entry(key="/data/sub/x", name="x")
    assert eval_predicate(Path("*/sub/*"), e) is True
    assert eval_predicate(Path("*/other/*"), e) is False


def test_type_matches_kind():
    assert eval_predicate(Type("f"), _entry(kind="f")) is True
    assert eval_predicate(Type("d"), _entry(kind="f")) is False
    assert eval_predicate(Type("d"), _entry(kind="d")) is True


def test_not_negates():
    assert eval_predicate(Not(Name("*.txt")), _entry()) is False
    assert eval_predicate(Not(Name("*.md")), _entry()) is True


def test_and_all():
    node = And([Name("*.txt"), Type("f")])
    assert eval_predicate(node, _entry()) is True
    assert eval_predicate(And([Name("*.txt"), Type("d")]), _entry()) is False


def test_or_any():
    node = Or([Name("*.md"), Name("*.txt")])
    assert eval_predicate(node, _entry()) is True
    assert eval_predicate(Or([Name("*.md"), Name("*.rst")]), _entry()) is False


def test_true_node_matches_everything():
    assert eval_predicate(TrueNode(), _entry()) is True


def test_keep_applies_mindepth():
    e = _entry(depth=1)
    assert keep(e, TrueNode(), min_depth=None) is True
    assert keep(e, TrueNode(), min_depth=1) is True
    assert keep(e, TrueNode(), min_depth=2) is False


def test_args_to_tree_empty_args_is_true():
    tree = args_to_tree(FindArgs())
    assert eval_predicate(tree, _entry()) is True


def test_args_to_tree_name_and_type():
    tree = args_to_tree(FindArgs(name="*.txt", type="f"))
    assert eval_predicate(tree, _entry(kind="f")) is True
    assert eval_predicate(tree, _entry(name="a.md", kind="f")) is False
    assert eval_predicate(tree, _entry(kind="d")) is False


def test_args_to_tree_name_exclude_is_negated():
    tree = args_to_tree(FindArgs(name_exclude="*.txt"))
    assert eval_predicate(tree, _entry(name="a.txt")) is False
    assert eval_predicate(tree, _entry(name="a.md")) is True


def test_args_to_tree_or_names():
    tree = args_to_tree(FindArgs(or_names=["*.md", "*.txt"]))
    assert eval_predicate(tree, _entry(name="a.txt")) is True
    assert eval_predicate(tree, _entry(name="a.md")) is True
    assert eval_predicate(tree, _entry(name="a.rst")) is False


def test_args_to_tree_iname():
    tree = args_to_tree(FindArgs(iname="*.txt"))
    assert eval_predicate(tree, _entry(name="A.TXT")) is True


def test_build_tree_from_params_matches_args_to_tree():
    tree = build_tree(name="*.txt", type="f")
    assert eval_predicate(tree, _entry(kind="f")) is True
    assert eval_predicate(tree, _entry(kind="d")) is False


def test_build_tree_findtype_enum():
    tree = build_tree(type=FindType.DIRECTORY)
    assert eval_predicate(tree, _entry(kind="d")) is True
    assert eval_predicate(tree, _entry(kind="f")) is False


def test_build_tree_file_directory_string_aliases():
    assert eval_predicate(build_tree(type="file"), _entry(kind="f")) is True
    assert eval_predicate(build_tree(type="file"), _entry(kind="d")) is False
    assert eval_predicate(build_tree(type="directory"),
                          _entry(kind="d")) is True


def test_tree_has_type():
    assert tree_has_type(Type("f")) is True
    assert tree_has_type(Name("x")) is False
    assert tree_has_type(And([Name("x"), Type("d")])) is True
    assert tree_has_type(Not(Type("f"))) is True
    assert tree_has_type(Or([Name("a"), Name("b")])) is False
    assert tree_has_type(TrueNode()) is False


def test_path_matches_display_path():
    # -path matches the path as printed (mount prefix + key), so a
    # pattern naming the mount segment matches once the tree is stamped
    # with the prefix (#396).
    tree = bind_tree(Path("*data/sub*"), "/data")
    assert eval_predicate(tree, _entry(key="/sub", name="sub",
                                       kind="d")) is True
    assert eval_predicate(tree, _entry(key="/other")) is False
    exact = bind_tree(Path("/data/sub"), "/data")
    assert eval_predicate(exact, _entry(key="/sub", kind="d")) is True


def test_path_matches_the_row_as_typed():
    # `find . -path ./skip` prints and matches `./skip`: the row is the
    # display path respelled under the operand as typed (#1147).
    tree = bind_tree(Path("./skip"), "/w", "/w", ".")
    assert eval_predicate(tree, _entry(key="/skip", name="skip",
                                       kind="d")) is True
    assert eval_predicate(tree, _entry(key="/skip/a", name="a")) is False
    absolute = bind_tree(Path("./skip"), "/w", "/w", "/w")
    assert eval_predicate(absolute, _entry(key="/skip", kind="d")) is False
    nested = bind_tree(Path("sub/deep"), "/data", "/data/sub", "sub")
    assert eval_predicate(nested, _entry(key="/sub/deep", kind="d")) is True


def test_bind_tree_rewrites_nested_and_copies_every_ledger():
    tree = bind_tree(And([Path("/data/*"), Name("x")]), "/data")
    assert eval_predicate(tree, _entry(key="/x", name="x")) is True
    shared = And([Path("*a*"), Prune()])
    first = bind_tree(shared, "")
    second = bind_tree(shared, "")
    assert first == shared and first is not shared
    keep(_entry(key="/a", name="a", kind="d"), first, None)
    assert pruned_keys(first) == ["/a"]
    assert pruned_keys(second) == []
    assert pruned_keys(shared) == []


def test_action_marks_the_entry_and_keep_reports_only_reached_actions():
    # `-path ./skip -prune -o -type f -print` holds for ./skip yet never
    # reaches the print, so the directory is not a row.
    tree = bind_tree(
        Or([And([Path("./skip"), Prune()]),
            And([Type("f"), Action("print")])]), "/w", "/w", ".")
    assert eval_predicate(tree, _entry(key="/skip", kind="d")) is True
    assert keep(_entry(key="/skip", name="skip", kind="d"), tree,
                None) is False
    assert keep(_entry(key="/keep/f", name="f"), tree, None) is True
    assert keep(_entry(key="/keep", name="keep", kind="d"), tree,
                None) is False
    # Without an action the rows are what the whole expression holds for.
    plain = bind_tree(Or([And([Path("./skip"), Prune()]),
                          Type("f")]), "/w", "/w", ".")
    assert keep(_entry(key="/skip", name="skip", kind="d"), plain,
                None) is True


def test_prune_records_directories_and_drop_pruned_keeps_the_directory():
    tree = bind_tree(Or([And([Name("skip"), Prune()]), Action("print")]), "")
    rows = [
        "/", "/keep", "/keep/f", "/skip", "/skip/inner", "/skip/inner/d",
        "/skipped"
    ]
    kept = [
        r for r in rows if keep(
            _entry(key=r,
                   name=r.rsplit("/", 1)[-1],
                   kind="d" if r in ("/", "/keep", "/skip",
                                     "/skip/inner") else "f"), tree, None)
    ]
    assert kept == [
        "/", "/keep", "/keep/f", "/skip/inner", "/skip/inner/d", "/skipped"
    ]
    assert pruned_keys(tree) == ["/skip"]
    assert drop_pruned(kept, tree) == ["/", "/keep", "/keep/f", "/skipped"]
    # A pruned file (an object store key that is also a directory prefix)
    # drops nothing.
    file_tree = bind_tree(And([Name("data"), Prune()]), "")
    keep(_entry(key="/data", name="data", kind="f"), file_tree, None)
    assert pruned_keys(file_tree) == []
    # Rows under a mount prefix compare as display paths.
    under = bind_tree(Prune(), "/m")
    keep(_entry(key="/skip", name="skip", kind="d"), under, None)
    assert drop_pruned(["/m/skip", "/m/skip/a", "/m/other"], under,
                       "/m") == ["/m/skip", "/m/other"]
    # The pruned root itself stays, though every row starts with its stem.
    root = bind_tree(Prune(), "")
    keep(_entry(key="/", name="", kind="d", depth=0), root, None)
    assert drop_pruned(["/", "/a", "/a/b"], root) == ["/"]


def test_mtime_node_answers_from_the_entry_and_defers_without_one():
    node = Mtime(100.0, None)
    assert eval_predicate(node, _entry(mtime=150.0)) is True
    assert eval_predicate(node, _entry(mtime=50.0)) is False
    assert eval_predicate(node, _entry()) is True
    assert eval_predicate(Mtime(None, 100.0), _entry(mtime=150.0)) is False


def test_prune_past_an_undecided_time_test_is_pending_until_settled():
    tree = bind_tree(And([Mtime(100.0, None), Prune()]), "")
    for key in ("/old", "/new"):
        assert keep(_entry(key=key, name=key[1:], kind="d"), tree, None)
    # Pending counts as pruned until the caller learns the mtimes.
    assert pruned_keys(tree) == ["/old", "/new"]
    assert [p.entry.key for p in pending_prunes(tree)] == ["/old", "/new"]
    rows = ["/old", "/old/f", "/new", "/new/g"]
    assert drop_pruned(rows, tree) == ["/old", "/new"]
    # A key the mapping does not name stays pending.
    settle_prunes(tree, {"/old": 50.0})
    assert pruned_keys(tree) == ["/new"]
    assert [p.entry.key for p in pending_prunes(tree)] == ["/new"]
    settle_prunes(tree, {"/new": 150.0})
    assert pruned_keys(tree) == ["/new"]
    assert pending_prunes(tree) == []
    assert drop_pruned(rows, tree) == ["/old", "/old/f", "/new"]
    # bind_tree hands out a fresh pending ledger too.
    bound = bind_tree(
        Prune(pending=[PendingPrune(_entry(key="/y", kind="d"))]), "")
    assert bound == Prune()


def test_prune_before_a_time_test_is_firm():
    tree = bind_tree(And([Prune(), Mtime(100.0, None)]), "")
    assert keep(_entry(key="/old", name="old", kind="d"), tree, None)
    assert pruned_keys(tree) == ["/old"]
    assert pending_prunes(tree) == []


def test_prune_with_a_known_mtime_needs_no_settling():
    tree = bind_tree(And([Mtime(100.0, None), Prune()]), "")
    assert not keep(_entry(key="/old", name="old", kind="d", mtime=50.0), tree,
                    None)
    assert keep(_entry(key="/new", name="new", kind="d", mtime=150.0), tree,
                None)
    assert pruned_keys(tree) == ["/new"]
    assert pending_prunes(tree) == []


def test_settling_needs_every_deferred_test_to_hold():

    def two() -> And:
        return bind_tree(
            And([Mtime(100.0, None),
                 Mtime(None, 200.0),
                 Prune()]), "")

    tree = two()
    keep(_entry(key="/d", name="d", kind="d"), tree, None)
    assert [p.entry.key for p in pending_prunes(tree)] == ["/d"]
    settle_prunes(tree, {"/d": 250.0})
    assert pruned_keys(tree) == []
    tree = two()
    keep(_entry(key="/d", name="d", kind="d"), tree, None)
    settle_prunes(tree, {"/d": 150.0})
    assert pruned_keys(tree) == ["/d"]
    # A directory without a reported mtime never passes a time test.
    tree = bind_tree(And([Mtime(100.0, None), Prune()]), "")
    keep(_entry(key="/d", name="d", kind="d"), tree, None)
    settle_prunes(tree, {"/d": None})
    assert pruned_keys(tree) == []


def test_deferred_tests_stay_with_the_branch_that_needs_them():
    # `( -mtime 1 -type f ) -o ( -type d -prune )`: the first arm fails on
    # -type f whatever the mtime, so the prune on the second is firm and
    # no stat is owed (GNU prunes every directory here).
    tree = bind_tree(
        Or([
            And([Mtime(100.0, None), Type("f")]),
            And([Type("d"), Prune()]),
        ]), "")
    assert keep(_entry(key="/d", name="d", kind="d"), tree, None)
    assert pending_prunes(tree) == []
    assert pruned_keys(tree) == ["/d"]
    # `( ! -mtime +N -type d ) -o -prune`: the failing factor's own test
    # is the one that may flip, so the prune waits on it.
    tree = bind_tree(Or([And([Not(Mtime(None, 100.0)),
                              Type("d")]),
                         Prune()]), "")
    assert keep(_entry(key="/d", name="d", kind="d"), tree, None)
    assert [p.entry.key for p in pending_prunes(tree)] == ["/d"]
    settle_prunes(tree, {"/d": 150.0})
    assert pruned_keys(tree) == []
    tree = bind_tree(Or([And([Not(Mtime(None, 100.0)),
                              Type("d")]),
                         Prune()]), "")
    keep(_entry(key="/d", name="d", kind="d"), tree, None)
    settle_prunes(tree, {"/d": 50.0})
    assert pruned_keys(tree) == ["/d"]


def test_settling_evaluates_the_expression_again():
    # `( -mtime 1 -o -type d ) -prune`: a directory failing the time test
    # still reaches the prune through -type d, as GNU's does.
    tree = bind_tree(And([Or([Mtime(100.0, None), Type("d")]), Prune()]), "")
    assert keep(_entry(key="/d", name="d", kind="d"), tree, None)
    assert [p.entry.key for p in pending_prunes(tree)] == ["/d"]
    settle_prunes(tree, {"/d": 50.0})
    assert pending_prunes(tree) == []
    assert pruned_keys(tree) == ["/d"]
    # Without a reported mtime every time test is false; the prune is
    # still reached here, and not past a bare test.
    tree = bind_tree(And([Or([Mtime(100.0, None), Type("d")]), Prune()]), "")
    keep(_entry(key="/d", name="d", kind="d"), tree, None)
    settle_prunes(tree, {"/d": None})
    assert pruned_keys(tree) == ["/d"]
    # An action reached again while settling changes nothing: the rows
    # were decided at the walk.
    tree = bind_tree(And([Mtime(100.0, None), Prune(), Action("print")]), "")
    assert keep(_entry(key="/d", name="d", kind="d"), tree, None)
    settle_prunes(tree, {"/d": 150.0})
    assert pruned_keys(tree) == ["/d"]


def test_a_time_test_steering_past_every_prune_leaves_the_directory_pending():
    # `-mtime 1 -o -prune`: without its mtime the directory takes the
    # first arm, but GNU prunes it when the test fails, so it waits.
    def either() -> Or:
        return bind_tree(Or([Mtime(100.0, None), Prune()]), "")

    tree = either()
    assert keep(_entry(key="/d", name="d", kind="d"), tree, None)
    assert [p.entry.key for p in pending_prunes(tree)] == ["/d"]
    assert pruned_keys(tree) == ["/d"]
    settle_prunes(tree, {"/d": 150.0})
    assert pruned_keys(tree) == []
    tree = either()
    keep(_entry(key="/d", name="d", kind="d"), tree, None)
    settle_prunes(tree, {"/d": 50.0})
    assert pruned_keys(tree) == ["/d"]
    # A file has nothing to prune, a known mtime decides at once, and a
    # tree without -prune has nothing to wait for.
    tree = either()
    assert keep(_entry(key="/f", name="f", kind="f"), tree, None)
    assert keep(_entry(key="/d", name="d", kind="d", mtime=150.0), tree, None)
    assert pending_prunes(tree) == []
    tree = bind_tree(Or([Mtime(100.0, None), Type("d")]), "")
    assert keep(_entry(key="/d", name="d", kind="d"), tree, None)
    assert pending_prunes(tree) == []


def test_mindepth_prunes_nothing_above_its_level():
    tree = bind_tree(Or([And([Name("skip"), Prune()]), Action("print")]), "")
    assert keep(_entry(key="/skip", name="skip", kind="d", depth=1), tree,
                2) is False
    assert pruned_keys(tree) == []


def test_without_prune_and_tree_has_helpers():
    tree = Or([And([Path("./skip"), Prune()]), Not(Action("print"))])
    assert tree_has_prune(tree) and tree_has_action(tree)
    assert without_prune(tree) == Or(
        [And([Path("./skip"), TrueNode()]),
         Not(Action("print"))])
    assert not tree_has_prune(without_prune(tree))
    assert not tree_has_action(Or([Path("x"), Prune()]))


def test_display_path_joins_like_apply_mount_prefix():
    assert display_path("", "/sub/x") == "/sub/x"
    assert display_path("/data", "/sub/x") == "/data/sub/x"
    assert display_path("/data", "/") == "/data"


def test_emit_start_path_directory_size_zero():
    # A directory start path contributes size 0: -size +N excludes it,
    # -size -N keeps it (#318).
    results: list[str] = []
    emit_start_path(results,
                    "/data",
                    "data",
                    kind="d",
                    is_empty=None,
                    exists=True,
                    tree=TrueNode(),
                    maxdepth=None,
                    mindepth=None,
                    min_size=5,
                    max_size=None)
    assert results == []
    emit_start_path(results,
                    "/data",
                    "data",
                    kind="d",
                    is_empty=None,
                    exists=True,
                    tree=TrueNode(),
                    maxdepth=None,
                    mindepth=None,
                    min_size=None,
                    max_size=5)
    assert results == ["/data"]


def test_unrespell_raw_round_trip():
    assert unrespell_raw("./sub/x", "/data", ".") == "/data/sub/x"
    assert unrespell_raw(".", "/data", ".") == "/data"
    assert unrespell_raw("/data/x", "/data", "/data") == "/data/x"
