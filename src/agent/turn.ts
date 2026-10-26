import type { Db } from '../db/client.js';
import { getOfferText } from '../services/settings.js';
import type { Logger } from '../util/logger.js';
import { runAgent, type AgentReply } from './agent.js';
import { buyerContext } from './buyer.js';
import { loadHistory } from './history.js';
import type { ModelPool } from './llm.js';
import { systemPrompt, type PromptFacts } from './prompt.js';
import type { ToolContext, ToolSet } from './tools.js';

/** One agent turn with everything it needs: history, offer text and what we know of the buyer. */
export function createAgentTurn(deps: { db: Db; pool: ModelPool; tools: ToolSet; facts: PromptFacts; logger: Logger }) {
  return {
    /** False when no model can take a call right now: go straight to the scripted reply. */
    available: () => deps.pool.available,
    async reply(input: { userText: string; ctx: ToolContext }): Promise<AgentReply> {
      const { telegramId } = input.ctx;
      const [history, offerText, buyer] = await Promise.all([
        loadHistory(deps.db, telegramId),
        getOfferText(deps.db),
        buyerContext(deps.db, telegramId),
      ]);
      return runAgent(
        { pool: deps.pool, tools: deps.tools, logger: deps.logger },
        { systemPrompt: systemPrompt(deps.facts, { offerText, buyer }), history, userText: input.userText, ctx: input.ctx },
      );
    },
  };
}

export type AgentTurn = ReturnType<typeof createAgentTurn>;
