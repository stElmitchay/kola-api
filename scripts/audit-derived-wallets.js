//@ts-check
// Lists every derived wallet and its USDC ATA balance. Any non-zero balance
// is customer money currently locked in an unspendable account (F4).
//
// Run with: node --env-file=.env scripts/audit-derived-wallets.js
import { PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddress, getAccount } from '@solana/spl-token';
import { createClient } from '@supabase/supabase-js';
import { Connection } from '@solana/web3.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const connection = new Connection(process.env.HELIUS_URL, 'finalized');
const usdcMint = new PublicKey(process.env.USDC_MINT);

const { data: wallets, error } = await supabase.from('derived_wallets').select('*');
if (error) { console.error(error.message); process.exit(1); }

let totalLocked = 0n;
for (const w of wallets) {
  const owner = new PublicKey(w.wallet_address);
  const ata = await getAssociatedTokenAddress(usdcMint, owner, true);
  let amount = 0n;
  try { amount = (await getAccount(connection, ata)).amount; } catch { /* no ATA */ }
  totalLocked += amount;
  console.log(`${w.phone_number.slice(0, 6)}…  ${w.wallet_address}  ${amount} minor units`);
}
console.log(`\nTOTAL LOCKED: ${totalLocked} minor units (${Number(totalLocked) / 1e6} USDC)`);
