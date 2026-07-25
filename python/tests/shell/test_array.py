from mirage.shell.array import (array_append, array_count, array_extent,
                                array_get, array_has, array_indices, array_set,
                                array_slice, array_unset, array_values,
                                make_array)


def test_make_array_is_dense_from_zero():
    arr = make_array(["a", "b"])
    assert arr == ["a", "b"]
    assert array_indices(arr) == [0, 1]


def test_set_pads_with_holes_not_empty_strings():
    arr: list[str | None] = []
    array_set(arr, 3, "v")
    assert arr == [None, None, None, "v"]
    # The hole is addressable but is not an element.
    assert array_count(arr) == 1
    assert array_values(arr) == ["v"]
    assert array_indices(arr) == [3]
    assert array_extent(arr) == 4
    assert array_get(arr, 0) == ""
    assert not array_has(arr, 0)
    assert array_has(arr, 3)


def test_unset_interior_element_keeps_later_indices():
    arr = make_array(["zero", "one", "two"])
    array_unset(arr, 1)
    assert arr == ["zero", None, "two"]
    assert array_get(arr, 2) == "two"
    assert array_count(arr) == 2
    assert array_indices(arr) == [0, 2]


def test_unset_trailing_element_shrinks_the_extent():
    arr = make_array(["x", "y", "z"])
    array_unset(arr, 2)
    assert arr == ["x", "y"]
    assert array_extent(arr) == 2


def test_unset_trailing_element_drops_earlier_holes_too():
    arr = make_array(["x", "y", "z"])
    array_unset(arr, 1)
    array_unset(arr, 2)
    assert arr == ["x"]


def test_unset_out_of_range_is_a_no_op():
    arr = make_array(["x"])
    array_unset(arr, 5)
    array_unset(arr, -1)
    assert arr == ["x"]


def test_append_starts_at_the_extent():
    arr = make_array(["x", "y", "z"])
    array_unset(arr, 1)
    array_append(arr, ["w"])
    assert arr == ["x", None, "z", "w"]
    assert array_indices(arr) == [0, 2, 3]


def test_append_refills_a_trailing_hole():
    arr = make_array(["x", "y", "z"])
    array_unset(arr, 2)
    array_append(arr, ["w"])
    assert arr == ["x", "y", "w"]


def test_set_reassigns_a_hole():
    arr = make_array(["x", "y", "z"])
    array_unset(arr, 1)
    array_set(arr, 1, "new")
    assert arr == ["x", "new", "z"]
    assert array_count(arr) == 3


def test_empty_string_is_an_element_not_a_hole():
    arr = make_array(["", "y"])
    assert array_count(arr) == 2
    assert array_indices(arr) == [0, 1]
    assert array_values(arr) == ["", "y"]


def test_slice_keeps_subscripts_not_ordinals():
    arr: list[str | None] = []
    array_set(arr, 1, "b")
    array_set(arr, 3, "d")
    array_set(arr, 9, "j")
    # Offset 2 means "index >= 2", not "skip the first two values".
    assert array_slice(arr, 2, None) == ["d", "j"]
    assert array_slice(arr, 0, None) == ["b", "d", "j"]
    assert array_slice(arr, 4, None) == ["j"]
    assert array_slice(arr, 20, None) == []


def test_slice_length_counts_elements_taken():
    arr: list[str | None] = []
    array_set(arr, 1, "b")
    array_set(arr, 3, "d")
    array_set(arr, 9, "j")
    assert array_slice(arr, 2, 1) == ["d"]
    assert array_slice(arr, 0, 2) == ["b", "d"]
    assert array_slice(arr, 0, -1) == ["b", "d"]


def test_slice_negative_offset_counts_from_the_extent():
    arr: list[str | None] = []
    array_set(arr, 1, "b")
    array_set(arr, 9, "j")
    assert array_slice(arr, -1, None) == ["j"]
    # Still negative after the extent is added: nothing, not everything.
    assert array_slice(arr, -20, None) == []
    assert array_slice(make_array(["x", "y", "z"]), -5, None) == []
    assert array_slice(make_array(["x", "y", "z"]), -2, None) == ["y", "z"]
