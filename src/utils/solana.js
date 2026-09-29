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
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferInstruction,
  getAccount,
  TokenAccountNotFoundError,
  TokenInvalidAccountOwnerError
} from '@solana/spl-token';
import BigNumber from 'bignumber.js';
import bs58 from 'bs58';
import { getConnection, withRpcFailover } from './connection.js';
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
 * Public treasury wallet address (base58).
 * @returns {string}
 */
export function getTreasuryAddress() {
  return getTreasuryKeypair().publicKey.toBase58();
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
 * Build and sign (but do NOT send) a USDC transfer. The signature is known
 * before broadcast, so it is persisted first and a crash can never leave an
 * untracked in-flight transaction (F9).
 * @param {string} destinationAddress
 * @param {number} amountMinorUnits
 * @returns {Promise<{ signature: string, serialized: Buffer, blockhash: string, lastValidBlockHeight: number }>}
 */
export async function buildSignedUsdcTransfer(destinationAddress, amountMinorUnits) {
  const treasury = getTreasuryKeypair();
  const usdcMint = getUsdcMint();
  const destination = new PublicKey(destinationAddress);

  const treasuryAta = await getAssociatedTokenAddress(usdcMint, treasury.publicKey);
  const destinationAta = await getAssociatedTokenAddress(usdcMint, destination, true);

  const { blockhash, lastValidBlockHeight } = await withRpcFailover(
    (connection) => connection.getLatestBlockhash('finalized')
  );
  const tx = new Transaction({ feePayer: treasury.publicKey, blockhash, lastValidBlockHeight }).add(
    createAssociatedTokenAccountIdempotentInstruction(
      treasury.publicKey, destinationAta, destination, usdcMint
    ),
    createTransferInstruction(treasuryAta, destinationAta, treasury.publicKey, BigInt(amountMinorUnits))
  );
  tx.sign(treasury);
  const signature = bs58.encode(tx.signatures[0].signature);
  return { signature, serialized: tx.serialize(), blockhash, lastValidBlockHeight };
}

/**
 * Check whether a signature has landed on-chain. Used by the transfer-tick
 * worker to decide whether a 'sending' job can be finished, must be left
 * alone (still confirming, or blockhash not yet expired), or is safe to
 * rebuild (blockhash provably expired and never landed).
 * @param {string} signature
 * @returns {Promise<'finalized'|'pending'|'not_found'>}
 */
export async function checkSignatureLanded(signature) {
  return withRpcFailover(async (connection) => {
    const { value } = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
    const s = value[0];
    if (!s) return 'not_found';
    if (s.err) return 'not_found';                    // landed-but-failed: safe to rebuild
    return s.confirmationStatus === 'finalized' ? 'finalized' : 'pending';
  });
}

/**
 * Broadcast a pre-signed, pre-recorded transaction and wait for finalized
 * confirmation. Thin wrapper — the signature has already been persisted by
 * the caller (via recordSignature) before this is invoked.
 * @param {Buffer} serialized
 * @param {string} signature
 * @param {string} blockhash
 * @param {number} lastValidBlockHeight
 * @returns {Promise<void>}
 */
export async function sendSerializedTransaction(serialized, signature, blockhash, lastValidBlockHeight) {
  await withRpcFailover(async (connection) => {
    await connection.sendRawTransaction(serialized, { skipPreflight: false });
    const { value } = await connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight }, 'finalized'
    );
    if (value.err) {
      throw createOnChainError(`Transaction ${signature} confirmed with error: ${JSON.stringify(value.err)}`);
    }
  });
}

/**
 * Current Solana block height — used by the transfer-tick worker to decide
 * whether a 'sending' job's blockhash has provably expired. 'finalized'
 * explicitly (rather than the connection's default commitment) so the
 * rebuild decision is made against the same commitment level the
 * lastValidBlockHeight was computed under.
 * @returns {Promise<number>}
 */
export async function getCurrentBlockHeight() {
  return withRpcFailover((connection) => connection.getBlockHeight('finalized'));
}

/**
 * Verify an inbound USDC transfer to the treasury.
 * Checks: tx is finalized, the source wallet matches, the destination is the
 * treasury USDC ATA, and the amount equals expectedAmount.
 *
 * @param {string} txSignature - Solana transaction signature (base58)
 * @param {string} expectedFromWallet - Sender wallet base58 (the user)
 * @param {number} expectedAmount - Expected USDC amount in minor units
 * @returns {Promise<{ ok: true } | { ok: false, reason: string }>}
 */
export async function verifyIncomingUsdcTransfer(txSignature, expectedFromWallet, expectedAmount) {
  try {
    const treasury = getTreasuryKeypair();
    const usdcMint = getUsdcMint();

    const treasuryAta = (await getAssociatedTokenAddress(usdcMint, treasury.publicKey)).toBase58();
    const senderAta = (await getAssociatedTokenAddress(usdcMint, new PublicKey(expectedFromWallet))).toBase58();

    const tx = await withRpcFailover((connection) => connection.getParsedTransaction(txSignature, {
      maxSupportedTransactionVersion: 0,
      commitment: 'finalized'
    }));
    if (!tx) {
      return { ok: false, reason: 'Transaction not found or not yet finalized' };
    }
    if (tx.meta?.err) {
      return { ok: false, reason: `On-chain error: ${JSON.stringify(tx.meta.err)}` };
    }

    // Walk all instructions (top-level + inner) for an SPL transfer that
    // moves the expected amount from senderAta to treasuryAta.
    const allIxs = [
      ...(tx.transaction.message.instructions || []),
      ...((tx.meta?.innerInstructions || []).flatMap(g => g.instructions))
    ];

    for (const ix of allIxs) {
      //@ts-ignore — parsed instructions have these fields at runtime
      const parsed = ix.parsed;
      if (!parsed || parsed.type !== 'transfer' && parsed.type !== 'transferChecked') continue;

      const info = parsed.info || {};
      const source = info.source;
      const destination = info.destination;
      // `transfer` carries amount as string; `transferChecked` carries tokenAmount.amount
      const amountStr = info.amount ?? info.tokenAmount?.amount;
      if (!amountStr || !source || !destination) continue;

      if (source === senderAta && destination === treasuryAta && Number(amountStr) === expectedAmount) {
        return { ok: true };
      }
    }

    return { ok: false, reason: 'No matching USDC transfer instruction found in this transaction' };
  } catch (error) {
    return { ok: false, reason: `Verification failed: ${error.message}` };
  }
}

/**
 * Treasury ATA balance in USDC minor units. Used as a payout precondition
 * and by the reconciliation job.
 *
 * Only `TokenAccountNotFoundError`/`TokenInvalidAccountOwnerError` — the
 * ATA genuinely doesn't exist yet — resolve to `0n`. Any other error
 * (network/timeout/5xx) rethrows: swallowing it into `0n` used to make
 * `proveBalance` (src/routes/internal/reconcile-tick.js) fire a false
 * RECONCILIATION_MISMATCH alert on any RPC blip, and made deposit
 * initiation refuse quotes with a misleading "insufficient treasury
 * balance" reason instead of the real transport error. Letting the error
 * propagate also lets `withRpcFailover` retry it against the fallback
 * instead of masking it before the wrapper ever sees a failure.
 * @returns {Promise<bigint>}
 */
export async function getTreasuryUsdcBalanceMinor() {
  const treasury = getTreasuryKeypair();
  const usdcMint = getUsdcMint();
  const ata = await getAssociatedTokenAddress(usdcMint, treasury.publicKey);
  return withRpcFailover(async (connection) => {
    try {
      const account = await getAccount(connection, ata);
      return account.amount; // bigint, already minor units
    } catch (err) {
      if (err instanceof TokenAccountNotFoundError || err instanceof TokenInvalidAccountOwnerError) {
        return 0n;
      }
      throw err;
    }
  });
}

/**
 * Get USDC balance for a wallet address
 *
 * Same account-not-found-vs-transport-failure distinction as
 * `getTreasuryUsdcBalanceMinor`: only a genuinely nonexistent ATA
 * (`TokenAccountNotFoundError`/`TokenInvalidAccountOwnerError`) resolves
 * to a zero balance. Any other error propagates out of `withRpcFailover`
 * (after a fallback retry, if configured) and surfaces as a thrown
 * `OnChainError` — a caller reading a real `0.000000` must be able to
 * trust it, not have it mean "the RPC call failed."
 * @param {string} walletAddress - Solana wallet address (base58)
 * @returns {Promise<{ balance: string, rawBalance: string }>}
 */
export async function getUsdcBalance(walletAddress) {
  try {
    const usdcMint = getUsdcMint();
    const walletPubkey = new PublicKey(walletAddress);

    const ata = await getAssociatedTokenAddress(usdcMint, walletPubkey, true);

    const account = await withRpcFailover(async (connection) => {
      try {
        return await getAccount(connection, ata);
      } catch (err) {
        if (err instanceof TokenAccountNotFoundError || err instanceof TokenInvalidAccountOwnerError) {
          return null;
        }
        throw err;
      }
    });

    if (!account) {
      return { balance: '0.000000', rawBalance: '0' };
    }
    const rawBalance = account.amount.toString();
    const balance = new BigNumber(rawBalance)
      .dividedBy(new BigNumber(10).pow(6))
      .toFixed(6);
    return { balance, rawBalance };
  } catch (error) {
    throw createOnChainError(`Failed to fetch balance: ${error.message}`);
  }
}
