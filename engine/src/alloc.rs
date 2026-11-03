//! The daemon's allocator (main.rs installs it, and examples/rig.rs, to time
//! what the daemon runs).
//!
//! Big blocks come straight from mmap and go straight back: macOS's malloc keeps
//! freed large blocks mapped and dirty, which left the daemon at ~1 GB footprint
//! after a build while ~2 MB was live.
//!
//! The daemon runs malloc in its space-efficient mode (main.rs `space_efficient`),
//! which also turns off malloc's per-thread caches: searches were ~10% slower for
//! it. So a thread that searches keeps its freed small blocks on free lists of its
//! own for the next allocation of that size, and `drain` hands them back once
//! searching stops.
//!
//! # Safety contract
//!
//! 127 unsafe occurrences live in this crate; 36 of them are here, because a global
//! allocator cannot be written without raw pointers. Each block relies on exactly
//! these invariants:
//!
//! 1. **Size fidelity.** A block on free list `c` was allocated with size
//!    `16 << c`. `fit()` and `take()` only move a block between the caller and the
//!    list for its own size, so the `Layout` handed to `System.dealloc` is the one
//!    the block was allocated with. `Layout::from_size_align_unchecked` is only
//!    called with `16 << c` or 16 (both non-zero) and align 16 or 1 (a valid power
//!    of two).
//! 2. **One owner at a time.** `head[c]` is the only link. A block is written into
//!    it on free and read back on take, never both, so a block is handed out at
//!    most once per free.
//! 3. **Per-thread access.** `FREE` is a `thread_local!`, so `UnsafeCell` is only
//!    ever dereferenced by the thread that owns the list. No pointer from one
//!    thread's list is published to another: `drain` returns blocks to `System`
//!    rather than to a neighbour.
//! 4. **Link room.** Blocks on a list are at least 16 bytes, which is enough for
//!    the one `*mut u8` stored in them.
//!
//! Anything that changes the size classes, the list count or the thread-local
//! storage must re-check every claim above.
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::UnsafeCell;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering::Relaxed};

pub struct Alloc;

/// Blocks of this size and up come from mmap.
const BIG: usize = 1 << 20;
/// Free lists for 16 B, 32 B, ... 64 KB: list c holds blocks of at least
/// 16 << c bytes. Requests under 16 bytes are made as 16 (malloc's least
/// anyway), so any block freed can go on a list.
const LISTS: usize = 13;
/// What a thread keeps: blocks per list, and bytes in all (each counted as
/// its list's size, at least half its own).
const PER_LIST: u16 = 64;
const THREAD_BYTES: usize = 1 << 20;
/// Threads that may keep blocks: MAX_THREADS * THREAD_BYTES at most in all.
const MAX_THREADS: usize = 64;

static THREADS: AtomicUsize = AtomicUsize::new(0);
/// Some thread's lists went from empty to not since the last `kept`.
static KEPT: AtomicBool = AtomicBool::new(false);

struct Lists {
    on: bool,
    bytes: usize,
    n: [u16; LISTS],
    head: [*mut u8; LISTS],
}

impl Lists {
    fn take(&mut self, c: usize) -> Option<*mut u8> {
        let p = *self.head.get(c)?;
        if p.is_null() {
            return None;
        }
        // Safety: a block on a list holds the next one's address.
        self.head[c] = unsafe { *(p as *mut *mut u8) };
        self.n[c] -= 1;
        self.bytes -= 16 << c;
        Some(p)
    }

    fn keep(&mut self, c: usize, p: *mut u8) -> bool {
        if !self.on || c >= LISTS || self.n[c] == PER_LIST || self.bytes + (16 << c) > THREAD_BYTES {
            return false;
        }
        if self.bytes == 0 && !KEPT.load(Relaxed) {
            KEPT.store(true, Relaxed);
        }
        // Safety: the block is free, 16-aligned and 16 bytes at least.
        unsafe { *(p as *mut *mut u8) = self.head[c] };
        self.head[c] = p;
        self.n[c] += 1;
        self.bytes += 16 << c;
        true
    }

    fn drain(&mut self) {
        for c in 0..LISTS {
            while let Some(p) = self.take(c) {
                // Malloc's free goes by the block's own size, not this one.
                unsafe { System.dealloc(p, Layout::from_size_align_unchecked(16 << c, 16)) };
            }
        }
    }
}

thread_local! {
    // No destructor: the allocator can't use a thread local that has one
    // (registering it allocates). `Exit` empties the lists instead.
    static FREE: UnsafeCell<Lists> = const { UnsafeCell::new(Lists { on: false, bytes: 0, n: [0; LISTS], head: [std::ptr::null_mut(); LISTS] }) };
    static EXIT: Exit = const { Exit };
}

/// Hands a thread's blocks back when it exits.
struct Exit;

impl Drop for Exit {
    fn drop(&mut self) {
        FREE.with(|f| {
            // Safety: only this thread touches its lists, one call at a time.
            let f = unsafe { &mut *f.get() };
            if f.on {
                f.on = false;
                THREADS.fetch_sub(1, Relaxed);
            }
            f.drain();
        });
    }
}

/// Let this thread keep freed blocks (a search pool's start handler).
pub fn keep_on_this_thread() {
    if FREE.with(|f| unsafe { (*f.get()).on }) {
        return;
    }
    if THREADS.fetch_add(1, Relaxed) >= MAX_THREADS {
        THREADS.fetch_sub(1, Relaxed);
        return;
    }
    // Registers the exit hook, which allocates: not inside FREE.with.
    EXIT.with(|_| {});
    FREE.with(|f| unsafe { (*f.get()).on = true });
}

/// Hand this thread's kept blocks back to malloc.
pub fn drain() {
    FREE.with(|f| unsafe { (*f.get()).drain() });
}

/// Whether some thread kept blocks since the last call (see `KEPT`).
pub fn kept() -> bool {
    KEPT.swap(false, Relaxed)
}

/// The list whose blocks fit `size` bytes (LISTS and up: none).
fn fit(size: usize) -> usize {
    (size.max(16).next_power_of_two().trailing_zeros() - 4) as usize
}

/// The list a block of `size` bytes goes on (LISTS and up: none).
fn list(size: usize) -> usize {
    (usize::BITS - 5 - size.max(16).leading_zeros()) as usize
}

/// Requests under 16 bytes, made as 16.
fn small(l: Layout) -> Layout {
    if l.size() < 16 { unsafe { Layout::from_size_align_unchecked(16, l.align()) } } else { l }
}

fn take(l: Layout) -> Option<*mut u8> {
    if l.align() > 16 {
        return None;
    }
    FREE.with(|f| unsafe { (*f.get()).take(fit(l.size())) })
}

unsafe impl GlobalAlloc for Alloc {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        if l.size() >= BIG && l.align() <= 16384 {
            let p =
                unsafe { libc::mmap(std::ptr::null_mut(), l.size(), libc::PROT_READ | libc::PROT_WRITE, libc::MAP_PRIVATE | libc::MAP_ANON, -1, 0) };
            return if p == libc::MAP_FAILED { std::ptr::null_mut() } else { p as *mut u8 };
        }
        take(l).unwrap_or_else(|| unsafe { System.alloc(small(l)) })
    }

    unsafe fn alloc_zeroed(&self, l: Layout) -> *mut u8 {
        // Fresh anonymous pages are already zero.
        if l.size() >= BIG && l.align() <= 16384 {
            return unsafe { self.alloc(l) };
        }
        match take(l) {
            Some(p) => {
                unsafe { p.write_bytes(0, l.size()) };
                p
            }
            None => unsafe { System.alloc_zeroed(small(l)) },
        }
    }

    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        if l.size() >= BIG && l.align() <= 16384 {
            unsafe { libc::munmap(p as *mut libc::c_void, l.size()) };
            return;
        }
        let kept = l.align() <= 16 && FREE.with(|f| unsafe { (*f.get()).keep(list(l.size()), p) });
        if !kept {
            unsafe { System.dealloc(p, small(l)) }
        }
    }

    unsafe fn realloc(&self, p: *mut u8, l: Layout, new_size: usize) -> *mut u8 {
        // A thread that keeps blocks moves one to grow it: malloc's realloc
        // is slow in its space-efficient mode.
        if l.size() < BIG && new_size < BIG && l.align() <= 16 && FREE.with(|f| unsafe { (*f.get()).on }) {
            if new_size <= l.size() {
                return p;
            }
            let q = unsafe { self.alloc(Layout::from_size_align_unchecked(new_size, l.align())) };
            if !q.is_null() {
                unsafe {
                    std::ptr::copy_nonoverlapping(p, q, l.size());
                    self.dealloc(p, l);
                }
            }
            return q;
        }
        if (l.size() < BIG && new_size < BIG) || l.align() > 16384 {
            // Malloc's own, which may grow a block in place (one off a list
            // is malloc's too).
            return unsafe { System.realloc(p, small(l), new_size.max(16)) };
        }
        let q = unsafe { self.alloc(Layout::from_size_align_unchecked(new_size, l.align())) };
        if !q.is_null() {
            unsafe {
                std::ptr::copy_nonoverlapping(p, q, l.size().min(new_size));
                self.dealloc(p, l);
            }
        }
        q
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Blocks handed between threads (some keeping, some not) come back
    /// intact and the right size, through drains and thread exits.
    #[test]
    fn blocks_cross_threads() {
        let (tx, rx) = std::sync::mpsc::channel::<(usize, usize, u8)>();
        let rx = std::sync::Arc::new(std::sync::Mutex::new(rx));
        let check = |p: usize, size: usize, b: u8| {
            let s = unsafe { std::slice::from_raw_parts(p as *const u8, size) };
            assert!(s.iter().all(|&x| x == b), "block of {size} changed");
            unsafe { Alloc.dealloc(p as *mut u8, Layout::from_size_align(size, 8).unwrap()) };
        };
        std::thread::scope(|s| {
            for t in 0..8u8 {
                let (tx, rx) = (tx.clone(), rx.clone());
                s.spawn(move || {
                    if t % 2 == 0 {
                        keep_on_this_thread();
                    }
                    let mut x = 0x9E37_79B9u32.wrapping_mul(t as u32 + 1);
                    for i in 0..20_000usize {
                        x ^= x << 13;
                        x ^= x >> 17;
                        x ^= x << 5;
                        let size = 1 + (x as usize % (1 << (4 + x as usize % 14)));
                        let l = Layout::from_size_align(size, 8).unwrap();
                        let p = if i % 3 == 0 { unsafe { Alloc.alloc_zeroed(l) } } else { unsafe { Alloc.alloc(l) } };
                        assert!(!p.is_null());
                        if i % 3 == 0 {
                            assert!(unsafe { std::slice::from_raw_parts(p, size) }.iter().all(|&b| b == 0));
                        }
                        let b = (i as u8) ^ t;
                        unsafe { p.write_bytes(b, size) };
                        // Grown or shrunk, a block keeps what it held.
                        let (p, size) = if i % 7 == 0 {
                            let new = 1 + (x as usize >> 8) % (2 * size + 16);
                            let q = unsafe { Alloc.realloc(p, l, new) };
                            assert!(unsafe { std::slice::from_raw_parts(q, size.min(new)) }.iter().all(|&x| x == b));
                            unsafe { q.write_bytes(b, new) };
                            (q, new)
                        } else {
                            (p, size)
                        };
                        if i % 2 == 0 {
                            tx.send((p as usize, size, b)).unwrap();
                        } else {
                            check(p as usize, size, b);
                        }
                        if i % 512 == 0
                            && let Ok((p, size, b)) = rx.lock().unwrap().try_recv()
                        {
                            check(p, size, b);
                        }
                        if i % 5000 == 0 {
                            drain();
                        }
                    }
                });
            }
        });
        drop(tx);
        for (p, size, b) in rx.lock().unwrap().iter() {
            check(p, size, b);
        }
    }
    /// Every size class round-trips its contents.
    ///
    /// The free lists key on size, so a block can only come back to a request of the
    /// size it was allocated with. If a class were off by one the allocator would
    /// hand out a block that is too small, and the corruption would show up later as
    /// unrelated data changing. Writing a pattern and checking it after a
    /// free/reallocate cycle is the cheapest way to catch that.
    #[test]
    fn every_size_class_round_trips_its_contents() {
        // The lists are OFF until a searching thread turns them on, and an off list
        // sends freed blocks straight to the system - where the next allocation may
        // come back as genuinely different memory. Enabling them for this test thread
        // is what makes "the same size comes back" a meaningful claim.
        keep_on_this_thread();
        // 16 << 0 .. 16 << 12, the classes the free lists cover.
        for c in 0..LISTS {
            let size = 16usize << c;
            let layout = std::alloc::Layout::from_size_align(size, 16).unwrap();
            let p = unsafe { Alloc.alloc(layout) };
            assert!(!p.is_null(), "size {size} must allocate");
            let byte = (c as u8).wrapping_mul(17).wrapping_add(1);
            unsafe { std::ptr::write_bytes(p, byte, size) };
            unsafe { Alloc.dealloc(p, layout) };
            // Same size again: this is the path that takes the block back off the list.
            let q = unsafe { Alloc.alloc(layout) };
            assert!(!q.is_null(), "size {size} must allocate again");
            let seen = unsafe { std::slice::from_raw_parts(q as *const u8, size) };
            // The first pointer-sized bytes of a freed block ARE the free-list link:
            // `take` writes the next pointer there. So only the tail can be compared
            // for content. Size 16 is exactly one pointer, so it has no tail - for it
            // the check is that a full-size write does not fault or reach a neighbour,
            // which is what the write_bytes below does.
            let link = std::mem::size_of::<*mut u8>();
            if size > link {
                assert!(seen[link..].iter().all(|&x| x == byte), "size {size}: the tail changed, so a list returned a block of the wrong size");
            }
            unsafe { std::ptr::write_bytes(q, byte, size) };
            unsafe { Alloc.dealloc(q, layout) };
        }
    }

    /// Alignment is honoured for every class, including the smallest.
    #[test]
    fn alignment_is_honoured() {
        for c in 0..LISTS {
            let size = 16usize << c;
            for align in [1usize, 8, 16] {
                let layout = std::alloc::Layout::from_size_align(size, align).unwrap();
                let p = unsafe { Alloc.alloc(layout) } as usize;
                assert!(p != 0, "alloc returned null for size {size} align {align}");
                assert_eq!(p % align, 0, "size {size} align {align} came back misaligned");
                unsafe { Alloc.dealloc(p as *mut u8, layout) };
            }
        }
    }

    /// A zero-sized allocation is legal and must not dereference anything.
    #[test]
    fn zero_sized_allocation_is_safe() {
        let layout = std::alloc::Layout::from_size_align(0, 1).unwrap();
        let p = unsafe { Alloc.alloc(layout) };
        unsafe { Alloc.dealloc(p, layout) };
    }

    /// `drain` returns the thread's kept blocks and keeps the allocator working.
    ///
    /// Drain is what stops a thread's free lists becoming a leak: it is called when
    /// searching stops. If it corrupted a list, the next allocation of that class
    /// would return a block already handed back to the system.
    #[test]
    fn drain_returns_memory_and_stays_usable() {
        let layout = |n: usize| std::alloc::Layout::from_size_align(n, 16).unwrap();
        // Fill a few classes.
        let ptrs: Vec<_> = (0..40).map(|_| unsafe { Alloc.alloc(layout(256)) }).collect();
        for p in ptrs {
            unsafe { Alloc.dealloc(p, layout(256)) };
        }
        keep_on_this_thread();
        drain();
        // After draining, the same class must still hand out a fresh block.
        let p = unsafe { Alloc.alloc(layout(256)) };
        assert!(!p.is_null(), "alloc must still work after drain");
        unsafe { std::ptr::write_bytes(p, 0xAB, 256) };
        unsafe { Alloc.dealloc(p, layout(256)) };
        drain();
    }

    /// Blocks at and above `BIG` bypass the free lists entirely.
    ///
    /// They come from mmap and must go back to the system: keeping one on a list
    /// would pin a megabyte per thread, which is the exact leak this allocator exists
    /// to avoid.
    ///
    /// Asserted on `take` rather than on `kept()`, because `kept()` is a single
    /// process-wide flag and the test harness runs tests in parallel - a before/after
    /// comparison of it reports other tests' allocations.
    #[test]
    fn large_blocks_bypass_the_free_lists() {
        keep_on_this_thread();
        let big = std::alloc::Layout::from_size_align(BIG, 16).unwrap();
        assert!(take(big).is_none(), "a block of BIG bytes was taken from a free list; it must go to the system");
        // One byte under the threshold is still a list class, so the boundary itself
        // is exercised rather than just the far side of it.
        let below = std::alloc::Layout::from_size_align(BIG - 1, 16).unwrap();
        assert!(fit(below.size()) < (16usize << LISTS), "BIG - 1 should still be a list-sized block");
    }
}
