import type { Notice, ResultCode } from '../auth/manager.ts';

/** Player-facing text for every safe result code. Raw server errors are never shown. */
export const RESULT_TEXT: Record<ResultCode, string> = {
  invalid_credentials: 'That email and password don’t match an account. Check them and try again.',
  email_not_confirmed: 'Confirm your email first. We can send you a new code.',
  weak_password: 'Choose a stronger password: at least 8 characters with letters and numbers.',
  same_password: 'Choose a password you haven’t used for this account.',
  rate_limited: 'Too many tries. Please wait a minute and try again.',
  code_invalid: 'That code is wrong or has expired. Check the latest email, or send a new code.',
  email_invalid: 'Enter a valid email address.',
  signup_disabled: 'New accounts can’t be created right now.',
  network: 'Can’t reach Guildhood. Check your Wi-Fi and try again.',
  session_expired: 'Your session has ended. Please sign in again.',
  invalid_password: 'That password isn’t right.',
  too_many_attempts: 'Too many attempts. Wait 15 minutes and try again.',
  deletion_failed: 'Your account was not deleted because something went wrong. Please try again.',
  unexpected: 'Something went wrong. Please try again.',
};

export function noticeText(n: Notice): string {
  switch (n.kind) {
    case 'link_expired':
      return n.flow === 'recovery'
        ? 'That password reset link has expired or was already used. Request a new one below.'
        : 'That confirmation link has expired or was already used. Sign in, and we’ll send a new code if your email still needs confirming.';
    case 'link_invalid':
      return 'That link isn’t a valid Guildhood link. Open the newest email from Guildhood, or enter the 6-digit code instead.';
    case 'link_network':
      return 'We couldn’t check that link because Guildhood was unreachable. Check your connection and open the link again.';
    case 'signed_out':
      return 'You’ve signed out.';
    case 'account_deleted':
      return 'Your account has been deleted.';
    case 'password_updated':
      return 'Your password has been changed.';
    case 'email_confirmed':
      return 'Your email is confirmed.';
  }
}

/** a•••@example.com */
export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at < 1) return email;
  return `${email[0]}•••${email.slice(at)}`;
}

export const RESTRICTION_REASONS: Record<string, string> = {
  harassment: 'harassing other players',
  cheating: 'cheating',
  spam: 'spam',
  inappropriate_profile: 'an inappropriate name or profile',
  other: 'breaking the Guildhood rules',
};
