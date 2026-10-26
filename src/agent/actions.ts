import type { Flows } from '../bot/flows.js';
import { supportUrl } from '../bot/views.js';
import type { Db } from '../db/client.js';
import { saveLead } from '../services/leads.js';
import type { Notify } from '../services/notifier.js';
import { reservedUnits } from '../services/orders.js';
import { priceFor, type PricingConfig } from '../services/pricing.js';
import type { ResellerClient } from '../services/reseller.js';
import { isPaused } from '../services/settings.js';
import { CHECKOUT_FEE_NOTE, type AgentActions } from './tools.js';

export interface AgentActionsDeps {
  db: Db;
  flows: Flows;
  reseller: Pick<ResellerClient, 'getAvailability'>;
  pricing: PricingConfig;
  salesCutoff: Date | undefined;
  supportIntl: string;
  supportLocal: string;
  notify: Notify;
}

export function createAgentActions(deps: AgentActionsDeps): AgentActions {
  const { db, flows } = deps;
  // Without gross up, Bachs (customer_pays) adds its fee on the checkout page.
  const feeNote = deps.pricing.grossUp ? {} : { feeNote: CHECKOUT_FEE_NOTE };

  return {
    getPrice(quantity) {
      const { baseNgn, feeNgn, totalNgn } = priceFor(quantity, deps.pricing);
      return { quantity, baseNgn, feeNgn, totalNgn, ...feeNote };
    },
    async checkAvailability() {
      if (await isPaused(db)) return { canSell: false, maxQuantity: 0, reason: 'sales are paused' };
      if (deps.salesCutoff && new Date() >= deps.salesCutoff) return { canSell: false, maxQuantity: 0, reason: 'sales have closed' };
      try {
        return await deps.reseller.getAvailability(await reservedUnits(db));
      } catch {
        return { canSell: false, maxQuantity: 0, reason: 'stock could not be checked right now' };
      }
    },
    buy: (telegramId, quantity) => flows.startBuy(telegramId, quantity),
    showHistory: (telegramId) => flows.showHistory(telegramId, 1),
    showOrder: (telegramId, orderNo) => flows.showOrderByNo(telegramId, orderNo),
    cancelPending: (telegramId) => flows.cancelPending(telegramId),
    async escalate(telegramId, username, reason) {
      deps.notify({
        level: 'warning',
        title: 'buyer needs support',
        body: `${username ? `@${username}` : `Telegram user ${telegramId}`}: ${reason}`,
      });
    },
    saveLead: (telegramId, username, summary) => saveLead(db, deps.notify, { telegramId, username, summary }),
    supportLocal: deps.supportLocal,
    supportUrl: supportUrl(deps.supportIntl),
  };
}
