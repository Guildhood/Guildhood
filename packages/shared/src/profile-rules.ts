/**
 * Player-identity rules shared by the client (instant feedback) and tests. The database enforces
 * the same rules and is the authority (supabase/migrations/*_phase2_accounts_profiles.sql);
 * tests/db/rules-parity.test.ts checks that both agree. Reserved names live only in the
 * database (private.reserved_usernames) and are checked through check_username().
 */

export const USERNAME_MIN = 3;
export const USERNAME_MAX = 20;
export const DISPLAY_NAME_MIN = 2;
export const DISPLAY_NAME_MAX = 30;
export const BIO_MAX = 160;
export const PASSWORD_MIN = 8;

/** Terms of service / privacy policy version a new account accepts (see public/terms.html). */
export const TERMS_VERSION = '2026-11-24';

export type ProfileVisibility = 'public' | 'friends' | 'private';
export const PROFILE_VISIBILITIES: readonly ProfileVisibility[] = ['public', 'friends', 'private'];

export function normalizeUsername(input: string): string {
  return input.trim().toLowerCase();
}

/** Format only (length and characters). Availability and reserved names are server checks. */
export function usernameFormatProblem(normalized: string): 'too_short' | 'too_long' | 'characters' | null {
  if (normalized.length < USERNAME_MIN) return 'too_short';
  if (normalized.length > USERNAME_MAX) return 'too_long';
  if (!/^[a-z0-9_]+$/.test(normalized)) return 'characters';
  return null;
}

// Control characters, and invisible or direction-changing characters used to impersonate others.
const CONTROL = /[\u0001-\u001f\u007f-\u009f]/;
const CONTROL_EXCEPT_NEWLINE = /[\u0001-\u0009\u000b-\u001f\u007f-\u009f]/;
const INVISIBLE = /[​-‏‪-‮⁠-⁩﻿]/;

/** Validates an already-trimmed display name. */
export function displayNameProblem(name: string): 'length' | 'characters' | null {
  const length = [...name].length;
  if (length < DISPLAY_NAME_MIN || length > DISPLAY_NAME_MAX) return 'length';
  if (CONTROL.test(name) || INVISIBLE.test(name)) return 'characters';
  return null;
}

/** Validates an already-trimmed bio ('' means no bio). */
export function bioProblem(bio: string): 'length' | 'characters' | null {
  if ([...bio].length > BIO_MAX) return 'length';
  if (CONTROL_EXCEPT_NEWLINE.test(bio) || INVISIBLE.test(bio)) return 'characters';
  return null;
}

/** Mirrors the Supabase Auth password policy (minimum length, letters and digits). */
export function passwordChecks(password: string): { length: boolean; letter: boolean; digit: boolean } {
  return { length: password.length >= PASSWORD_MIN, letter: /[a-zA-Z]/.test(password), digit: /[0-9]/.test(password) };
}

export interface AvatarDef {
  id: string;
  name: string;
  /** Background and emblem colors for the client-drawn badge. */
  bg: string;
  fg: string;
}

/** Preset avatars. Ids must match public.avatar_catalog (tested). Artwork: apps/client/src/ui/avatars.ts. */
export const AVATARS: readonly AvatarDef[] = [
  { id: 'leaf_moss', name: 'Moss Leaf', bg: '#3e8e5e', fg: '#e9f5e1' },
  { id: 'wheel_copper', name: 'Copper Wheel', bg: '#c9692f', fg: '#fbe8d8' },
  { id: 'lantern_amber', name: 'Amber Lantern', bg: '#e0a232', fg: '#3a2a10' },
  { id: 'key_brass', name: 'Brass Key', bg: '#b08a3e', fg: '#fff4d6' },
  { id: 'star_sky', name: 'Sky Star', bg: '#3f8fe0', fg: '#f3f9ff' },
  { id: 'bolt_sun', name: 'Sun Bolt', bg: '#f2c230', fg: '#4a3600' },
  { id: 'moon_plum', name: 'Plum Moon', bg: '#8e5bd6', fg: '#f4ecff' },
  { id: 'house_brick', name: 'Brick House', bg: '#b5523b', fg: '#fdeee6' },
  { id: 'flag_cherry', name: 'Cherry Flag', bg: '#d94452', fg: '#fff0f1' },
  { id: 'gear_slate', name: 'Slate Gear', bg: '#4a5563', fg: '#e8edf2' },
  { id: 'wave_mint', name: 'Mint Wave', bg: '#3fbf8f', fg: '#0f3a2b' },
  { id: 'crown_chalk', name: 'Chalk Crown', bg: '#e9e4da', fg: '#5a4a2e' },
];
