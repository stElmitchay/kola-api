//@ts-check

// Prints the treasury wallet and its USDC associated token account (ATA).
// The ATA is the address you give Helius to watch for incoming USDC deposits.
//
// Run with: node --env-file=.env scripts/print-treasury-ata.js

import { Keypair, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddress } from '@solana/spl-token';
import bs58 from 'bs58';

const raw = process.env.TREASURY_SECRET_KEY;
const usdcMint = process.env.USDC_MINT;

if (!raw) {
  console.error('TREASURY_SECRET_KEY is not set');
  process.exit(1);
}
if (!usdcMint) {
  console.error('USDC_MINT is not set');
  process.exit(1);
}

const kp = raw.startsWith('[')
  ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)))
  : Keypair.fromSecretKey(bs58.decode(raw));

const ata = await getAssociatedTokenAddress(new PublicKey(usdcMint), kp.publicKey);

console.log('Treasury wallet:     ', kp.publicKey.toBase58());
console.log('USDC mint:           ', usdcMint);
console.log('Treasury USDC ATA:   ', ata.toBase58());
console.log('');
console.log('→ Paste the USDC ATA into Helius "Account Addresses".');
