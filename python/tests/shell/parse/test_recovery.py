import pytest

from mirage.shell import parse
from mirage.shell.helpers import get_redirects
from mirage.shell.types import NodeType as NT


# tree-sitter-bash 0.25.1 drops a later unbraced `$var` out of its word
# when the name is cut short by a name-terminating character: the `$`
# stays behind as a literal token and the rest splits into a sibling
# word (`/api/$c/$id.json` -> `/api/$c/$` + `id.json`). parse() rebraces
# the orphaned expansion and reparses, so consumers see one whole word.
@pytest.mark.parametrize(
    ("command", "target"),
    [
        ("echo hi > /api/$c/$id.json", "/api/$c/${id}.json"),
        ("echo hi > /api/$c/$id-x", "/api/$c/${id}-x"),
        ("echo hi > /w/$a/$b/$c", "/w/$a/${b}/$c"),
        ("echo hi > ${a}.$b.json", "${a}.${b}.json"),
        ("echo hi > /w/$c/$1.json", "/w/$c/${1}.json"),
        ("echo hi > /w/$c/$12.json", "/w/$c/${1}2.json"),
        ("echo hi > /é💡/$c/$123abc.json", "/é💡/$c/${1}23abc.json"),
        ("echo hi > /w/$c/$_id9.json", "/w/$c/${_id9}.json"),
    ],
)
def test_redirect_target_later_unbraced_var_stays_one_word(command, target):
    node = parse(command).named_children[0]
    assert node.type == NT.REDIRECTED_STATEMENT
    _, redirects = get_redirects(node)
    assert len(redirects) == 1
    assert redirects[0].target == target
