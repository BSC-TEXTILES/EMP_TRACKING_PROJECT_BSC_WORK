import { z } from 'zod';
import { config } from '../config.js';
import { ApiError, parseBody } from '../lib/http.js';

const messagesSchema = z.array(z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string().min(1).max(32_000),
})).min(1).max(50);

const feedbackSchema = z.object({
  request_id: z.string().trim().min(1).max(200),
  rating: z.enum(['up', 'down']).nullable(),
  tags: z.array(z.enum([
    'correct', 'helpful', 'fast', 'wrong', 'unhelpful', 'refused', 'too_slow',
    'bad_format', 'unsafe', 'concise', 'thorough', 'creative', 'good_code',
    'followed_instructions', 'made_up', 'incomplete', 'too_long', 'off_topic',
    'bad_code', 'ignored_instructions',
  ])).max(20).optional(),
  note: z.string().max(2000).optional(),
});

const completionSchema = z.object({
  id: z.string().min(1),
  model: z.string(),
  choices: z.array(z.object({
    message: z.object({ content: z.string().nullable() }),
    finish_reason: z.string().nullable(),
  })).min(1),
});

export type CoarenaMessage = z.infer<typeof messagesSchema>[number];
export type CoarenaFeedback = z.infer<typeof feedbackSchema>;

/** Server-only integration. Callers decide which user-provided text to send. */
export class CoarenaClient {
  constructor(private readonly settings = config.coarena) {}

  private async post(endpoint: string, body: unknown): Promise<Response> {
    if (!this.settings.apiKey || this.settings.apiKey === '<your key>') {
      throw new ApiError(503, 'Set COARENA_API_KEY on the server to enable AI.', 'ai_not_configured');
    }
    let response: Response;
    try {
      response = await fetch(`${this.settings.baseUrl}/${endpoint}`, {
        method: 'POST',
        redirect: 'error',
        headers: { Authorization: `Bearer ${this.settings.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.settings.timeoutMs),
      });
    } catch {
      throw new ApiError(502, 'Coarena could not be reached or timed out.', 'ai_unavailable');
    }
    if (!response.ok) {
      // Do not expose provider response bodies, credentials or submitted text.
      await response.body?.cancel();
      if (response.status === 429) throw ApiError.tooMany('Coarena usage limit reached. Try again later.');
      throw new ApiError(502, 'Coarena rejected the request.', 'ai_provider_error');
    }
    return response;
  }

  async complete(messages: CoarenaMessage[]) {
    const validated = parseBody(messagesSchema, messages);
    const response = await this.post('chat/completions', {
      model: this.settings.model, messages: validated, stream: false, max_completion_tokens: 2048,
    });
    try {
      const reply = completionSchema.parse(await response.json());
      return {
        requestId: reply.id, model: reply.model,
        content: reply.choices[0].message.content,
        finishReason: reply.choices[0].finish_reason,
      };
    } catch {
      throw new ApiError(502, 'Coarena returned an invalid or incomplete response.', 'ai_invalid_response');
    }
  }

  async feedback(input: CoarenaFeedback): Promise<void> {
    const response = await this.post('feedback', parseBody(feedbackSchema, input));
    await response.body?.cancel();
  }
}

export const CoarenaService = new CoarenaClient();
