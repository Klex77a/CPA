import { describe, expect, it } from 'vitest';
import { costDescription, costIsComplete, knownCost, usageDescription } from './format';
describe('billing presentation', () => {
  it('keeps incomplete totals unknown and retains a known lower bound', () => {
    const incomplete = {
      cost_usd: null,
      known_cost_usd: 0.12,
      billing_complete: false,
      unknown_call_count: 1,
    };
    expect(costIsComplete(incomplete)).toBe(false);
    expect(knownCost(incomplete)).toBe(0.12);
    expect(costDescription(incomplete)).toBe('не менее $0.1200; полная стоимость неизвестна');
    expect(costDescription({ cost_usd: null })).toBe('полная стоимость неизвестна');
    expect(costDescription({ cost_usd: 0, unknown_cost_count: 1 })).toBe(
      'полная стоимость неизвестна',
    );
    expect(usageDescription({ usage: null })).toContain('Токены неизвестны');
  });
  it('preserves legacy observed complete totals while partial usage remains explicitly partial', () => {
    expect(costDescription({ cost_usd: 0.002 })).toBe('≈ $0.0020');
    expect(usageDescription({ usage: { input: 100, output: 200, thoughts: 0 } })).toBe(
      'Токены: 100 вход / 200 выход.',
    );
    expect(
      usageDescription({
        usage: null,
        known_usage: { input: 100, output: 200, thoughts: 0 },
        billing_complete: false,
        unknown_call_count: 1,
      }),
    ).toContain('полное число неизвестно');
  });
});
