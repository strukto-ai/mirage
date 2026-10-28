use std::cell::{Cell, RefCell};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

/// The bytes of values one run holds alive at once: charged when a
/// value is made or grown, credited when its last reference drops.
pub(crate) struct Meter {
    live: AtomicUsize,
    limit: usize,
    exceeded: AtomicBool,
}

impl Default for Meter {
    fn default() -> Self {
        Self::limited(usize::MAX)
    }
}

impl Meter {
    pub(crate) fn limited(limit: usize) -> Self {
        Self {
            live: AtomicUsize::new(0),
            limit,
            exceeded: AtomicBool::new(false),
        }
    }

    pub(crate) fn live(&self) -> usize {
        self.live.load(Ordering::Relaxed)
    }

    pub(crate) fn exceeded(&self) -> bool {
        self.exceeded.load(Ordering::Relaxed)
    }

    pub(crate) fn reset(&self) {
        self.exceeded
            .store(self.live() > self.limit, Ordering::Relaxed);
    }

    fn charge(&self, bytes: usize) {
        let before = self.live.fetch_add(bytes, Ordering::Relaxed);
        if before.saturating_add(bytes) > self.limit {
            self.exceeded.store(true, Ordering::Relaxed);
        }
    }

    fn credit(&self, bytes: usize) {
        self.live.fetch_sub(bytes, Ordering::Relaxed);
    }
}

thread_local! {
    static CURRENT: RefCell<Option<Arc<Meter>>> = const { RefCell::new(None) };
    static RECORD_ONLY: Cell<bool> = const { Cell::new(false) };
}

pub(crate) struct Recording {
    previous: bool,
}

/// Synchronous callers finish their result while retaining the allocation
/// peak, which the enclosing evaluator reports as a terminal error.
pub(crate) fn record_only() -> Recording {
    Recording {
        previous: RECORD_ONLY.with(|cell| cell.replace(true)),
    }
}

impl Drop for Recording {
    fn drop(&mut self) {
        RECORD_ONLY.with(|cell| cell.set(self.previous));
    }
}

pub(crate) fn should_pause() -> bool {
    !RECORD_ONLY.with(Cell::get) && exceeded()
}

/// The meter a value made on this thread is charged to: the run whose
/// stream method or user-program compilation is executing.
pub(crate) fn current() -> Option<Arc<Meter>> {
    CURRENT.with(|cell| cell.borrow().clone())
}

/// `meter` made current until this drops, when the previous one returns.
pub(crate) struct Installed {
    previous: Option<Arc<Meter>>,
}

pub(crate) fn install(meter: &Arc<Meter>) -> Installed {
    let previous = CURRENT.with(|cell| cell.replace(Some(Arc::clone(meter))));
    Installed { previous }
}

pub(crate) fn suspend() -> Installed {
    let previous = CURRENT.with(|cell| cell.replace(None));
    Installed { previous }
}

impl Drop for Installed {
    fn drop(&mut self) {
        CURRENT.with(|cell| cell.replace(self.previous.take()));
    }
}

/// What one value charged the meter current when it was made, kept in
/// step as the value grows or shrinks and credited back when it drops.
pub(crate) struct Charge {
    meter: Option<Arc<Meter>>,
    bytes: usize,
}

impl Charge {
    pub(crate) fn open(bytes: usize) -> Self {
        let meter = current();
        if let Some(meter) = &meter {
            meter.charge(bytes);
        }
        Self { meter, bytes }
    }

    pub(crate) fn set(&mut self, bytes: usize) {
        if let Some(meter) = &self.meter {
            if bytes > self.bytes {
                meter.charge(bytes - self.bytes);
            } else {
                meter.credit(self.bytes - bytes);
            }
        }
        self.bytes = bytes;
    }
}

impl Drop for Charge {
    fn drop(&mut self) {
        if let Some(meter) = &self.meter {
            meter.credit(self.bytes);
        }
    }
}

impl Default for Charge {
    fn default() -> Self {
        Self::open(0)
    }
}

pub(crate) fn exceeded() -> bool {
    CURRENT.with(|cell| cell.borrow().as_ref().is_some_and(|meter| meter.exceeded()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn synchronous_scopes_keep_the_peak_and_restore_task_pausing() {
        let meter = Arc::new(Meter::limited(100));
        let _installed = install(&meter);
        {
            let _recording = record_only();
            drop(Charge::open(101));
            assert!(meter.exceeded());
            assert!(!should_pause());
            drop(record_only());
            assert!(!should_pause());
        }
        assert_eq!(meter.live(), 0);
        assert!(should_pause());
    }

    #[test]
    fn a_released_temporary_keeps_the_document_over_limit() {
        let meter = Arc::new(Meter::limited(100));
        let _installed = install(&meter);
        let temporary = Charge::open(101);
        drop(temporary);
        assert_eq!(meter.live(), 0);
        assert!(meter.exceeded());
        meter.reset();
        assert!(!meter.exceeded());
        for _ in 0..1000 {
            drop(Charge::open(90));
        }
        assert_eq!(meter.live(), 0);
        assert!(!meter.exceeded());
    }
}
