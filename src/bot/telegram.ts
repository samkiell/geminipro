import { GrammyError, InlineKeyboard, type Api } from 'grammy';

// A small port over the Bot API: everything that renders to a chat goes through it, so views stay
// pure and tests can record what would have been sent or edited.

export type Button = { text: string; data: string } | { text: string; url: string };
export type Keyboard = Button[][];

export interface OutMessage {
  text: string;
  /** parse_mode HTML. Anything not written by us must go through escapeHtml. */
  html?: boolean;
  keyboard?: Keyboard;
}

/** 'gone': the message no longer exists or can no longer be edited. 'failed': try again later. */
export type EditOutcome = 'ok' | 'gone' | 'failed';

export class SendError extends Error {
  override name = 'SendError';
  /** blocked: the buyer blocked the bot or the chat is gone, retrying will not help. */
  readonly kind: 'blocked' | 'failed';

  constructor(kind: 'blocked' | 'failed', message: string) {
    super(message);
    this.kind = kind;
  }
}

export interface TelegramPort {
  /** Returns the new message id. Throws SendError. */
  send(chatId: number, message: OutMessage): Promise<number>;
  /** Replaces text and buttons (no keyboard removes them). Never throws. */
  edit(chatId: number, messageId: number, message: OutMessage): Promise<EditOutcome>;
  /** Replaces only the buttons (none removes them). Never throws. */
  setButtons(chatId: number, messageId: number, keyboard?: Keyboard): Promise<EditOutcome>;
  /** Answers a button tap. Never throws. */
  answer(callbackQueryId: string, text?: string): Promise<void>;
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function inlineKeyboard(keyboard: Keyboard | undefined): InlineKeyboard {
  const kb = new InlineKeyboard();
  (keyboard ?? []).forEach((row, i) => {
    for (const button of row) {
      if ('url' in button) kb.url(button.text, button.url);
      else kb.text(button.text, button.data);
    }
    if (i < (keyboard?.length ?? 0) - 1) kb.row();
  });
  return kb;
}

function sendError(err: unknown): SendError {
  // Only the description: the error's payload would contain the message text.
  if (err instanceof GrammyError) {
    const gone = err.error_code === 403 || /chat not found|user is deactivated/i.test(err.description);
    return new SendError(gone ? 'blocked' : 'failed', `telegram ${err.error_code}: ${err.description}`);
  }
  return new SendError('failed', `telegram request failed: ${(err as Error).name}`);
}

function editOutcome(err: unknown): EditOutcome {
  if (err instanceof GrammyError) {
    if (/message is not modified/i.test(err.description)) return 'ok';
    // Not found, can't be edited (too old or not ours), chat gone or bot blocked.
    if (err.error_code === 400 || err.error_code === 403) return 'gone';
  }
  return 'failed';
}

export function grammyPort(api: Api): TelegramPort {
  const options = (m: OutMessage) => ({
    ...(m.html && { parse_mode: 'HTML' as const }),
    link_preview_options: { is_disabled: true },
    reply_markup: inlineKeyboard(m.keyboard),
  });
  return {
    async send(chatId, message) {
      try {
        const sent = await api.sendMessage(chatId, message.text, options(message));
        return sent.message_id;
      } catch (err) {
        throw sendError(err);
      }
    },
    async edit(chatId, messageId, message) {
      try {
        await api.editMessageText(chatId, messageId, message.text, options(message));
        return 'ok';
      } catch (err) {
        return editOutcome(err);
      }
    },
    async setButtons(chatId, messageId, keyboard) {
      try {
        await api.editMessageReplyMarkup(chatId, messageId, { reply_markup: inlineKeyboard(keyboard) });
        return 'ok';
      } catch (err) {
        return editOutcome(err);
      }
    },
    async answer(callbackQueryId, text) {
      await api.answerCallbackQuery(callbackQueryId, text ? { text } : {}).catch(() => {});
    },
  };
}

/** Packs text blocks into messages under Telegram's 4096 character limit, keeping blocks whole. */
export function packMessages(blocks: string[], max = 4000): string[] {
  const messages: string[] = [];
  let current = '';
  for (const block of blocks) {
    const next = current ? `${current}\n${block}` : block;
    if (next.length > max && current) {
      messages.push(current);
      current = block;
    } else {
      current = next;
    }
  }
  if (current) messages.push(current);
  return messages;
}
