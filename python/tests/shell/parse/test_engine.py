from mirage.shell.parse.engine import BASH_LANGUAGE, TS_PARSER


def test_the_shared_parser_reads_with_the_bash_grammar():
    assert TS_PARSER.language is BASH_LANGUAGE
    root = TS_PARSER.parse(b"echo hi | wc -l").root_node
    assert [child.type for child in root.children] == ["pipeline"]
