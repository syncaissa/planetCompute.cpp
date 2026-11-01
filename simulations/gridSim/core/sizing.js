// Pack sizing by the square-root law (design notes, Section 3.3).
//   tau = clamp( sqrt(T_o * T_ideal / kappa), 9 * T_o, tauMax ),  T_ideal = W t / P
// W units of t reference-seconds each, P = devices this job can expect to use at once.
export function packUnits({ units, unitTime, share, overhead = 3, kappa = 1.5, tauMax = 300 }) {
  const P = Math.max(1, Math.min(share, units));
  const ideal = units * unitTime / P;
  const tau = Math.min(tauMax, Math.max(9 * overhead, Math.sqrt(overhead * ideal / kappa)));
  return Math.max(1, Math.floor(tau / unitTime));
}

// Speed of a device class on a lane, relative to the lane's reference (minimum) class.
export const classSpeed = (cls, minClass) => 1 + 0.5 * (cls - minClass);

// Spreads device ids over shards without a lookup (Knuth multiplicative hash).
export const hash32 = (i) => Math.imul(i, 2654435761) >>> 0;
export function hashStr(s) { let h = 2166136261; for (let k = 0; k < s.length; k++) h = Math.imul(h ^ s.charCodeAt(k), 16777619); return h >>> 0; }

// Lane directories are sharded too: "d:<lane>:<k>", each serving about cfg.shardsPerDir lane shards.
export const dirOfShard = (cfg, lane, k) => `d:${lane}:${k % cfg.initialPlan.dirs[lane]}`;
export const dirOfJob = (cfg, lane, job) => `d:${lane}:${hashStr(job) % cfg.initialPlan.dirs[lane]}`;
