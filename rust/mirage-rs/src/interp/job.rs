//! A running expansion as its host drives it: starting it runs it to its
//! first request or its end, each answer runs it on to the next, and a
//! long list of fields comes back in slices the host takes one at a time,
//! letting others run between them.

use super::expand::Field;
use super::task::{Answer, Ask, Ended, Expanded, Task};

/// The fields one slice of a result holds.
pub const SLICE: usize = 4096;

/// Where a run stopped: a request the operation waits on, or its end,
/// with the shell it held for its owner to take back.
pub enum Step {
    Asked(Ask),
    Ended(Ended<Expanded>),
}

pub struct Job {
    task: Task<Ended<Expanded>>,
    ended: bool,
    rest: std::vec::IntoIter<Field>,
}

impl Job {
    /// Start `task`: run it to its first request or its end.
    pub fn start(task: Task<Ended<Expanded>>) -> (Self, Step) {
        let mut job = Self {
            task,
            ended: false,
            rest: Vec::new().into_iter(),
        };
        let step = job.run();
        (job, step)
    }

    /// Answer the request the operation waits on and run it to the next;
    /// None once it has ended.
    pub fn answer(&mut self, answer: Answer) -> Option<Step> {
        if self.ended {
            return None;
        }
        self.task.answer(answer);
        Some(self.run())
    }

    /// Whether slices of the result are left to take.
    pub fn more(&self) -> bool {
        self.rest.len() > 0
    }

    /// The result's next slice.
    pub fn slice(&mut self) -> Vec<Field> {
        self.rest.by_ref().take(SLICE).collect()
    }

    fn run(&mut self) -> Step {
        if let Some(ask) = self.task.step() {
            return Step::Asked(ask);
        }
        let ended = self.task.output();
        self.ended = true;
        let Some(mut ended) = ended else {
            unreachable!("an operation that asks nothing more has ended once");
        };
        if let Ok(Expanded::Fields(fields)) = &mut ended.result {
            if fields.len() > SLICE {
                self.rest = fields.split_off(SLICE).into_iter();
            }
        }
        Step::Ended(ended)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::interp::shell::Shell;
    use crate::interp::task::{Mode, expand};
    use crate::vars::{Store, Value};

    fn start(line: &[u8], words: &[u8]) -> (Job, Step) {
        let mut shell = Shell::new(Store::new(Arc::new(|| 1)));
        shell.vars.seed("x", Value::Scalar(words.to_vec()));
        let tree = Arc::new(crate::shell::parse(line));
        let word = (0..tree.nodes.len())
            .find(|&n| tree.kind(n) == "simple_expansion")
            .unwrap();
        Job::start(expand(shell, tree, word, Mode::Fields))
    }

    #[test]
    fn a_job_that_asks_nothing_ends_where_it_starts() {
        let (job, step) = start(b"echo $x", b"a b");
        let Step::Ended(ended) = step else {
            panic!("expected an end");
        };
        let Ok(Expanded::Fields(fields)) = ended.result else {
            panic!("expected fields");
        };
        assert_eq!(fields.len(), 2);
        assert!(!job.more());
    }

    #[test]
    fn a_long_list_of_fields_comes_in_slices() {
        let words: Vec<u8> = (0..SLICE * 2 + 5)
            .flat_map(|i| format!("{i} ").into_bytes())
            .collect();
        let (mut job, step) = start(b"echo $x", &words);
        let Step::Ended(ended) = step else {
            panic!("expected an end");
        };
        let Ok(Expanded::Fields(first)) = ended.result else {
            panic!("expected fields");
        };
        assert_eq!(first.len(), SLICE);
        assert!(job.more());
        assert_eq!(job.slice().len(), SLICE);
        let last = job.slice();
        assert_eq!(last.len(), 5);
        assert_eq!(
            last[4].0,
            vec![(format!("{}", SLICE * 2 + 4).into_bytes(), false)]
        );
        assert!(!job.more());
        assert!(job.answer(Answer::Resumed).is_none());
    }
}
