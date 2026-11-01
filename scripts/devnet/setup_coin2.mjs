// devnet only: a second test coin for the share-set tests, like PlanetComp: Token-2022, 6 decimals, held by a second
// wallet ("sender 2", its own key in a 600 file, never printed). The devnet treasury pays the fees and is the issuer.
import { Connection, Keypair, clusterApiUrl } from "@solana/web3.js";
import { createMint, getOrCreateAssociatedTokenAccount, mintTo, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import bs58 from "bs58"; import { writeFileSync, existsSync, readFileSync } from "node:fs";
const [TREASF, KEYF] = process.argv.slice(2);
const conn = new Connection(clusterApiUrl("devnet"), "confirmed");
const tr = Keypair.fromSecretKey(bs58.decode(readFileSync(TREASF, "utf8").trim()));
let kp; if (existsSync(KEYF)) kp = Keypair.fromSecretKey(bs58.decode(readFileSync(KEYF, "utf8").trim())); else { kp = Keypair.generate(); writeFileSync(KEYF, bs58.encode(kp.secretKey), { mode: 0o600 }); }
const mint = await createMint(conn, tr, tr.publicKey, null, 6, undefined, undefined, TOKEN_2022_PROGRAM_ID);
const ata = await getOrCreateAssociatedTokenAccount(conn, tr, mint, kp.publicKey, false, undefined, undefined, TOKEN_2022_PROGRAM_ID);
const sig = await mintTo(conn, tr, mint, ata.address, tr, 1_000_000n * 10n ** 6n, [], undefined, TOKEN_2022_PROGRAM_ID);
console.log(JSON.stringify({ cluster: "devnet", coin2_mint: mint.toBase58(), program: "token-2022", decimals: 6, sender2: kp.publicKey.toBase58(), sender2_token_account: ata.address.toBase58(), mint_tx: sig }));
