import Fastify from 'fastify';

// A stand-in for Groq's OpenAI compatible chat API, for tests that go through the real groq-sdk.
// Each request is answered by `respond`; every request is recorded so tests can count model calls.

export interface GroqRequest {
  model: string;
  messages: { role: string; content: string }[];
  temperature?: number;
  response_format?: { type: string };
  tools?: unknown;
  [key: string]: unknown;
}

export type GroqReply =
  /** A completion whose message content is this string (or this object, as JSON). */
  | { content: string | Record<string, unknown>; usage?: { prompt_tokens: number; completion_tokens: number } }
  | { status: number; headers?: Record<string, string>; body?: unknown }
  /** Holds the reply this long first (to trigger client timeouts). */
  | { delayMs: number; then: GroqReply };

export interface MockGroq {
  url: string;
  requests: GroqRequest[];
  /** Change how requests are answered. Default: a chat decision. */
  respond: (handler: (req: GroqRequest) => GroqReply) => void;
  close: () => Promise<void>;
}

export const decisionJson = (decision: Record<string, unknown>) => ({
  intent: 'chat',
  quantity: null,
  order_no: null,
  topic: null,
  summary: null,
  reply: 'hi! how can i help?',
  ...decision,
});

export async function startMockGroq(onRequest?: (req: GroqRequest) => void): Promise<MockGroq> {
  const app = Fastify({ logger: false });
  const requests: GroqRequest[] = [];
  let handler: (req: GroqRequest) => GroqReply = () => ({ content: decisionJson({}) });

  app.post('/openai/v1/chat/completions', async (req, reply) => {
    const body = req.body as GroqRequest;
    requests.push(body);
    onRequest?.(body);
    let answer = handler(body);
    while ('delayMs' in answer) {
      const { delayMs, then } = answer;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      answer = then;
    }
    if ('status' in answer) {
      for (const [k, v] of Object.entries(answer.headers ?? {})) reply.header(k, v);
      return reply.code(answer.status).send(answer.body ?? { error: { message: `mock ${answer.status}`, type: 'mock' } });
    }
    const content = typeof answer.content === 'string' ? answer.content : JSON.stringify(answer.content);
    const usage = answer.usage ?? { prompt_tokens: 700, completion_tokens: 60 };
    return reply
      .header('x-ratelimit-remaining-tokens', '7000')
      .header('x-ratelimit-reset-tokens', '7.5s')
      .send({
        id: 'chatcmpl-mock',
        object: 'chat.completion',
        created: 0,
        model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens },
      });
  });

  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  return {
    url: address,
    requests,
    respond: (h) => (handler = h),
    close: () => app.close(),
  };
}
