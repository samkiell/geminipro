import type { Config } from '../config.js';

export interface PricingConfig {
  unitPriceNgn: number;
  /** true: add the payment fee to the total ourselves. false: Bachs adds it at checkout (customer_pays). */
  grossUp: boolean;
  feePct: number;
  feeFlat: number;
}

export interface Price {
  quantity: number;
  unitPriceNgn: number;
  baseNgn: number;
  feeNgn: number;
  /** What the checkout is created for. */
  totalNgn: number;
}

export function pricingFromConfig(config: Config): PricingConfig {
  return {
    unitPriceNgn: config.UNIT_PRICE_NGN,
    grossUp: config.GROSS_UP,
    feePct: config.FEE_PCT,
    feeFlat: config.FEE_FLAT,
  };
}

export function priceFor(quantity: number, pricing: PricingConfig): Price {
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new RangeError(`quantity must be a positive whole number, got ${quantity}`);
  }
  const { unitPriceNgn, grossUp, feePct, feeFlat } = pricing;
  const baseNgn = unitPriceNgn * quantity;
  if (!grossUp) return { quantity, unitPriceNgn, baseNgn, feeNgn: 0, totalNgn: baseNgn };

  // total = ceil((base + flat) / (1 - pct)), in whole basis points so float error never adds a naira.
  const keptBp = 10_000 - Math.round(feePct * 10_000);
  const numerator = (baseNgn + feeFlat) * 10_000;
  const totalNgn = Math.floor((numerator + keptBp - 1) / keptBp);
  return { quantity, unitPriceNgn, baseNgn, feeNgn: totalNgn - baseNgn, totalNgn };
}
