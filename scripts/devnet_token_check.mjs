import { Connection, PublicKey } from "@solana/web3.js";
const c = new Connection("https://api.devnet.solana.com", "confirmed"), mint = new PublicKey(process.argv[2]);
const acc = await c.getParsedAccountInfo(mint);
console.log("owner program:", acc.value.owner.toBase58(), "extensions:", JSON.stringify(acc.value.data.parsed.info.extensions || null));
const MP = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const [pda] = PublicKey.findProgramAddressSync([Buffer.from("metadata"), MP.toBuffer(), mint.toBuffer()], MP);
const m = await c.getAccountInfo(pda);
if (!m) console.log("Metaplex metadata: NONE");
else { const d = m.data; let o = 65; const rd = () => { const n = d.readUInt32LE(o); o += 4; const s = d.slice(o, o + n).toString().replace(/\0/g, ""); o += n; return s; };
  console.log("Metaplex metadata: name=" + JSON.stringify(rd()), "symbol=" + JSON.stringify(rd()), "uri=" + JSON.stringify(rd())); }
