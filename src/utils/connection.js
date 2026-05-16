//@ts-check

import { Connection } from '@solana/web3.js';

/** @type {Connection | null} */
let connection = null;

/**
 * Get or create a Solana RPC connection
 * @returns {Connection}
 */
export function getConnection() {
  if (!connection) {
    connection = new Connection(process.env.HELIUS_URL, 'confirmed');
  }
  return connection;
}
