import crypto from 'crypto';
import { config } from '../config';

const ALGORITHM = 'aes-256-gcm';

function getKey(): Buffer {
  const hex = config.credentialEncryptionKey;
  if (!hex || hex.length !== 64) {
    throw new Error('CREDENTIAL_ENCRYPTION_KEY must be a 64-char hex string (32 bytes)');
  }
  return Buffer.from(hex, 'hex');
}

export interface EncryptedData {
  ciphertext: string;
  iv: string;
  tag: string;
}

export function encrypt(plaintext: string): EncryptedData {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: encrypted.toString('hex'),
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
  };
}

export function decrypt(data: EncryptedData): string {
  const key = getKey();
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(data.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(data.tag, 'hex'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(data.ciphertext, 'hex')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}
