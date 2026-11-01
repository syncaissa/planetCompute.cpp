// devnet only: a treasury keypair, free devnet SOL for fees, a test token (9 decimals, the treasury the only issuer),
// 1,000,000 test tokens in the treasury. The secret is written to a 600 file, never printed.
import { Connection, Keypair, LAMPORTS_PER_SOL, clusterApiUrl } from "@solana/web3.js";
import { createMint, getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import bs58 from "bs58"; import { writeFileSync, existsSync, readFileSync } from "node:fs";
const KEYF = process.argv[2];
const conn = new Connection(clusterApiUrl("devnet"), "confirmed");
let kp;
if (existsSync(KEYF)) kp = Keypair.fromSecretKey(bs58.decode(readFileSync(KEYF, "utf8").trim()));
else { kp = Keypair.generate(); writeFileSync(KEYF, bs58.encode(kp.secretKey), { mode: 0o600 }); }
console.log("treasury", kp.publicKey.toBase58());
let bal = await conn.getBalance(kp.publicKey);
for (const amt of [2, 1, 1]) {
  if (bal >= 0.5 * LAMPORTS_PER_SOL) break;
  try { const sig = await conn.requestAirdrop(kp.publicKey, amt * LAMPORTS_PER_SOL); await conn.confirmTransaction(sig, "confirmed"); }
  catch (e) { console.log("airdrop", amt, "SOL failed:", String(e.message).slice(0, 120)); await new Promise((r) => setTimeout(r, 8000)); }
  bal = await conn.getBalance(kp.publicKey);
}
console.log("treasury SOL (devnet, for fees):", bal / LAMPORTS_PER_SOL);
if (bal < 0.05 * LAMPORTS_PER_SOL) { console.log("NOT ENOUGH devnet SOL: use https://faucet.solana.com for", kp.publicKey.toBase58()); process.exit(3); }
const mint = await createMint(conn, kp, kp.publicKey, null, 9);
const ata = await getOrCreateAssociatedTokenAccount(conn, kp, mint, kp.publicKey);
const sig = await mintTo(conn, kp, mint, ata.address, kp, 1_000_000n * 10n ** 9n);
console.log(JSON.stringify({ cluster: "devnet", mint: mint.toBase58(), treasury: kp.publicKey.toBase58(), treasury_token_account: ata.address.toBase58(), mint_tx: sig }));
