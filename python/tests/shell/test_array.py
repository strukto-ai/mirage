import asyncio

from mirage.shell.array import (
    ShellArray,
    array_extent,
    array_get,
    array_set,
    array_unset,
    build_assoc_literal,
    build_indexed_literal,
    keyed_word,
    make_array,
)


def test_make_array_is_dense_from_zero():
    arr = make_array(["a", "b"])
    assert arr == ShellArray({0: "a", 1: "b"})
    assert list(arr.elements) == [0, 1]


def test_set_holds_only_the_element_it_assigns():
    arr = ShellArray()
    array_set(arr, 3, "v")
    assert arr == ShellArray({3: "v"})
    # An index no write reached is no element.
    assert len(arr.elements) == 1
    assert list(arr.elements.values()) == ["v"]
    assert list(arr.elements) == [3]
    assert array_extent(arr) == 4
    assert array_get(arr, 0) == ""
    assert 0 not in arr.elements
    assert 3 in arr.elements


def test_unset_interior_element_keeps_later_indices():
    arr = make_array(["zero", "one", "two"])
    array_unset(arr, 1)
    assert arr == ShellArray({0: "zero", 2: "two"})
    assert array_get(arr, 2) == "two"
    assert len(arr.elements) == 2
    assert list(arr.elements) == [0, 2]


def test_unset_trailing_element_shrinks_the_extent():
    arr = make_array(["x", "y", "z"])
    array_unset(arr, 2)
    assert arr == ShellArray({0: "x", 1: "y"})
    assert array_extent(arr) == 2


def test_unset_trailing_element_drops_earlier_holes_too():
    arr = make_array(["x", "y", "z"])
    array_unset(arr, 1)
    array_unset(arr, 2)
    assert arr == ShellArray({0: "x"})
    assert array_extent(arr) == 1


def test_unset_out_of_range_is_a_no_op():
    arr = make_array(["x"])
    array_unset(arr, 5)
    array_unset(arr, -1)
    assert arr == ShellArray({0: "x"})


def test_set_reassigns_a_hole():
    arr = make_array(["x", "y", "z"])
    array_unset(arr, 1)
    array_set(arr, 1, "new")
    assert arr == ShellArray({0: "x", 1: "new", 2: "z"})
    assert list(arr.elements) == [0, 1, 2]
    assert len(arr.elements) == 3


def test_empty_string_is_an_element_not_a_hole():
    arr = make_array(["", "y"])
    assert len(arr.elements) == 2
    assert list(arr.elements) == [0, 1]
    assert list(arr.elements.values()) == ["", "y"]


def test_keyed_word():
    assert keyed_word("[a]=1") == ("a", "1")
    assert keyed_word("[two words]=v x") == ("two words", "v x")
    assert keyed_word("plain") is None
    assert keyed_word("[]=x") is None
    assert keyed_word("[k]=") == ("k", "")
    # The split lands on the first `]=`, so a value may hold one.
    assert keyed_word("[a]=x]=y") == ("a", "x]=y")


async def _int_of(text: str) -> int:
    return int(text)


def test_build_indexed_literal_places_and_continues():
    built = asyncio.run(
        build_indexed_literal(None, ["[3]=x", "y", "[1]=z"], False, _int_of)
    )
    assert built == ShellArray({1: "z", 3: "x", 4: "y"})
    assert list(built.elements) == [1, 3, 4]
    # `+=` starts the cursor at the extent; last index wins.
    appended = asyncio.run(
        build_indexed_literal(make_array(["a"]), ["b", "[0]=A"], True, _int_of)
    )
    assert appended == ShellArray({0: "A", 1: "b"})


def test_build_assoc_literal_modes():
    keyed, errors = build_assoc_literal(None, ["[a]=1", "b", "[a]=2"], False)
    assert keyed == {"a": "2"}
    assert errors == ["b"]
    pairs, errors = build_assoc_literal(None, ["k1", "v1", "[a]=1"], False)
    assert pairs == {"k1": "v1", "[a]=1": ""}
    assert errors == []
    merged, errors = build_assoc_literal({"a": "1"}, ["[b]=2"], True)
    assert merged == {"a": "1", "b": "2"}
    assert errors == []
    replaced, _ = build_assoc_literal({"a": "1"}, ["[b]=2"], False)
    assert replaced == {"b": "2"}


def test_a_far_index_holds_one_element():
    arr = make_array(["a"])
    array_set(arr, 1_000_000_000, "far")
    assert len(arr.elements) == 2
    assert array_extent(arr) == 1_000_000_001
    assert list(arr.elements) == [0, 1_000_000_000]
    array_unset(arr, 1_000_000_000)
    assert array_extent(arr) == 1
