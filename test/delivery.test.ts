import { describe, expect, it } from 'vitest';
import { delayedMessage, linksMessage } from '../src/services/delivery.js';

const support = '08087357158';
const link = (n: number) => `https://one.google.com/activate/${n}`;

describe('linksMessage', () => {
  it('one link uses the PRD template', () => {
    expect(
      linksMessage({ links: [{ number: 1, link: link(1) }], quantity: 1, first: true, remaining: 0, supportWhatsapp: support }),
    ).toBe(
      [
        'payment confirmed.',
        'here is your link:',
        link(1),
        '',
        'open it, sign in to the google account you want it on, and activate. it runs for 18 months from activation.',
        'activate it now, the offer is ending soon.',
        'any issue, whatsapp 08087357158',
      ].join('\n'),
    );
  });

  it('bulk orders get a numbered list', () => {
    const text = linksMessage({
      links: [1, 2, 3].map((n) => ({ number: n, link: link(n) })),
      quantity: 3,
      first: true,
      remaining: 0,
      supportWhatsapp: support,
    });
    expect(text).toContain(`here are your 3 links:\n1. ${link(1)}\n2. ${link(2)}\n3. ${link(3)}\n`);
    expect(text).toContain('activate them now');
    expect(text).not.toContain('on the way');
  });

  it('a partial first delivery says how many are coming, keeping order numbers', () => {
    const text = linksMessage({
      links: [
        { number: 1, link: link(1) },
        { number: 3, link: link(3) },
      ],
      quantity: 3,
      first: true,
      remaining: 1,
      supportWhatsapp: support,
    });
    expect(text).toContain(`here are 2 of your 3 links:\n1. ${link(1)}\n3. ${link(3)}`);
    expect(text).toContain('the other link is on the way and will come here shortly.');
  });

  it('a follow up sends only the new links', () => {
    const rest = linksMessage({ links: [{ number: 2, link: link(2) }], quantity: 3, first: false, remaining: 0, supportWhatsapp: support });
    expect(rest).toContain(`here is the rest of your order:\n2. ${link(2)}`);
    expect(rest).not.toContain('payment confirmed');

    const more = linksMessage({ links: [{ number: 2, link: link(2) }], quantity: 4, first: false, remaining: 2, supportWhatsapp: support });
    expect(more).toContain('here is more of your order:');
    expect(more).toContain('the other 2 links are on the way');
  });

  it('never uses em or en dashes and always gives the support number', () => {
    const texts = [
      linksMessage({ links: [{ number: 1, link: link(1) }], quantity: 1, first: true, remaining: 0, supportWhatsapp: support }),
      linksMessage({ links: [{ number: 1, link: link(1) }], quantity: 5, first: true, remaining: 4, supportWhatsapp: support }),
      delayedMessage({ quantity: 1, supportWhatsapp: support }),
      delayedMessage({ quantity: 3, supportWhatsapp: support }),
    ];
    for (const text of texts) {
      expect(text).not.toMatch(/[–—]/);
      expect(text).toContain(support);
    }
  });
});

describe('delayedMessage', () => {
  it('reassures without links and without asking to pay again', () => {
    expect(delayedMessage({ quantity: 2, supportWhatsapp: support })).toBe(
      [
        'payment confirmed. your links are taking a little longer than usual.',
        "we're on it and will send them here, no need to pay again.",
        'if you need help, whatsapp 08087357158',
      ].join('\n'),
    );
  });
});
