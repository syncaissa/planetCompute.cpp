//! What a contributor (regular program, or a SherpaHub that also contributes) does with a SherpaHub's messages:
//! keeps the blocks it was sent in a bounded cache (weight-stationary), computes PACKs, answers RESULT or NEED.
//! It never cuts, sends or checks work: a regular program DOES the work.

use crate::kernels::matmul_i8;
use crate::wire::{block_id, decode, BlockId, Msg, Need, ResultMsg, UnitOut};
use std::collections::HashMap;

/// View a block's bytes as int8 (same size and alignment).
#[inline]
pub fn as_i8(b: &[u8]) -> &[i8] {
    // SAFETY: u8 and i8 have the same size, alignment and validity (every bit pattern is valid).
    unsafe { std::slice::from_raw_parts(b.as_ptr() as *const i8, b.len()) }
}

/// What the device sends back for one incoming message.
#[derive(Debug)]
pub enum Reply {
    /// Nothing to send (a BLOCK was stored, or the message was refused).
    None,
    /// The pack's results; `compute_ms` is 0 here, the caller who timed the call fills it in.
    Result(ResultMsg),
    /// Blocks the pack needs that are not in the cache.
    Need(Need),
}

pub struct Device {
    cap_bytes: usize,
    used: usize,
    tick: u64,
    blocks: HashMap<BlockId, (Vec<u8>, u64)>,
    pub refused: u64,
}

impl Device {
    /// A device that keeps at most `cap_bytes` of blocks (least recently used are dropped first).
    pub fn new(cap_bytes: usize) -> Self {
        Device { cap_bytes, used: 0, tick: 0, blocks: HashMap::new(), refused: 0 }
    }

    pub fn cached(&self) -> usize {
        self.blocks.len()
    }

    fn store(&mut self, id: BlockId, bytes: Vec<u8>) {
        if bytes.len() > self.cap_bytes || self.blocks.contains_key(&id) {
            return;
        }
        while self.used + bytes.len() > self.cap_bytes {
            let old = *self.blocks.iter().min_by_key(|(_, (_, t))| *t).map(|(k, _)| k).unwrap();
            let (b, _) = self.blocks.remove(&old).unwrap();
            self.used -= b.len();
        }
        self.tick += 1;
        self.used += bytes.len();
        self.blocks.insert(id, (bytes, self.tick));
    }

    /// Handle one message from the hub (one thread).
    pub fn handle(&mut self, bytes: &[u8]) -> Reply {
        self.handle_on(bytes, 1)
    }

    /// Handle one message from the hub, computing a pack's units on up to `threads` threads.
    pub fn handle_on(&mut self, bytes: &[u8], threads: usize) -> Reply {
        let msg = match decode(bytes) {
            Ok(m) => m,
            Err(_) => {
                self.refused += 1;
                return Reply::None;
            }
        };
        match msg {
            Msg::Block(b) => {
                // re-hash: a corrupted block is never used
                if block_id(&b.bytes) == b.id {
                    self.store(b.id, b.bytes);
                } else {
                    self.refused += 1;
                }
                Reply::None
            }
            Msg::Pack(p) => {
                let mut missing: Vec<BlockId> = Vec::new();
                for u in &p.units {
                    for id in [u.a, u.bt] {
                        if !self.blocks.contains_key(&id) && !missing.contains(&id) {
                            missing.push(id);
                        }
                    }
                }
                if !missing.is_empty() {
                    return Reply::Need(Need { job: p.job, pack: p.pack, epoch: p.epoch, blocks: missing });
                }
                for u in &p.units {
                    let (m, k, n) = (u.m as usize, u.k as usize, u.n as usize);
                    self.tick += 1;
                    let t = self.tick;
                    let a = self.blocks.get_mut(&u.a).map(|e| {
                        e.1 = t;
                        e.0.len()
                    });
                    let b = self.blocks.get_mut(&u.bt).map(|e| {
                        e.1 = t;
                        e.0.len()
                    });
                    if a != Some(m * k) || b != Some(n * k) {
                        self.refused += 1;
                        return Reply::None; // sizes in the pack do not match its blocks: refuse the whole pack
                    }
                }
                let blocks = &self.blocks;
                let one = |u: &crate::wire::UnitSpec| {
                    let (m, k, n) = (u.m as usize, u.k as usize, u.n as usize);
                    let mut c = vec![0i32; m * n];
                    matmul_i8(as_i8(&blocks[&u.a].0), as_i8(&blocks[&u.bt].0), m, k, n, &mut c);
                    UnitOut { unit: u.unit, m: u.m, n: u.n, c }
                };
                let threads = threads.clamp(1, p.units.len());
                let units: Vec<UnitOut> = if threads == 1 {
                    p.units.iter().map(one).collect()
                } else {
                    // units split into `threads` runs of neighbours; the order of the RESULT stays the pack's order
                    let per = p.units.len().div_ceil(threads);
                    std::thread::scope(|sc| {
                        let hs: Vec<_> = p.units.chunks(per).map(|ch| sc.spawn(move || ch.iter().map(one).collect::<Vec<_>>())).collect();
                        hs.into_iter().flat_map(|h| h.join().unwrap()).collect()
                    })
                };
                Reply::Result(ResultMsg { job: p.job, pack: p.pack, epoch: p.epoch, compute_ms: 0, units })
            }
            Msg::Result(_) | Msg::Need(_) => {
                self.refused += 1;
                Reply::None
            }
        }
    }
}
