import re

import pytest

from mirage.utils.posix import class_characters, translate_classes


@pytest.mark.parametrize('name,yes,no', [
    ('alnum', 'aZ09', '_! '),
    ('alpha', 'aZ', '09_'),
    ('blank', ' \t', '\nA'),
    ('cntrl', '\x00\x1f\x7f', ' A'),
    ('digit', '09', 'aF_'),
    ('graph', '!AZ09~', ' \t'),
    ('lower', 'az', 'AZ0'),
    ('print', ' AZ09~', '\t\n'),
    ('punct', '![]-_', 'aZ0 '),
    ('space', ' \t\n\r\f\v', 'a0'),
    ('upper', 'AZ', 'az0'),
    ('xdigit', '09aAfF', 'gG_'),
])
def test_class_membership(name, yes, no):
    compiled = re.compile(translate_classes(f'^[[:{name}:]]$'))
    expanded = class_characters(name)
    for char in yes:
        assert compiled.fullmatch(char)
        assert char in expanded
    for char in no:
        assert not compiled.fullmatch(char)
        assert char not in expanded


def test_class_order_for_translation():
    assert class_characters('space') == '\t\n\v\f\r '
    assert class_characters('lower') == 'abcdefghijklmnopqrstuvwxyz'


@pytest.mark.parametrize('pattern',
                         ['[[:bogus:]]', '[[:constructor:]]', '[[:digit:]'])
def test_invalid_classes_refused(pattern):
    with pytest.raises(re.error):
        translate_classes(pattern)


def test_escapes_and_mixed_brackets():
    assert re.fullmatch(translate_classes(r'\[\[:digit:\]\]'), '[[:digit:]]')
    compiled = re.compile(translate_classes('^[][:digit:]_]+$'))
    assert compiled.fullmatch(']_123')
    assert not compiled.fullmatch('abc')
