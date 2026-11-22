import { describe, expect, test } from 'vitest';
import { parseModelListing } from './model-list.ts';

const ids = (output: string): string[] => parseModelListing(output).map((model) => model.id);

describe('parseModelListing', () => {
  test('reads a JSON array of ids', () => {
    expect(ids('["model-a", "model-b"]')).toEqual(['model-a', 'model-b']);
  });

  test('reads JSON objects under models or data, by id, slug, name or model', () => {
    expect(
      ids('{"models":[{"id":"a-1"},{"slug":"b-2"},{"name":"c-3"},{"model":"d-4"},{"x":1}]}'),
    ).toEqual(['a-1', 'b-2', 'c-3', 'd-4']);
    expect(ids('{"data":[{"id":"e-5"}]}')).toEqual(['e-5']);
  });

  test('reads one model per line, skipping headings, prose and blank lines', () => {
    const output = [
      'Available models:',
      '',
      '  model-pro-2.5',
      '  model-flash   (default)',
      '* model-mini-1 - fast and cheap',
      'Use --model to select one.',
    ].join('\n');

    expect(ids(output)).toEqual(['model-pro-2.5', 'model-flash', 'model-mini-1']);
  });

  test('reads the first column of a table', () => {
    const output = [
      '| ID | Context |',
      '|---|---|',
      '| grok-4.1 | 256k |',
      '| grok-fast-1 | 128k |',
    ].join('\n');

    expect(ids(output)).toEqual(['grok-4.1', 'grok-fast-1']);
  });

  test('removes duplicates and anything that could not be passed as an argument', () => {
    expect(ids('["m-1", "m-1", "--flag", "has space-1", ""]')).toEqual(['m-1']);
  });

  test('strips terminal colours', () => {
    expect(ids('\u001b[1mmodel-a1\u001b[0m\n')).toEqual(['model-a1']);
  });

  test('returns nothing for empty output or JSON of another shape', () => {
    expect(ids('')).toEqual([]);
    expect(ids('{"error":"nope"}')).toEqual([]);
    expect(ids('42')).toEqual([]);
  });

  test('bounds the number of models', () => {
    const many = JSON.stringify(Array.from({ length: 500 }, (_, i) => `model-${i}`));

    expect(parseModelListing(many)).toHaveLength(200);
  });
});
