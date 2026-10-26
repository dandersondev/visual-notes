import { describe, expect, it } from 'vitest';
import { Linter } from 'eslint';
import config from '../eslint.config.mjs';

const restrictions = config.find(entry => entry.rules?.['no-restricted-syntax'])!.rules!['no-restricted-syntax'];
const lint = (code: string) => new Linter().verify(code, [{ rules: { 'no-restricted-syntax': restrictions } }]);

describe('Obsidian review: CSS helper keys', () => {
  it.each(['setCssProps', 'setCssStyles'])('rejects quoted standard keys in %s even with a dynamic value', helper => {
    expect(lint(`el.${helper}({ 'text-align': alignment });`)).toHaveLength(1);
    expect(lint(`el.${helper}({ 'color': selectedColor });`)).toHaveLength(1);
  });

  it('allows dynamic camelCase styles, custom properties, and computed keys', () => {
    expect(lint('el.setCssStyles({ textAlign: alignment });')).toEqual([]);
    expect(lint("el.setCssProps({ '--card-color': selectedColor });")).toEqual([]);
    expect(lint('el.setCssProps({ [property]: value });')).toEqual([]);
  });
});
