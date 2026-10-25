use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use pyo3::prelude::*;
use pyo3::types::{PyBytes, PyString};
use streams::shell::{FIELDS, KINDS, Node, Tree, field_id};

/// Gives each tree a number, so node ids differ across trees.
static TREES: AtomicU64 = AtomicU64::new(0);

/// A parsed shell program.
#[pyclass(module = "mirage._rs", frozen)]
pub struct ShellTree {
    tree: Arc<Tree>,
    serial: u64,
}

#[pymethods]
impl ShellTree {
    #[new]
    fn new(py: Python<'_>, source: &[u8]) -> Self {
        let source = source.to_vec();
        let tree = py.detach(|| streams::shell::parse(&source));
        Self {
            tree: Arc::new(tree),
            serial: TREES.fetch_add(1, Ordering::Relaxed),
        }
    }

    #[getter]
    fn root_node(&self) -> ShellNode {
        ShellNode {
            tree: Arc::clone(&self.tree),
            serial: self.serial,
            index: 0,
        }
    }

    /// The first syntax error: its byte offset and message, or None.
    #[getter]
    fn error(&self) -> Option<(usize, String)> {
        self.tree.error.clone()
    }
}

/// One node of a `ShellTree`, read through the tree it keeps alive.
#[pyclass(module = "mirage._rs", frozen)]
pub struct ShellNode {
    tree: Arc<Tree>,
    serial: u64,
    index: u32,
}

impl ShellNode {
    fn node(&self) -> &Node {
        &self.tree.nodes[self.index as usize]
    }

    fn at(&self, index: u32) -> ShellNode {
        ShellNode {
            tree: Arc::clone(&self.tree),
            serial: self.serial,
            index,
        }
    }

    fn sibling(&self, step: i64) -> Option<ShellNode> {
        let parent = self.node().parent;
        if parent == u32::MAX {
            return None;
        }
        let parent = &self.tree.nodes[parent as usize];
        let index = i64::from(self.index) + step;
        let first = i64::from(parent.first_child);
        let last = first + i64::from(parent.child_count);
        (first..last)
            .contains(&index)
            .then(|| self.at(u32::try_from(index).unwrap_or(u32::MAX)))
    }

    fn child_indices(&self) -> std::ops::Range<u32> {
        let node = self.node();
        node.first_child..node.first_child + node.child_count
    }
}

#[pymethods]
impl ShellNode {
    #[getter]
    fn r#type<'py>(&self, py: Python<'py>) -> Bound<'py, PyString> {
        PyString::intern(py, KINDS[usize::from(self.node().kind)].0)
    }

    #[getter]
    fn text<'py>(&self, py: Python<'py>) -> Bound<'py, PyBytes> {
        let node = self.node();
        PyBytes::new(
            py,
            &self.tree.source[node.start as usize..node.end as usize],
        )
    }

    /// Unique among the nodes of every tree this process parsed.
    #[getter]
    fn id(&self) -> u64 {
        (self.serial << 32) | u64::from(self.index)
    }

    #[getter]
    fn start_byte(&self) -> u32 {
        self.node().start
    }

    #[getter]
    fn end_byte(&self) -> u32 {
        self.node().end
    }

    #[getter]
    fn start_point(&self) -> (u32, u32) {
        let node = self.node();
        (node.start_row, node.start_column)
    }

    #[getter]
    fn end_point(&self) -> (u32, u32) {
        let node = self.node();
        (node.end_row, node.end_column)
    }

    #[getter]
    fn children(&self) -> Vec<ShellNode> {
        self.child_indices().map(|index| self.at(index)).collect()
    }

    #[getter]
    fn named_children(&self) -> Vec<ShellNode> {
        self.child_indices()
            .filter(|index| self.tree.nodes[*index as usize].named)
            .map(|index| self.at(index))
            .collect()
    }

    #[getter]
    fn child_count(&self) -> u32 {
        self.node().child_count
    }

    fn child(&self, index: i64) -> Option<ShellNode> {
        let node = self.node();
        let index = u32::try_from(index).ok()?;
        (index < node.child_count).then(|| self.at(node.first_child + index))
    }

    #[getter]
    fn parent(&self) -> Option<ShellNode> {
        let parent = self.node().parent;
        (parent != u32::MAX).then(|| self.at(parent))
    }

    #[getter]
    fn next_sibling(&self) -> Option<ShellNode> {
        self.sibling(1)
    }

    #[getter]
    fn prev_sibling(&self) -> Option<ShellNode> {
        self.sibling(-1)
    }

    #[getter]
    fn is_named(&self) -> bool {
        self.node().named
    }

    /// Always false: the parser refuses a line instead of inventing a
    /// missing token.
    #[getter]
    fn is_missing(&self) -> bool {
        false
    }

    #[getter]
    fn has_error(&self) -> bool {
        self.node().has_error
    }

    fn child_by_field_name(&self, name: &str) -> Option<ShellNode> {
        let field = field_id(name)?;
        self.child_indices()
            .find(|index| self.tree.nodes[*index as usize].field == field)
            .map(|index| self.at(index))
    }

    fn field_name_for_child(&self, index: u32) -> Option<&'static str> {
        let node = self.node();
        if index >= node.child_count {
            return None;
        }
        let field = self.tree.nodes[(node.first_child + index) as usize].field;
        (field != 0).then(|| FIELDS[usize::from(field) - 1])
    }

    fn __eq__(&self, other: &Bound<'_, PyAny>) -> bool {
        other
            .cast::<ShellNode>()
            .is_ok_and(|other| other.get().id() == self.id())
    }

    fn __hash__(&self) -> u64 {
        self.id()
    }

    fn __repr__(&self) -> String {
        let node = self.node();
        format!(
            "<ShellNode type={} start_byte={} end_byte={}>",
            KINDS[usize::from(node.kind)].0,
            node.start,
            node.end
        )
    }
}
