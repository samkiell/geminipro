import { describe, expect, it } from 'vitest';
import { createPicker, isPurchaseRequest, quantityIn, scriptedTurn, type ScriptedContext } from '../src/agent/fallback.js';
import { facts } from './helpers/telegram.js';

const en: ScriptedContext = { lang: 'en', facts, pick: (o) => o[0] ?? '' };
const pcm: ScriptedContext = { lang: 'pcm', facts, pick: (o) => o[0] ?? '' };
const turn = (text: string, c = en) => scriptedTurn(text, c);

describe('scripted fallback understands what buyers want', () => {
  it('opens the order card with the quantity they asked for', () => {
    expect(turn('i want to buy one link')).toEqual({ kind: 'buy', quantity: 1 });
    expect(turn('i need 3 links, can i pay now')).toEqual({ kind: 'buy', quantity: 3 });
    expect(turn('abeg give me two', pcm)).toEqual({ kind: 'buy', quantity: 2 });
    expect(turn('i wan buy 5', pcm)).toEqual({ kind: 'buy', quantity: 5 });
    expect(turn('buy')).toEqual({ kind: 'buy', quantity: 1 });
  });

  it('shows history for order and link questions, and an order by number', () => {
    for (const text of ['where is my link', 'my orders', 'i never get my link', 'show my links', 'order history']) {
      expect(turn(text)).toEqual({ kind: 'history' });
    }
    expect(turn('what about GP-1042?')).toEqual({ kind: 'order', orderNo: 'GP-1042' });
    expect(turn('gp 1043')).toEqual({ kind: 'order', orderNo: 'GP-1043' });
  });

  it('opens the right help page', () => {
    expect(turn('how do i activate it')).toEqual({ kind: 'help', page: 'activate' });
    expect(turn('i already have google one, what happens')).toEqual({ kind: 'help', page: 'plan' });
    expect(turn('can i get a refund if it expired')).toEqual({ kind: 'help', page: 'policy' });
    expect(turn('what do i get with it')).toEqual({ kind: 'help', page: 'get' });
    expect(turn('how does it work')).toEqual({ kind: 'help', page: 'how' });
    expect(turn('is the offer still available')).toEqual({ kind: 'help', page: 'offer' });
    expect(turn('menu')).toEqual({ kind: 'help', page: 'hub' });
  });

  it('answers price, legit, who made you, support and cancel', () => {
    const price = turn('how much');
    expect(price).toMatchObject({ kind: 'reply', text: expect.stringContaining('₦3,500 per link') });
    expect(turn('how much for 4')).toMatchObject({ kind: 'reply', text: expect.stringContaining('4 links come to ₦14,000') });
    expect(turn('wetin be the price', pcm)).toMatchObject({ text: expect.stringContaining('na ₦3,500 per link') });
    expect(turn('is this legit?')).toMatchObject({ kind: 'reply', text: expect.stringMatching(/(isn't|not) affiliated with google or jio/) });
    const who = turn('who made you');
    expect(who).toMatchObject({ kind: 'reply', text: expect.stringContaining('built by samkiel') });
    expect(who.kind === 'reply' && who.keyboard?.flat().map((b) => b.text)).toEqual(['portfolio', 'github', 'linkedin']);
    expect(turn('i have a problem')).toMatchObject({ text: expect.stringContaining('08087357158') });
    expect(turn('cancel my order')).toEqual({ kind: 'cancel' });
  });

  it('saves business inquiries as leads', () => {
    expect(turn('can you build me a website for my shop')).toMatchObject({ kind: 'lead' });
  });

  it('greets in pidgin when they write pidgin', () => {
    expect(turn('how far', pcm)).toMatchObject({ kind: 'reply', text: expect.stringContaining('how far!') });
  });

  it('has many different fallback lines, never repeating one twice in a row', () => {
    const seen = new Set<string>();
    const pickFor = createPicker()(1);
    let last = '';
    for (let i = 0; i < 200; i++) {
      const reply = scriptedTurn('qwerty asdf', { lang: 'en', facts, pick: pickFor });
      const text = reply.kind === 'reply' ? reply.text : '';
      expect(text).not.toBe(last);
      last = text;
      seen.add(text);
    }
    expect(seen.size).toBeGreaterThanOrEqual(10);
  });

  it('every scripted text is lowercase (brand aside) and free of dashes and dates', () => {
    const inputs = ['hi', 'how much', 'is this legit', 'who made you', 'thanks', 'help me', 'zzz', 'build me an app', 'how far'];
    for (const lang of ['en', 'pcm'] as const) {
      for (const text of inputs) {
        for (let i = 0; i < 20; i++) {
          const reply = scriptedTurn(text, { lang, facts });
          if (reply.kind !== 'reply' && reply.kind !== 'lead') continue;
          expect(reply.text.replace(/SAMKIEL/g, '')).toBe(reply.text.replace(/SAMKIEL/g, '').toLowerCase());
          expect(reply.text).not.toMatch(/[–—]/);
          expect(reply.text).not.toMatch(/29 oct|2026/i);
        }
      }
    }
  });
});

describe('isPurchaseRequest', () => {
  it('is true for a clear request to buy now, false for questions', () => {
    for (const yes of ['i need 3 links, how much and can i pay now', 'buy one', 'i want 2 links', 'abeg i wan 2 links', 'send me a link']) {
      expect(isPurchaseRequest(yes)).toBe(true);
    }
    for (const no of ['how much', 'i want to know the price', 'what do i get', 'who made you', 'i need help']) {
      expect(isPurchaseRequest(no)).toBe(false);
    }
  });
});

describe('quantityIn', () => {
  it('reads digits and words, ignoring prices', () => {
    expect(quantityIn('i need 3')).toBe(3);
    expect(quantityIn('give me two links')).toBe(2);
    expect(quantityIn('a link please')).toBe(1);
    expect(quantityIn('is it ₦3,500?')).toBeUndefined();
    expect(quantityIn('hello')).toBeUndefined();
  });
});
