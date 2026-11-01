//! The SherpaHub's checkpoint directory (docs/SHERPAHUB.md section 5.6): crash-safe with one write per unit.
//!
//!   job.hdr    the job (text: key=value), with the epoch (+1 on every open)
//!   result.bin one fixed-size slot per unit (tm * tn i32, unit-major), so a checked tile is ONE contiguous write
//!   done.bits  one bit per unit
//!
//! A bit is only set after its tile is on disk: `flush` syncs result.bin first, then writes and syncs done.bits.

use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

/// A synthetic matmul job: C (m x n) = A (m x k) x B, inputs made from two seeds, cut into tm x tn tiles.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JobSpec {
    pub id: u64,
    pub m: usize,
    pub k: usize,
    pub n: usize,
    pub tm: usize,
    pub tn: usize,
    pub seed_a: u32,
    pub seed_b: u32,
}

impl JobSpec {
    pub fn row_blocks(&self) -> usize {
        self.m.div_ceil(self.tm)
    }
    pub fn col_blocks(&self) -> usize {
        self.n.div_ceil(self.tn)
    }
    pub fn units(&self) -> usize {
        self.row_blocks() * self.col_blocks()
    }
    /// Unit u = tile (row block u / col_blocks, col block u % col_blocks).
    pub fn tile(&self, u: usize) -> (usize, usize) {
        (u / self.col_blocks(), u % self.col_blocks())
    }
    /// Rows of row block i and columns of col block j (edge tiles are smaller).
    pub fn tile_dims(&self, i: usize, j: usize) -> (usize, usize) {
        ((self.m - i * self.tm).min(self.tm), (self.n - j * self.tn).min(self.tn))
    }
    fn slot_bytes(&self) -> u64 {
        (self.tm * self.tn * 4) as u64
    }
    fn to_text(&self, epoch: u32) -> String {
        format!(
            "id={}\nm={}\nk={}\nn={}\ntm={}\ntn={}\nseed_a={}\nseed_b={}\nepoch={}\n",
            self.id, self.m, self.k, self.n, self.tm, self.tn, self.seed_a, self.seed_b, epoch
        )
    }
    fn from_text(t: &str) -> Option<(JobSpec, u32)> {
        let get = |k: &str| t.lines().find_map(|l| l.strip_prefix(k).and_then(|v| v.strip_prefix('='))).map(str::trim);
        let n = |k: &str| get(k)?.parse::<u64>().ok();
        let j = JobSpec {
            id: n("id")?,
            m: n("m")? as usize,
            k: n("k")? as usize,
            n: n("n")? as usize,
            tm: n("tm")? as usize,
            tn: n("tn")? as usize,
            seed_a: n("seed_a")? as u32,
            seed_b: n("seed_b")? as u32,
        };
        Some((j, n("epoch")? as u32))
    }
}

pub struct Store {
    dir: PathBuf,
    pub job: JobSpec,
    pub epoch: u32,
    result: File,
    bits: Vec<u8>,
    dirty: bool,
    pub done: usize,
}

fn io(e: std::io::Error) -> String {
    e.to_string()
}

impl Store {
    /// Start a new job in an empty (or missing) directory.
    pub fn create(dir: &Path, job: JobSpec) -> Result<Store, String> {
        std::fs::create_dir_all(dir).map_err(io)?;
        if dir.join("job.hdr").exists() {
            return Err("this directory already holds a job".into());
        }
        let result = OpenOptions::new().read(true).write(true).create(true).truncate(true).open(dir.join("result.bin")).map_err(io)?;
        result.set_len(job.units() as u64 * job.slot_bytes()).map_err(io)?;
        let bits = vec![0u8; job.units().div_ceil(8)];
        std::fs::write(dir.join("done.bits"), &bits).map_err(io)?;
        write_synced(&dir.join("job.hdr"), job.to_text(1).as_bytes())?;
        Ok(Store { dir: dir.to_path_buf(), job, epoch: 1, result, bits, dirty: false, done: 0 })
    }

    /// Continue a job after a restart: the epoch goes up by one (results for older epochs are refused).
    pub fn open(dir: &Path) -> Result<Store, String> {
        let t = std::fs::read_to_string(dir.join("job.hdr")).map_err(io)?;
        let (job, old) = JobSpec::from_text(&t).ok_or("job.hdr is damaged")?;
        let epoch = old + 1;
        write_synced(&dir.join("job.hdr"), job.to_text(epoch).as_bytes())?;
        let mut bits = std::fs::read(dir.join("done.bits")).map_err(io)?;
        bits.resize(job.units().div_ceil(8), 0);
        let done = (0..job.units()).filter(|&u| bits[u / 8] & (1 << (u % 8)) != 0).count();
        let result = OpenOptions::new().read(true).write(true).open(dir.join("result.bin")).map_err(io)?;
        Ok(Store { dir: dir.to_path_buf(), job, epoch, result, bits, dirty: false, done })
    }

    pub fn is_done(&self, u: usize) -> bool {
        self.bits[u / 8] & (1 << (u % 8)) != 0
    }

    /// Write a checked unit's tile (rows x cols i32, row-major) into its slot and mark it (on disk at the next flush).
    pub fn put(&mut self, u: usize, c: &[i32]) -> Result<(), String> {
        if self.is_done(u) {
            return Ok(());
        }
        let mut b = Vec::with_capacity(c.len() * 4);
        for x in c {
            b.extend_from_slice(&x.to_le_bytes());
        }
        self.result.seek(SeekFrom::Start(u as u64 * self.job.slot_bytes())).map_err(io)?;
        self.result.write_all(&b).map_err(io)?;
        self.bits[u / 8] |= 1 << (u % 8);
        self.done += 1;
        self.dirty = true;
        Ok(())
    }

    /// Make every put so far durable: tiles first, then the bits that say they are there.
    pub fn flush(&mut self) -> Result<(), String> {
        if !self.dirty {
            return Ok(());
        }
        self.result.sync_data().map_err(io)?;
        write_synced(&self.dir.join("done.bits"), &self.bits)?;
        self.dirty = false;
        Ok(())
    }

    /// Read a unit's tile back (rows x cols i32, row-major).
    pub fn get(&mut self, u: usize) -> Result<Vec<i32>, String> {
        let (i, j) = self.job.tile(u);
        let (r, c) = self.job.tile_dims(i, j);
        let mut b = vec![0u8; r * c * 4];
        self.result.seek(SeekFrom::Start(u as u64 * self.job.slot_bytes())).map_err(io)?;
        self.result.read_exact(&mut b).map_err(io)?;
        Ok(b.chunks_exact(4).map(|x| i32::from_le_bytes(x.try_into().unwrap())).collect())
    }

    /// The whole product C (m x n, row-major), assembled from the tiles. For tests and small jobs.
    pub fn assemble(&mut self) -> Result<Vec<i32>, String> {
        let job = self.job.clone();
        let mut out = vec![0i32; job.m * job.n];
        for u in 0..job.units() {
            let (i, j) = job.tile(u);
            let (r, c) = job.tile_dims(i, j);
            let t = self.get(u)?;
            for row in 0..r {
                let dst = (i * job.tm + row) * job.n + j * job.tn;
                out[dst..dst + c].copy_from_slice(&t[row * c..(row + 1) * c]);
            }
        }
        Ok(out)
    }
}

/// Write a small file so that a crash leaves either the old or the new contents: temp file, sync, rename.
fn write_synced(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    {
        let mut f = File::create(&tmp).map_err(io)?;
        f.write_all(bytes).map_err(io)?;
        f.sync_all().map_err(io)?;
    }
    std::fs::rename(&tmp, path).map_err(io)
}
