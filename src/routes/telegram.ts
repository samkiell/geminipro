import type { FastifyPluginAsync } from 'fastify';
import { webhookCallback, type Bot } from 'grammy';

export interface TelegramRouteOptions {
  bot: Bot;
  /** setWebhook's secret_token; Telegram sends it back in X-Telegram-Bot-Api-Secret-Token. */
  secretToken: string;
}

export const telegramRoutes: FastifyPluginAsync<TelegramRouteOptions> = async (app, { bot, secretToken }) => {
  // grammY answers 401 when the secret header is missing or wrong. A slow agent turn must not make
  // Telegram retry the update, so answer after 9s and let the handler finish in the background.
  const handle = webhookCallback(bot, 'fastify', { secretToken, onTimeout: 'return', timeoutMilliseconds: 9_000 });
  app.post('/telegram/webhook', handle);
};
