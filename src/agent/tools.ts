import { z } from 'zod';

// The agent proposes, code disposes (docs/ARCHITECTURE.md 5.2). The model only picks a tool and
// arguments; code validates them, acts for the user in the update (never an id from the model),
// and returns plain facts. No tool result ever contains an activation link or a checkout URL.

export interface PayButton {
  orderId: string;
  url: string;
  quantity: number;
  totalNgn: number;
}

export interface ToolContext {
  /** From the Telegram update. */
  telegramId: number;
  /** Set by create_payment_link; the bot shows it as the pay now button. */
  payButton?: PayButton;
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

export interface OrderSummary {
  /** First 8 characters of the order id: models copy short refs reliably, full UUIDs less so. */
  orderRef: string;
  quantity: number;
  status: string;
  /** Plain words for the buyer. */
  meaning: string;
  totalNgn: number;
  createdAt: string;
}

export type PaymentLinkResult =
  | {
      ok: true;
      orderId: string;
      quantity: number;
      totalNgn: number;
      expiresInMinutes: number;
      checkoutUrl: string;
      feeNote?: string;
    }
  | {
      ok: false;
      error: 'pending_order_exists';
      orderId: string;
      quantity: number;
      totalNgn: number;
      expiresInMinutes: number;
      checkoutUrl: string | undefined;
    }
  | { ok: false; error: 'not_enough_stock' | 'invalid_quantity'; maxQuantity: number }
  | { ok: false; error: 'sales_paused' | 'sales_closed' | 'payment_link_failed' };

/** What the tools can do. Real implementation in services.ts; the eval script uses a fake. */
export interface BuyerServices {
  getPrice(quantity: number): PriceInfo;
  checkAvailability(): Promise<{ canSell: boolean; maxQuantity: number; reason?: string }>;
  createPaymentLink(telegramId: number, quantity: number): Promise<PaymentLinkResult>;
  getMyOrders(telegramId: number): Promise<OrderSummary[]>;
  /** orderRef from getMyOrders; omitted means the latest order with delivered links. */
  resendMyLinks(telegramId: number, orderRef?: string): Promise<{ sent: number } | { error: string }>;
  cancelPendingOrder(telegramId: number): Promise<{ cancelled: boolean }>;
  escalate(telegramId: number, reason: string): Promise<{ supportWhatsapp: string }>;
}

export interface ToolDefinition {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ToolSet {
  definitions: ToolDefinition[];
  execute(name: string, rawArguments: string | undefined, ctx: ToolContext): Promise<unknown>;
}

export function createTools(services: BuyerServices, { maxQtyPerOrder }: { maxQtyPerOrder: number }): ToolSet {
  const quantity = z.coerce.number().int();

  const tools = {
    get_price: {
      description: 'Exact price for a number of links: base, payment fee if any, and total in naira.',
      args: z.object({ quantity: quantity.default(1).describe('how many links, default 1') }),
      run: async ({ quantity: q }: { quantity: number }) =>
        services.getPrice(Math.min(Math.max(q, 1), maxQtyPerOrder)),
    },
    check_availability: {
      description: 'Whether links can be sold right now, and the most that can be bought in one order.',
      args: z.object({}),
      run: async () => services.checkAvailability(),
    },
    create_payment_link: {
      description:
        'Create an order and its payment link for this user. The pay now button is attached to your reply automatically.',
      args: z.object({ quantity: quantity.describe(`how many links, 1 to ${maxQtyPerOrder}`) }),
      run: async ({ quantity: q }: { quantity: number }, ctx: ToolContext) => {
        const result = await services.createPaymentLink(ctx.telegramId, q);
        if (result.ok) {
          ctx.payButton = { orderId: result.orderId, url: result.checkoutUrl, quantity: result.quantity, totalNgn: result.totalNgn };
          return {
            orderId: result.orderId,
            totalNgn: result.totalNgn,
            expiresInMinutes: result.expiresInMinutes,
            ...(result.feeNote && { feeNote: result.feeNote }),
          };
        }
        if (result.error === 'pending_order_exists') {
          if (result.checkoutUrl) {
            ctx.payButton = { orderId: result.orderId, url: result.checkoutUrl, quantity: result.quantity, totalNgn: result.totalNgn };
          }
          const { checkoutUrl: _url, ok: _ok, ...facts } = result;
          return {
            ...facts,
            note: 'this user already has an unpaid order. its pay now button is attached. to change the quantity, cancel it first with cancel_pending_order.',
          };
        }
        const { ok: _ok, ...error } = result;
        return error;
      },
    },
    get_my_orders: {
      description: "This user's last 5 orders with their status. Never contains links.",
      args: z.object({}),
      run: async (_args: object, ctx: ToolContext) => ({ orders: await services.getMyOrders(ctx.telegramId) }),
    },
    resend_my_links: {
      description:
        "Send the links of this user's delivered order to the chat again (code sends them, not you). Leave orderRef out for their latest delivered order.",
      args: z.object({ orderRef: z.string().optional().describe('orderRef from get_my_orders, optional') }),
      run: async ({ orderRef }: { orderRef?: string | undefined }, ctx: ToolContext) =>
        services.resendMyLinks(ctx.telegramId, orderRef),
    },
    cancel_pending_order: {
      description: "Cancel this user's unpaid order, if they have one.",
      args: z.object({}),
      run: async (_args: object, ctx: ToolContext) => services.cancelPendingOrder(ctx.telegramId),
    },
    escalate_to_support: {
      description:
        'Alert the owner and get the whatsapp support number: dead links, refunds, discounts, complaints, anger, or anything you cannot answer.',
      args: z.object({ reason: z.string().describe('one short sentence on what the user needs') }),
      run: async ({ reason }: { reason: string }, ctx: ToolContext) => services.escalate(ctx.telegramId, reason.slice(0, 500)),
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
