// devnet: give the test token its Metaplex metadata (name, symbol, optional URI); the treasury pays and stays the
// update authority (mutable). Instructions built by hand: CreateMetadataAccountV3 (33) the first time, after that
// UpdateMetadataAccountV2 (15).
//   node devnet_token_name.mjs <treasury secret file> <mint> <name> <symbol> [uri]
import { Connection, Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import bs58 from "bs58"; import { readFileSync } from "node:fs";
const [, , keyf, mintS, name, symbol, uri = ""] = process.argv;
const c = new Connection("https://api.devnet.solana.com", "confirmed"), kp = Keypair.fromSecretKey(bs58.decode(readFileSync(keyf, "utf8").trim())), mint = new PublicKey(mintS);
const MP = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const [pda] = PublicKey.findProgramAddressSync([Buffer.from("metadata"), MP.toBuffer(), mint.toBuffer()], MP);
const str = (s) => { const b = Buffer.from(s, "utf8"), l = Buffer.alloc(4); l.writeUInt32LE(b.length); return Buffer.concat([l, b]); };
const data = Buffer.concat([Buffer.from([33]), str(name), str(symbol), str(uri), Buffer.from([0, 0]), Buffer.from([0]), Buffer.from([0]), Buffer.from([0]), Buffer.from([1]), Buffer.from([0])]);
const ix = new TransactionInstruction({ programId: MP, data, keys: [
  { pubkey: pda, isSigner: false, isWritable: true }, { pubkey: mint, isSigner: false, isWritable: false },
  { pubkey: kp.publicKey, isSigner: true, isWritable: false }, { pubkey: kp.publicKey, isSigner: true, isWritable: true },
  { pubkey: kp.publicKey, isSigner: true, isWritable: false }, { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false }] });
const dataV2 = Buffer.concat([str(name), str(symbol), str(uri), Buffer.from([0, 0]), Buffer.from([0]), Buffer.from([0]), Buffer.from([0])]);
const upd = new TransactionInstruction({ programId: MP, data: Buffer.concat([Buffer.from([15, 1]), dataV2, Buffer.from([0]), Buffer.from([0]), Buffer.from([0])]), keys: [
  { pubkey: pda, isSigner: false, isWritable: true }, { pubkey: kp.publicKey, isSigner: true, isWritable: false }] });
const exists = !!(await c.getAccountInfo(pda));
console.log(exists ? "update" : "create", "tx", await sendAndConfirmTransaction(c, new Transaction().add(exists ? upd : ix), [kp]));
