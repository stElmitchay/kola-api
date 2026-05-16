//@ts-check

import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
  getAccount,
  TOKEN_PROGRAM_ID
} from '@solana/spl-token';
import BigNumber from 'bignumber.js';
import bs58 from 'bs58';
import { getConnection } from './connection.js';
import { createOnChainError } from './errors.js';

/**
 * Get the treasury keypair from environment
 * Supports both base58 string and JSON array formats
 * @returns {Keypair}
 */
function getTreasuryKeypair() {
  const raw = process.env.TREASURY_SECRET_KEY;
  if (raw.startsWith('[')) {
    //@ts-ignore
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
  }
  return Keypair.fromSecretKey(bs58.decode(raw));
}

/**
 * Get the USDC mint public key
 * @returns {PublicKey}
 */
function getUsdcMint() {
  return new PublicKey(process.env.USDC_MINT);
}

/**
 * Derive a deterministic wallet address from a phone number
 * Uses the treasury public key as the base and phone number as the seed
 * @param {string} phoneNumber - Normalized phone number (e.g., +23276123456)
 * @returns {Promise<{ address: string, publicKey: PublicKey }>}
 */
export async function deriveWalletFromPhone(phoneNumber) {
  const treasury = getTreasuryKeypair();
  const seed = phoneNumber.replace('+', '');
  const derivedPubkey = await PublicKey.createWithSeed(
    treasury.publicKey,
    seed,
    SystemProgram.programId
  );
  return {
    address: derivedPubkey.toBase58(),
    publicKey: derivedPubkey
  };
}

/**
 * Ensure a USDC associated token account exists for the given wallet
 * Creates it if it doesn't exist (funded by treasury)
 * @param {PublicKey} walletPublicKey
 * @returns {Promise<PublicKey>} The token account address
 */
export async function ensureTokenAccount(walletPublicKey) {
  const connection = getConnection();
  const treasury = getTreasuryKeypair();
  const usdcMint = getUsdcMint();

  const ata = await getAssociatedTokenAddress(usdcMint, walletPublicKey, true);

  try {
    await getAccount(connection, ata);
    return ata;
  } catch {
    const transaction = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        treasury.publicKey,
        ata,
        walletPublicKey,
        usdcMint
      )
    );

    await sendAndConfirmTransaction(connection, transaction, [treasury]);
    return ata;
  }
}

/**
 * Transfer USDC from treasury to a destination wallet
 * @param {string} destinationAddress - Solana wallet address (base58)
 * @param {number} amountMinorUnits - USDC amount in minor units (1 USDC = 1_000_000)
 * @returns {Promise<string>} Transaction signature
 */
export async function transferUsdc(destinationAddress, amountMinorUnits) {
  try {
    const connection = getConnection();
    const treasury = getTreasuryKeypair();
    const usdcMint = getUsdcMint();
    const destinationPubkey = new PublicKey(destinationAddress);

    const treasuryAta = await getAssociatedTokenAddress(
      usdcMint,
      treasury.publicKey
    );

    const destinationAta = await ensureTokenAccount(destinationPubkey);

    const transaction = new Transaction().add(
      createTransferInstruction(
        treasuryAta,
        destinationAta,
        treasury.publicKey,
        BigInt(amountMinorUnits)
      )
    );

    const signature = await sendAndConfirmTransaction(
      connection,
      transaction,
      [treasury]
    );

    return signature;
  } catch (error) {
    throw createOnChainError(`USDC transfer failed: ${error.message}`);
  }
}

/**
 * Get USDC balance for a wallet address
 * @param {string} walletAddress - Solana wallet address (base58)
 * @returns {Promise<{ balance: string, rawBalance: string }>}
 */
export async function getUsdcBalance(walletAddress) {
  try {
    const connection = getConnection();
    const usdcMint = getUsdcMint();
    const walletPubkey = new PublicKey(walletAddress);

    const ata = await getAssociatedTokenAddress(usdcMint, walletPubkey, true);

    try {
      const account = await getAccount(connection, ata);
      const rawBalance = account.amount.toString();
      const balance = new BigNumber(rawBalance)
        .dividedBy(new BigNumber(10).pow(6))
        .toFixed(6);
      return { balance, rawBalance };
    } catch {
      return { balance: '0.000000', rawBalance: '0' };
    }
  } catch (error) {
    throw createOnChainError(`Failed to fetch balance: ${error.message}`);
  }
}
