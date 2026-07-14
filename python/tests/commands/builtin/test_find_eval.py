# yapf: disable
from mirage.commands.builtin.find_eval import (And, Empty, FindEntry, Name,
                                               Not, Or, Path, TrueNode, Type,
                                               args_to_tree, build_tree,
                                               compute_nonempty_dirs,
                                               display_path, emit_start_path,
                                               eval_predicate, keep,
                                               prefix_path_nodes,
                                               tree_has_type)
# yapf: enable
from mirage.commands.builtin.generic.find import FindArgs
from mirage.types import FindType


def _entry(key="/data/a.txt", name="a.txt", kind="f", depth=1, is_empty=None):
    return FindEntry(key=key,
                     name=name,
                     kind=kind,
                     depth=depth,
                     is_empty=is_empty)


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
    tree = prefix_path_nodes(Path("*data/sub*"), "/data")
    assert eval_predicate(tree, _entry(key="/sub", name="sub",
                                       kind="d")) is True
    assert eval_predicate(tree, _entry(key="/other")) is False
    exact = prefix_path_nodes(Path("/data/sub"), "/data")
    assert eval_predicate(exact, _entry(key="/sub", kind="d")) is True


def test_prefix_path_nodes_rewrites_nested_and_keeps_root_mount():
    tree = prefix_path_nodes(And([Path("/data/*"), Name("x")]), "/data")
    assert eval_predicate(tree, _entry(key="/x", name="x")) is True
    same = Or([Path("*a*"), Type("f")])
    assert prefix_path_nodes(same, "") is same


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
