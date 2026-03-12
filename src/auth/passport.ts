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
            logger.warn({ message: 'auth.denied', user: email, reason: 'not_in_allowed_list' });
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

          logger.info({ message: 'auth.login', user: email });
          return done(null, user);
        } catch (err) {
          return done(err instanceof Error ? err : new Error(String(err)));
        }
      }
    )
  );

  passport.serializeUser((user: Express.User, done) => {
    const u = user as { id: string; email?: string };
    done(null, JSON.stringify({ id: u.id, email: u.email }));
  });

  passport.deserializeUser(async (serialized: string, done) => {
    try {
      const { id, email } = JSON.parse(serialized);
      done(null, { id, email } as Express.User);
    } catch {
      done(null, { id: serialized } as Express.User);
    }
  });
}
