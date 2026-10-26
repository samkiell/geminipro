import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bot } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createUsage, readUsage } from '../src/agent/usage.js';
import { registerAdmin } from '../src/bot/admin.js';
import { PROOF_CAPTION, PROOF_INTRO, PROOF_MISSING } from '../src/content/replies.js';
import type { Alert } from '../src/services/notifier.js';
import { activeProof, createProof, seedProof } from '../src/services/proof.js';
import { createLogger } from '../src/util/logger.js';
import { createTestDb } from './helpers/db.js';
import { facts, fakePort, type FakePort } from './helpers/telegram.js';

const logger = createLogger({ level: 'silent' });
const ADMIN = 1;
let testDb: Awaited<ReturnType<typeof createTestDb>>;
let tg: FakePort;
let alerts: Alert[];
let dir: string;

beforeAll(async () => {
  testDb = await createTestDb();
});
afterAll(async () => {
  await testDb.close();
});
beforeEach(async () => {
  await testDb.reset();
  tg = fakePort();
  alerts = [];
  dir = await mkdtemp(join(tmpdir(), 'proof-'));
  return () => rm(dir, { recursive: true, force: true });
});

const proof = () => createProof({ db: testDb.db, port: tg.port, facts, notify: (a) => alerts.push(a), logger, dir });

describe('proof screenshots', () => {
  it('seeds from assets/proof once, images only, in file name order', async () => {
    for (const name of ['2-transfer.png', '1-activated.jpg', 'notes.txt']) await writeFile(join(dir, name), 'x');
    expect(await seedProof(testDb.db, dir)).toBe(2);
    expect((await activeProof(testDb.db)).map((p) => p.key)).toEqual(['1-activated.jpg', '2-transfer.png']);
    await writeFile(join(dir, '3-more.jpg'), 'x');
    expect(await seedProof(testDb.db, dir)).toBe(0); // only into an empty table
  });

  it('sends the fixed honest text, then the album with one caption, uploading once and reusing file ids after', async () => {
    for (const name of ['a.jpg', 'b.jpg']) await writeFile(join(dir, name), 'x');
    await seedProof(testDb.db, dir);
    const p = proof();

    expect(await p.send(42)).toBe('sent');
    expect(tg.sent[0]?.text).toBe(PROOF_INTRO);
    expect(PROOF_INTRO).toBe(
      "yes, the offer is real. it is google's official 18 month ai pro offer with jio in india. samkiel gets the activation links through a supplier and resells them, so this shop is not run by google or jio. here are real activations from past buyers 👇",
    );
    expect(tg.albums[0]).toEqual({ chatId: 42, photos: [{ path: join(dir, 'a.jpg') }, { path: join(dir, 'b.jpg') }], caption: PROOF_CAPTION });
    expect(tg.buttons(tg.sent.at(-1)?.id).map((b) => b.text)).toEqual(['buy now', 'whatsapp support']);

    await p.send(43);
    expect(tg.albums[1]?.photos).toEqual([{ fileId: 'file-1' }, { fileId: 'file-2' }]);
  });

  it('without the intro ([see proof]): only the album and what to do next', async () => {
    await writeFile(join(dir, '1.jpg'), 'x');
    await seedProof(testDb.db, dir);
    expect(await proof().send(42, { intro: false })).toBe('sent');
    expect(tg.sent.map((m) => m.text)).not.toContain(PROOF_INTRO);
    expect(tg.albums).toHaveLength(1);
    expect(tg.sent.at(-1)?.text).toBe('want one? tap below.');
  });

  it('with no screenshots yet: an honest note, whatsapp support, and one alert per cooldown', async () => {
    const p = proof();
    expect(await p.send(42)).toBe('missing');
    expect(tg.sent[0]?.text).toBe(PROOF_MISSING);
    expect(tg.albums).toHaveLength(0);
    expect(alerts).toMatchObject([{ title: 'no proof screenshots yet', cooldownKey: 'proof_missing' }]);
  });

  it('admins add one with a captioned photo, list them and remove one; buyers cannot', async () => {
    const botInfo = { id: 9, is_bot: true, first_name: 'b', username: 'geminiprosamkiel_bot' } as UserFromGetMe;
    const bot = new Bot('123:test', { botInfo });
    bot.api.config.use(async () => ({ ok: true, result: true }) as never);
    registerAdmin(bot, {
      db: testDb.db,
      port: tg.port,
      logger,
      facts,
      adminIds: [ADMIN],
      reseller: {} as never,
      productId: 1,
      flows: { orderChanged: () => {} },
      notify: () => {},
      proof: proof(),
    });
    let id = 1;
    const photo = (from: number, caption: string, unique: string): Update =>
      ({
        update_id: id++,
        message: {
          message_id: id,
          date: 0,
          chat: { id: from, type: 'private', first_name: 'x' },
          from: { id: from, is_bot: false, first_name: 'x' },
          caption,
          caption_entities: [{ type: 'bot_command', offset: 0, length: 9 }],
          photo: [
            { file_id: `small-${unique}`, file_unique_id: `${unique}-s`, width: 90, height: 90 },
            { file_id: `big-${unique}`, file_unique_id: unique, width: 1280, height: 900 },
          ],
        },
      }) as Update;
    const command = (from: number, text: string): Update =>
      ({
        update_id: id++,
        message: {
          message_id: id,
          date: 0,
          chat: { id: from, type: 'private', first_name: 'x' },
          from: { id: from, is_bot: false, first_name: 'x' },
          text,
          entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0]?.length ?? 0 }],
        },
      }) as Update;

    await bot.handleUpdate(photo(ADMIN, '/addproof', 'u1'));
    await bot.handleUpdate(photo(ADMIN, '/addproof', 'u2'));
    await bot.handleUpdate(photo(ADMIN, '/addproof', 'u1'));
    await bot.handleUpdate(photo(42, '/addproof', 'u3')); // a buyer: ignored
    expect(tg.textsTo(ADMIN)).toEqual([
      'added. the album now has 1 of 10. check it with /proofs.',
      'added. the album now has 2 of 10. check it with /proofs.',
      'that screenshot is already in the album.',
    ]);
    expect((await activeProof(testDb.db)).map((p) => p.fileId)).toEqual(['big-u1', 'big-u2']);

    await bot.handleUpdate(command(ADMIN, '/proofs'));
    // The photos themselves first, each labelled with the id /delproof takes.
    expect(tg.albums.at(-1)?.photos).toEqual([
      { fileId: 'big-u1', caption: '#1' },
      { fileId: 'big-u2', caption: '#2' },
    ]);
    const list = tg.sent.at(-1);
    expect(list?.text).toContain('#1 sent in telegram\n#2 sent in telegram');
    expect(tg.buttons(list?.id).map((b) => b.text)).toEqual(['🗑 remove #1', '🗑 remove #2', '‹ panel']);

    await bot.handleUpdate(command(ADMIN, '/delproof 1'));
    expect(tg.textsTo(ADMIN).at(-1)).toContain('removed #1.\nproof album (1 of 10)');
    expect((await activeProof(testDb.db)).map((p) => p.fileId)).toEqual(['big-u2']);
    // Ids do not shift: #2 is still #2, and a wrong id says so.
    await bot.handleUpdate(command(ADMIN, '/delproof 1'));
    expect(tg.textsTo(ADMIN).at(-1)).toContain('there is no screenshot #1.');
    // Removed for good, so the same screenshot can be added again.
    await bot.handleUpdate(photo(ADMIN, '/addproof', 'u1'));
    expect(tg.textsTo(ADMIN).at(-1)).toBe('added. the album now has 2 of 10. check it with /proofs.');

    // /addproof as text: the photos that follow are added without a caption, as an album's are.
    await bot.handleUpdate(command(ADMIN, '/addproof'));
    expect(tg.textsTo(ADMIN).at(-1)).toContain('send the screenshots now, as photos (not files)');
    await bot.handleUpdate(photo(ADMIN, '', 'u4'));
    expect(tg.textsTo(ADMIN).at(-1)).toBe('added. the album now has 3 of 10. check it with /proofs.');
    await bot.handleUpdate(photo(42, '', 'u5')); // a buyer: ignored
    expect((await activeProof(testDb.db)).map((p) => p.fileId)).toEqual(['big-u2', 'big-u1', 'big-u4']);

    // An image sent as a file cannot go in the album: say how to send it.
    await bot.handleUpdate({
      update_id: id++,
      message: {
        message_id: id,
        date: 0,
        chat: { id: ADMIN, type: 'private', first_name: 'x' },
        from: { id: ADMIN, is_bot: false, first_name: 'x' },
        document: { file_id: 'doc-1', file_unique_id: 'doc-1u', mime_type: 'image/jpeg' },
      },
    } as Update);
    expect(tg.textsTo(ADMIN).at(-1)).toBe("that came as a file. send it as a photo (compressed) and i'll add it.");
  });
});

describe('model usage', () => {
  it('counts calls, rate limits, free answers and fallbacks per WAT day; many fallbacks alert once', async () => {
    const now = new Date('2026-10-26T12:00:00Z');
    const usage = createUsage({ db: testDb.db, notify: (a) => alerts.push(a), logger, now: () => now });
    usage.call({ model: 'a', ok: true, latencyMs: 400 });
    usage.call({ model: 'a', ok: false, latencyMs: 30, status: 429 });
    usage.free();
    for (let i = 0; i < 7; i++) usage.fallback('rate_limited');
    await usage.settled();
    expect(await readUsage(testDb.db, now)).toEqual({ calls: 2, rateLimited: 1, free: 1, fallbacks: 7 });
    // the 6th and 7th fallback both alert; the notifier's cooldown makes it one message
    expect(alerts.map((a) => [a.title, a.cooldownKey])).toEqual([
      ['buyers are getting scripted replies', 'llm_fallbacks'],
      ['buyers are getting scripted replies', 'llm_fallbacks'],
    ]);
    expect(await readUsage(testDb.db, new Date('2026-10-27T12:00:00Z'))).toEqual({ calls: 0, rateLimited: 0, free: 0, fallbacks: 0 });
  });
});
