import { describe, expect, it } from 'vitest';
import { bioProblem, displayNameProblem, normalizeUsername, passwordChecks, usernameFormatProblem } from '../src/index.ts';

describe('profile rules', () => {
  it('normalizes and validates usernames', () => {
    expect(normalizeUsername('  Road_Runner7 ')).toBe('road_runner7');
    expect(usernameFormatProblem('ab')).toBe('too_short');
    expect(usernameFormatProblem('a'.repeat(21))).toBe('too_long');
    expect(usernameFormatProblem('no-dashes')).toBe('characters');
    expect(usernameFormatProblem('émile')).toBe('characters');
    expect(usernameFormatProblem('ok_name_1')).toBeNull();
  });

  it('validates display names as plain text', () => {
    expect(displayNameProblem('Zoë Ångström')).toBeNull();
    expect(displayNameProblem('Z')).toBe('length');
    expect(displayNameProblem('x'.repeat(31))).toBe('length');
    expect(displayNameProblem('Bell\u0007')).toBe('characters');
    expect(displayNameProblem('‮evil')).toBe('characters');
  });

  it('validates bios', () => {
    expect(bioProblem('Line one\nLine two')).toBeNull();
    expect(bioProblem('x'.repeat(161))).toBe('length');
    expect(bioProblem('tab\there')).toBe('characters');
  });

  it('mirrors the password policy', () => {
    expect(passwordChecks('short1')).toEqual({ length: false, letter: true, digit: true });
    expect(passwordChecks('lettersonly')).toEqual({ length: true, letter: true, digit: false });
    expect(passwordChecks('Goodpass123')).toEqual({ length: true, letter: true, digit: true });
  });
});
