import passport from 'passport';
import { Strategy as GoogleStrategy, Profile } from 'passport-google-oauth20';
import { config } from '../config';
import { supabaseServiceClient } from '../db/supabase';
import { findOrCreateUser } from './userStore';
import { logger } from '../utils/logger';

const ALLOWED_EMAILS = config.allowedEmails
  ? new Set(config.allowedEmails.split(',').map(e => e.trim().toLowerCase()))
  : null;

export function configurePassport(): void {
  if (!config.googleClientId || !config.googleClientSecret) {
    logger.warn('[Auth] GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET not set — Google auth disabled');
    return;
  }

  logger.info(`[Auth] Google OAuth callback URL: ${config.googleCallbackUrl}`);

  passport.use(
    new GoogleStrategy(
      {
        clientID: config.googleClientId,
        clientSecret: config.googleClientSecret,
        callbackURL: config.googleCallbackUrl,
      },
      async (_accessToken, _refreshToken, profile: Profile, done) => {
        try {
          const email = profile.emails?.[0]?.value ?? '';
          if (!email) return done(new Error('No email from Google profile'));

          if (ALLOWED_EMAILS && !ALLOWED_EMAILS.has(email.toLowerCase())) {
            logger.warn(`[Auth] Login attempt from non-allowed email: ${email}`);
            return done(null, false);
          }

          if (!supabaseServiceClient) {
            return done(new Error('Supabase not configured'));
          }

          const user = await findOrCreateUser(
            supabaseServiceClient,
            profile.id,
            email,
            profile.displayName ?? null
          );

          if (!user) return done(new Error('Failed to find or create user'));

          logger.info(`[Auth] Login: ${email} (id=${user.id})`);
          return done(null, user);
        } catch (err) {
          return done(err instanceof Error ? err : new Error(String(err)));
        }
      }
    )
  );

  passport.serializeUser((user: Express.User, done) => {
    const u = user as { id: string };
    done(null, u.id);
  });

  passport.deserializeUser(async (id: string, done) => {
    // Minimal deserialization — just pass the id, full user loaded on demand
    done(null, { id } as Express.User);
  });
}
