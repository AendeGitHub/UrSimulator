import { afterEach, describe, expect, it } from 'vitest';
import { TEXTS, setLanguage, startLanguage, t, type TextKey } from '../src/ui/i18n';

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();

describe('interface language', () => {
  afterEach(() => setLanguage('ru'));

  it('starts in English unless the player picked a language in the settings', () => {
    expect(startLanguage(undefined, undefined)).toBe('en');
    // Saved by an older version from the browser's language, never picked.
    expect(startLanguage('ru', undefined)).toBe('en');
    expect(startLanguage('kk', false)).toBe('en');
    expect(startLanguage('ru', true)).toBe('ru');
    expect(startLanguage('kk', true)).toBe('kk');
    expect(startLanguage('de', true)).toBe('en');
  });

  it('has every text in every language with the same placeholders', () => {
    for (const key of Object.keys(TEXTS.ru) as TextKey[]) {
      expect(TEXTS.en[key].trim(), key).not.toBe('');
      expect(TEXTS.kk[key].trim(), key).not.toBe('');
      expect(placeholders(TEXTS.en[key]), key).toEqual(placeholders(TEXTS.ru[key]));
      expect(placeholders(TEXTS.kk[key]), key).toEqual(placeholders(TEXTS.ru[key]));
    }
  });

  it('fills placeholders in the current language', () => {
    setLanguage('en');
    expect(t('results.rank', { rank: 3 })).toBe('High score · #3');
    setLanguage('ru');
    expect(t('results.rank', { rank: 3 })).toBe('Рекорд · место 3');
  });
});
