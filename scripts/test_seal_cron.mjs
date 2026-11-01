// docs/TESTING.md test 100: the monthly balance seal (cron "23 3 1 * *"). Fake DynamoDB, email and Solana: nothing real is
// touched.   node scripts/test_seal_cron.mjs website/worker.js
const W = (await import(new URL(process.argv[2], "file://" + process.cwd() + "/").href)).default;
const calls = { scan: 0, solana: 0, email: [], other: [] };
let nAccounts = 0;
globalThis.fetch = async (req, init) => {
  const url = typeof req === "string" ? req : req.url;
  const h = new Headers((init && init.headers) || (req.headers || {}));
  const target = h.get("x-amz-target") || "";
  if (target.includes("DynamoDB")) {
    if (target.endsWith(".Scan")) { calls.scan++; const Items = Array.from({ length: nAccounts }, (_, i) => ({ user_id: { S: "u" + String(i).padStart(6, "0") }, sk: { S: "BALANCE" }, available_uwu: { N: "5" } }));
      return new Response(JSON.stringify({ Items })); }
    calls.other.push(target); return new Response("{}");
  }
  if (/resend/i.test(url)) { const b = JSON.parse((init && init.body) || "{}"); calls.email.push(b.subject); return new Response(JSON.stringify({ id: "x" })); }
  if (/solana|rpc/i.test(url)) { calls.solana++; return new Response(JSON.stringify({ result: null })); }
  calls.other.push(url); return new Response("{}");
};
const ctx = { pending: [], waitUntil(p) { this.pending.push(p); } };
const base = { AWS_ACCESS_KEY_ID: "AKIAFAKE", AWS_SECRET_ACCESS_KEY: "x", AWS_REGION: "us-east-1", RESEND_API_KEY: "re_fake", ADMIN_EMAILS: "admin@example.com", DDB_PREFIX: "pctest-ai-" };
const ok = (n, c) => console.log((c ? "PASS " : "FAIL ") + n);
// 1. wallets off
await W.scheduled({ cron: "23 3 1 * *" }, { ...base }, ctx); await Promise.all(ctx.pending); ctx.pending = [];
ok("wallets not configured: skipped (no scan, no email, nothing on chain)", calls.scan === 0 && calls.email.length === 0 && calls.solana === 0);
// 2. too many accounts
nAccounts = 20001;
const walletEnv = { ...base, PCC_MINT: "So11111111111111111111111111111111111111112", SOLANA_RPC_URL: "https://rpc.solana.example", TREASURY_SECRET_KEY: "fake" };
await W.scheduled({ cron: "23 3 1 * *" }, walletEnv, ctx); await Promise.all(ctx.pending); ctx.pending = [];
ok("20,001 accounts: balances read, NOTHING sent on chain, admins emailed", calls.scan >= 1 && calls.solana === 0 && calls.email.length === 1 && /did not run/.test(calls.email[0]));
// 3. the other crons are not taken for the seal
const before = calls.scan;
await W.scheduled({ cron: "47 * * * *" }, { ...base }, ctx); await Promise.allSettled(ctx.pending); ctx.pending = [];
ok("the hourly 47 job does not seal", calls.scan === before && calls.solana === 0);
console.log("emails:", calls.email);
