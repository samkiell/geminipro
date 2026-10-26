import { SendError, type AlbumPhoto, type Keyboard, type OutMessage, type TelegramPort } from '../../src/bot/telegram.js';
import type { UiFacts } from '../../src/bot/views.js';

export const facts: UiFacts = {
  unitPriceNgn: 3500,
  grossUp: false,
  supportIntl: '2348087357158',
  supportLocal: '08087357158',
  maxQtyPerOrder: 10,
  paymentWindowMinutes: 15,
};

export interface ChatMessage extends OutMessage {
  chatId: number;
  id: number;
}

/** Records what the bot would send and keeps every message's current state, edits included. */
export function fakePort() {
  let nextId = 100;
  const messages = new Map<number, ChatMessage>();
  const sent: ChatMessage[] = [];
  const edits: { id: number; text: string }[] = [];
  const answers: { queryId: string; text: string | undefined }[] = [];
  const albums: { chatId: number; photos: AlbumPhoto[]; caption: string }[] = [];
  const blocked = new Set<number>();
  const deleted: number[] = [];
  let failSends = 0;
  let nextFile = 1;

  const port: TelegramPort = {
    async sendAlbum(chatId, photos, caption) {
      if (blocked.has(chatId)) throw new SendError('blocked', 'telegram 403: Forbidden: bot was blocked by the user');
      albums.push({ chatId, photos, caption });
      return photos.map((p) => ('fileId' in p ? p.fileId : `file-${nextFile++}`));
    },
    async send(chatId, message) {
      if (blocked.has(chatId)) throw new SendError('blocked', 'telegram 403: Forbidden: bot was blocked by the user');
      if (failSends > 0) {
        failSends--;
        throw new SendError('failed', 'telegram request failed: HttpError');
      }
      const msg = { ...message, chatId, id: nextId++ };
      messages.set(msg.id, msg);
      sent.push(msg);
      return msg.id;
    },
    async edit(_chatId, id, message) {
      const current = messages.get(id);
      if (!current) return 'gone';
      const { keyboard: _old, ...rest } = current;
      messages.set(id, { ...rest, ...message });
      edits.push({ id, text: message.text });
      return 'ok';
    },
    async setButtons(_chatId, id, keyboard?: Keyboard) {
      const current = messages.get(id);
      if (!current) return 'gone';
      const { keyboard: _old, ...rest } = current;
      messages.set(id, keyboard ? { ...rest, keyboard } : rest);
      return 'ok';
    },
    async answer(queryId, text) {
      answers.push({ queryId, text });
    },
    async delete(_chatId, messageId) {
      messages.delete(messageId);
      deleted.push(messageId);
    },
  };

  return {
    port,
    messages,
    sent,
    edits,
    answers,
    albums,
    deleted,
    /** Current state of a message. */
    get: (id: number | null | undefined) => (id ? messages.get(id) : undefined),
    block: (chatId: number) => blocked.add(chatId),
    failNextSends: (n: number) => (failSends = n),
    /** Every button on a message, flattened. */
    buttons: (id: number | null | undefined) => (id ? (messages.get(id)?.keyboard ?? []).flat() : []),
    textsTo: (chatId: number) => sent.filter((m) => m.chatId === chatId).map((m) => m.text),
  };
}

export type FakePort = ReturnType<typeof fakePort>;
