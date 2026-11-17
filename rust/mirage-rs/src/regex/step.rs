/// What a search that may run out of steps comes back with.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Step<T> {
    Done(T),
    /// Out of steps: the same call again resumes the search.
    Paused,
}

impl<T> Step<T> {
    pub(crate) fn map<U>(self, f: impl FnOnce(T) -> U) -> Step<U> {
        match self {
            Step::Done(value) => Step::Done(f(value)),
            Step::Paused => Step::Paused,
        }
    }
}
