import fs from 'fs';
import path from 'path';
import { logger } from './utils/logger';

const CREDENTIALS_FILE = path.resolve(__dirname, '..', 'credentials.json');

export interface HLCredentials {
  privateKey: string;
  walletAddress: string;
  savedAt: number;
}

export function readCredentials(): HLCredentials | null {
  try {
    const raw = fs.readFileSync(CREDENTIALS_FILE, 'utf-8');
    return JSON.parse(raw) as HLCredentials;
  } catch {
    return null;
  }
}

export function writeCredentials(privateKey: string, walletAddress: string): void {
  const data: HLCredentials = { privateKey, walletAddress, savedAt: Date.now() };
  fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
  logger.info(`[Credentials] Saved credentials for wallet ${walletAddress}`);
}

export function credentialsExist(): boolean {
  return fs.existsSync(CREDENTIALS_FILE);
}
