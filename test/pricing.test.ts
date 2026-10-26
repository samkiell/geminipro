import { describe, expect, it } from 'vitest';
import { priceFor, type PricingConfig } from '../src/services/pricing.js';

const customerPays: PricingConfig = { unitPriceNgn: 3500, grossUp: false, feePct: 0.02, feeFlat: 0 };
const grossUp: PricingConfig = { ...customerPays, grossUp: true };

describe('priceFor', () => {
  it('without gross up, the total is the base and the fee is left to Bachs', () => {
    expect(priceFor(1, customerPays)).toEqual({ quantity: 1, unitPriceNgn: 3500, baseNgn: 3500, feeNgn: 0, totalNgn: 3500 });
    expect(priceFor(3, customerPays)).toMatchObject({ baseNgn: 10_500, feeNgn: 0, totalNgn: 10_500 });
    expect(priceFor(10, customerPays)).toMatchObject({ baseNgn: 35_000, feeNgn: 0, totalNgn: 35_000 });
  });

  it('with gross up, total = ceil((base + flat) / (1 - pct)) on the whole order', () => {
    // 3500 / 0.98 = 3571.43
    expect(priceFor(1, grossUp)).toMatchObject({ baseNgn: 3500, feeNgn: 72, totalNgn: 3572 });
    // 10500 / 0.98 = 10714.29
    expect(priceFor(3, grossUp)).toMatchObject({ baseNgn: 10_500, feeNgn: 215, totalNgn: 10_715 });
    // 35000 / 0.98 = 35714.29
    expect(priceFor(10, grossUp)).toMatchObject({ baseNgn: 35_000, feeNgn: 715, totalNgn: 35_715 });
  });

  it('matches the PRD example of 1.5% + 100 for one link', () => {
    // (3500 + 100) / 0.985 = 3654.82
    expect(priceFor(1, { ...grossUp, feePct: 0.015, feeFlat: 100 }).totalNgn).toBe(3655);
  });

  it('never rounds an exact total up by a naira', () => {
    // 4900 / 0.98 = 5000 exactly
    expect(priceFor(1, { ...grossUp, unitPriceNgn: 4900 }).totalNgn).toBe(5000);
  });

  it('the owner keeps the full base after the percentage fee', () => {
    for (const quantity of [1, 2, 3, 7, 10]) {
      const { baseNgn, totalNgn } = priceFor(quantity, grossUp);
      expect(totalNgn - totalNgn * 0.02).toBeGreaterThanOrEqual(baseNgn);
    }
  });

  it('rejects quantities that are not positive whole numbers', () => {
    for (const quantity of [0, -1, 1.5, Number.NaN]) {
      expect(() => priceFor(quantity, customerPays)).toThrow(RangeError);
    }
  });
});
