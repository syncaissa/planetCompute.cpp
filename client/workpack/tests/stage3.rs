//! Stage 3 additions (docs/SHERPAHUB.md section 10): packs computed on several threads give the same RESULT as on
//! one; the hub never makes a RESULT larger than the network's message limit (the site's broker: 1 MiB).

use workpack::device::{Device, Reply};
use workpack::hub::{Config, Hub, Out};
use workpack::store::JobSpec;
use workpack::wire::{decode, encode, Msg, ResultMsg};

fn dir(name: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("wp-stage3-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    d
}

/// Drive a hub and one device to the end; returns the largest message the device sent and the largest pack (units).
fn run(job: JobSpec, cfg: Config, threads: usize) -> (usize, usize, Vec<ResultMsg>) {
    let d = dir(&format!("{}-{threads}", job.id));
    let mut hub = Hub::create(&d, job, cfg).unwrap();
    let mut dev = Device::new(64 << 20);
    let (mut biggest, mut most, mut results) = (0usize, 0usize, Vec::new());
    let mut now = 0u64;
    let mut q: Vec<Out> = hub.on_hello(now, 1, 64 << 20);
    let mut done = false;
    for _ in 0..100_000 {
        if q.is_empty() {
            now += 50;
            q = hub.tick(now);
        }
        let outs = std::mem::take(&mut q);
        for o in outs {
            match o {
                Out::Send(1, bytes) => {
                    if let Ok(Msg::Pack(p)) = decode(&bytes) {
                        most = most.max(p.units.len());
                    }
                    let reply = match dev.handle_on(&bytes, threads) {
                        Reply::Result(r) => {
                            results.push(r.clone());
                            Some(encode(&Msg::Result(r)))
                        }
                        Reply::Need(n) => Some(encode(&Msg::Need(n))),
                        Reply::None => None,
                    };
                    if let Some(b) = reply {
                        biggest = biggest.max(b.len());
                        now += 5;
                        q.extend(hub.on_message(now, 1, &b));
                    }
                }
                Out::Done => done = true,
                Out::Corrupt => panic!("final check failed"),
                _ => {}
            }
        }
        if done {
            break;
        }
    }
    assert!(done, "job did not finish");
    let _ = std::fs::remove_dir_all(&d);
    (biggest, most, results)
}

#[test]
fn threads_give_identical_results() {
    let job = JobSpec { id: 31, m: 256, k: 300, n: 192, tm: 32, tn: 32, seed_a: 5, seed_b: 9 };
    let cfg = Config { t_unit_guess_ms: 1.0, t_o_guess_ms: 1000.0, seed: 77, ..Config::default() };
    let (_, most, one) = run(job.clone(), cfg.clone(), 1);
    let (_, _, four) = run(job, cfg, 4);
    assert!(most > 1, "packs had several units ({most})");
    assert_eq!(one, four, "4 threads must give byte-identical RESULTs, in the same order");
}

#[test]
fn packs_fit_the_message_limit() {
    // tiles 64 x 64 -> 16 KiB per unit; a 64 KiB limit allows 3 units per RESULT at most
    let job = JobSpec { id: 32, m: 512, k: 64, n: 512, tm: 64, tn: 64, seed_a: 1, seed_b: 2 };
    let cfg = Config { t_unit_guess_ms: 0.1, t_o_guess_ms: 5000.0, max_message: 64 << 10, seed: 3, ..Config::default() };
    let (biggest, most, _) = run(job, cfg, 2);
    println!("largest RESULT {biggest} bytes, largest pack {most} units");
    assert!(biggest <= 64 << 10, "RESULT of {biggest} bytes over the 64 KiB limit");
    assert!(most >= 2 && most <= 3, "pack size {most}");
}
