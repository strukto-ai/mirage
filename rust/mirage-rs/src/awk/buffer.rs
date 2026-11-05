use std::ops::{Deref, DerefMut};

pub(super) struct Buffer<T> {
    pub(super) values: Vec<T>,
    previous: Option<std::vec::IntoIter<T>>,
}

impl<T> Default for Buffer<T> {
    fn default() -> Self {
        Self {
            values: Vec::new(),
            previous: None,
        }
    }
}

impl<T> Buffer<T> {
    pub(super) fn with_capacity(capacity: usize) -> Self {
        Self {
            values: Vec::with_capacity(capacity),
            previous: None,
        }
    }

    pub(super) fn len(&self) -> usize {
        self.values.len() + self.previous.as_ref().map_or(0, ExactSizeIterator::len)
    }

    pub(super) fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub(super) fn reserve(&mut self, additional: usize, work: &mut u64) -> bool {
        loop {
            if let Some(previous) = &mut self.previous {
                let cost = std::mem::size_of::<T>().max(1) as u64;
                let count = previous.len().min(work.div_ceil(cost) as usize);
                self.values.extend(previous.by_ref().take(count));
                *work = work.saturating_sub((count as u64).saturating_mul(cost));
                if previous.len() > 0 {
                    return false;
                }
                self.previous = None;
            }
            if self.values.capacity() - self.values.len() >= additional {
                return true;
            }
            let capacity = self
                .values
                .len()
                .saturating_mul(2)
                .saturating_add(additional)
                .max(64);
            self.previous =
                Some(std::mem::replace(&mut self.values, Vec::with_capacity(capacity)).into_iter());
        }
    }

    pub(super) fn take(&mut self) -> Vec<T> {
        assert!(self.previous.is_none());
        std::mem::take(&mut self.values)
    }

    pub(super) fn pop(&mut self) -> Option<T> {
        self.values
            .pop()
            .or_else(|| self.previous.as_mut().and_then(Iterator::next))
    }
}

impl Buffer<u8> {
    pub(super) fn compact(&mut self, start: usize, additional: usize) {
        assert!(self.previous.is_none());
        let capacity = self.values.len() - start + additional;
        let mut previous =
            std::mem::replace(&mut self.values, Vec::with_capacity(capacity)).into_iter();
        if start > 0 {
            previous.nth(start - 1);
        }
        self.previous = Some(previous);
    }
}

impl<T> Deref for Buffer<T> {
    type Target = [T];
    fn deref(&self) -> &[T] {
        assert!(self.previous.is_none());
        &self.values
    }
}

impl<T> DerefMut for Buffer<T> {
    fn deref_mut(&mut self) -> &mut [T] {
        assert!(self.previous.is_none());
        &mut self.values
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn growth_and_retirement_move_owned_values_once_within_budget() {
        for budget in [1, 17, 20000] {
            let mut buffer = Buffer::with_capacity(4096);
            buffer.values.extend((0..4096).map(Box::new));
            let mut turns = 0;
            loop {
                let before = buffer.values.len();
                let mut work = budget;
                let done = buffer.reserve(1, &mut work);
                let moved = if turns == 0 {
                    buffer.values.len()
                } else {
                    buffer.values.len() - before
                };
                assert!(
                    moved <= budget.div_ceil(std::mem::size_of::<Box<usize>>() as u64) as usize
                );
                turns += 1;
                if done {
                    break;
                }
                assert_eq!(buffer.len(), 4096);
                assert_eq!(work, 0);
                assert!(turns < 5000);
            }
            assert_eq!(
                buffer.iter().map(|value| **value).collect::<Vec<_>>(),
                (0..4096).collect::<Vec<_>>()
            );
            buffer.values.push(Box::new(4096));
            assert_eq!(buffer.take().len(), 4097);
        }
        let mut buffer = Buffer::with_capacity(64);
        buffer.values.extend((0..64).map(Box::new));
        assert!(!buffer.reserve(1, &mut 1));
        let mut retired = Vec::new();
        while let Some(value) = buffer.pop() {
            retired.push(*value);
        }
        retired.sort_unstable();
        assert_eq!(retired, (0..64).collect::<Vec<_>>());
        assert!(buffer.is_empty());
    }
}
