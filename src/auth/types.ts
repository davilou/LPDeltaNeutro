export interface AuthUser {
  id: string;
  googleId: string;
  email: string;
  displayName: string | null;
  hlPrivateKeyEnc: string | null;
  hlPrivateKeyIv: string | null;
  hlPrivateKeyTag: string | null;
  hlWalletAddress: string | null;
}

declare module 'express-session' {
  interface SessionData {
    userId: string;
    userEmail: string;
  }
}
