import { z } from 'zod';
import type { BuyOutcome } from '../bot/flows.js';
import type { Keyboard } from '../bot/telegram.js';
import { OWNER_LINKS, OWNER_TOPICS, ownerButtons, ownerInfo, type OwnerTopic } from '../knowledge/owner.js';

// The agent proposes, code disposes (docs/ARCHITECTURE.md 5.2). The model picks a tool and
// arguments; code validates them, acts for the user in the update (never an id from the model),
// renders anything visual itself, and returns plain facts. No tool result ever contains an
// activation link or a checkout URL.

export interface ToolContext {
  /** From the Telegram update. */
  telegramId: number;
  username: string | undefined;
  /** URL buttons (portfolio, support) to attach to the agent's reply. */
  attachments: Keyboard;
  /** The order card was shown this turn; a second create_payment_link only reports it. */
  cardShown?: BuyOutcome;
}

export interface PriceInfo {
  quantity: number;
  baseNgn: number;
  feeNgn: number;
  totalNgn: number;
  /** Set when Bachs adds the payment fee on the checkout page, on top of totalNgn. */
  feeNote?: string;
}

export const CHECKOUT_FEE_NOTE = 'a small payment fee is added on the checkout page, on top of this total';

/** What the tools can do. Real implementation in actions.ts; the eval script uses a fake. */
export interface AgentActions {
  getPrice(quantity: number): PriceInfo;
  checkAvailability(): Promise<{ canSell: boolean; maxQuantity: number; reason?: string }>;
  /** Shows the order summary card with the pay button. */
  buy(telegramId: number, quantity: number): Promise<BuyOutcome>;
  showHistory(telegramId: number): Promise<void>;
  showOrder(telegramId: number, orderNo: string): Promise<boolean>;
  cancelPending(telegramId: number): Promise<boolean>;
  escalate(telegramId: number, username: string | undefined, reason: string): Promise<void>;
  saveLead(telegramId: number, username: string | undefined, summary: string): Promise<'saved' | 'limited'>;
  supportLocal: string;
  supportUrl: string;
}

export interface ToolDefinition {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ToolSet {
  definitions: ToolDefinition[];
  execute(name: string, rawArguments: string | undefined, ctx: ToolContext): Promise<unknown>;
}

function attach(ctx: ToolContext, row: Keyboard[number]): void {
  const urls = new Set(ctx.attachments.flat().map((b) => ('url' in b ? b.url : b.data)));
  const fresh = row.filter((b) => !urls.has('url' in b ? b.url : b.data));
  if (fresh.length > 0) ctx.attachments.push(fresh);
}

export function createTools(actions: AgentActions, { maxQtyPerOrder }: { maxQtyPerOrder: number }): ToolSet {
  const quantity = z.coerce.number().int();

  const tools = {
    get_price: {
      description: 'Price for a number of links.',
      args: z.object({ quantity: quantity.default(1) }),
      run: async ({ quantity: q }: { quantity: number }) => actions.getPrice(Math.min(Math.max(q, 1), maxQtyPerOrder)),
    },
    check_availability: {
      description: 'Whether links can be sold now, and the most per order.',
      args: z.object({}),
      run: async () => actions.checkAvailability(),
    },
    create_payment_link: {
      description: 'Show this user the order card with quantity, total and pay button.',
      args: z.object({ quantity: quantity.default(1) }),
      run: async ({ quantity: q }: { quantity: number }, ctx: ToolContext) => {
        if (ctx.cardShown) return { shown: true, note: 'the order card is already in the chat' };
        const outcome = await actions.buy(ctx.telegramId, q);
        if (!outcome.ok) {
          return { shown: false, error: outcome.reason, note: 'the user was already told in the chat; reply in one short line' };
        }
        ctx.cardShown = outcome;
        const { ok: _ok, maxQuantity: _max, ...facts } = outcome;
        const price = actions.getPrice(outcome.quantity);
        return { shown: true, ...facts, ...(price.feeNote && { feeNote: price.feeNote }) };
      },
    },
    show_history: {
      description: "Show this user's orders, where they can open an order and get its links again.",
      args: z.object({}),
      run: async (_args: object, ctx: ToolContext) => {
        await actions.showHistory(ctx.telegramId);
        return { shown: true };
      },
    },
    show_order: {
      description: 'Show one of this user\'s orders by its number, like GP-1042.',
      args: z.object({ orderNo: z.string() }),
      run: async ({ orderNo }: { orderNo: string }, ctx: ToolContext) =>
        (await actions.showOrder(ctx.telegramId, orderNo)) ? { shown: true } : { shown: false, error: 'order_not_found' },
    },
    cancel_pending_order: {
      description: "Cancel this user's unpaid order.",
      args: z.object({}),
      run: async (_args: object, ctx: ToolContext) => ({ cancelled: await actions.cancelPending(ctx.telegramId) }),
    },
    escalate_to_support: {
      description: 'Alert the owner and offer whatsapp support: dead links, refunds, discounts, complaints, or anything you cannot answer.',
      args: z.object({ reason: z.string() }),
      run: async ({ reason }: { reason: string }, ctx: ToolContext) => {
        await actions.escalate(ctx.telegramId, ctx.username, reason.slice(0, 500));
        attach(ctx, [{ text: 'whatsapp support', url: actions.supportUrl }]);
        return { supportWhatsapp: actions.supportLocal, note: 'a whatsapp button is attached to your reply' };
      },
    },
    get_owner_info: {
      description: 'Facts about samkiel (who made you) and how the shop works.',
      args: z.object({ topic: z.enum(OWNER_TOPICS as [OwnerTopic, ...OwnerTopic[]]) }),
      run: async ({ topic }: { topic: OwnerTopic }, ctx: ToolContext) => {
        const buttons = ownerButtons(topic).map((name) => ({ text: name, url: OWNER_LINKS[name] }));
        if (buttons.length > 0) attach(ctx, buttons);
        return { ok: true, text: ownerInfo(topic), ...(buttons.length > 0 && { note: 'link buttons are attached to your reply' }) };
      },
    },
    save_lead: {
      description: 'Save a request to have samkiel build something (app, website, bot) so he can follow up.',
      args: z.object({ summary: z.string() }),
      run: async ({ summary }: { summary: string }, ctx: ToolContext) => {
        attach(ctx, [{ text: 'portfolio', url: OWNER_LINKS.portfolio }]);
        return { saved: (await actions.saveLead(ctx.telegramId, ctx.username, summary)) === 'saved' };
      },
    },
  } as const;

  type Name = keyof typeof tools;

  const definitions: ToolDefinition[] = Object.entries(tools).map(([name, tool]) => {
    const { $schema: _schema, ...parameters } = z.toJSONSchema(tool.args, { io: 'input' }) as Record<string, unknown>;
    return { type: 'function', function: { name, description: tool.description, parameters } };
  });

  return {
    definitions,
    async execute(name, rawArguments, ctx) {
      if (!(name in tools)) return { error: 'unknown_tool' };
      const tool = tools[name as Name];
      let input: unknown;
      try {
        input = rawArguments ? JSON.parse(rawArguments) : {};
      } catch {
        return { error: 'invalid_arguments', details: 'arguments were not valid json' };
      }
      // Unknown keys (a telegram_id, say) are stripped: the user always comes from ctx.
      const parsed = tool.args.safeParse(input ?? {});
      if (!parsed.success) {
        return { error: 'invalid_arguments', details: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) };
      }
      return (tool.run as (args: unknown, ctx: ToolContext) => Promise<unknown>)(parsed.data, ctx);
    },
  };
}
