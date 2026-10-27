import { afterEach, describe, expect, it } from 'vitest';
import { TEXTS, languageFor, setLanguage, t, type TextKey } from '../src/ui/i18n';

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();

describe('interface language', () => {
  afterEach(() => setLanguage('ru'));

  it('picks Russian only for Russian browsers', () => {
    expect(languageFor('ru')).toBe('ru');
    expect(languageFor('ru-RU')).toBe('ru');
    expect(languageFor('en-US')).toBe('en');
    expect(languageFor('kk-KZ')).toBe('en');
    expect(languageFor('')).toBe('en');
  });

  it('has every text in both languages with the same placeholders', () => {
    for (const key of Object.keys(TEXTS.ru) as TextKey[]) {
      expect(TEXTS.en[key].trim(), key).not.toBe('');
      expect(placeholders(TEXTS.en[key]), key).toEqual(placeholders(TEXTS.ru[key]));
    }
  });

  it('fills placeholders in the current language', () => {
    setLanguage('en');
    expect(t('results.match', { n: 3 })).toBe('Match 3');
    setLanguage('ru');
    expect(t('results.match', { n: 3 })).toBe('Матч 3');
  });
});
