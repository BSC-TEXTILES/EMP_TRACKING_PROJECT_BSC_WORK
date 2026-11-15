import { afterEach, describe, expect, it, vi } from 'vitest';
import { CoarenaClient } from '../src/services/CoarenaService.js';

const settings = { apiKey: 'test-key', baseUrl: 'https://coarena.ai/api/v1', model: 'gpt-6-luna', timeoutMs: 1000 };
afterEach(() => vi.unstubAllGlobals());

describe('Coarena integration', () => {
  it('uses the configured model and retains the reply ID for feedback', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({
      id: 'reply-123', model: settings.model,
      choices: [{ message: { content: 'Hello' }, finish_reason: 'stop' }],
    })).mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new CoarenaClient(settings);
    const reply = await client.complete([{ role: 'user', content: 'Hello' }]);
    expect(reply).toEqual({ requestId: 'reply-123', model: settings.model, content: 'Hello', finishReason: 'stop' });
    expect(fetchMock.mock.calls[0][0]).toBe(`${settings.baseUrl}/chat/completions`);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer test-key');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ model: settings.model, stream: false });
    await client.feedback({ request_id: reply.requestId, rating: 'up', tags: ['helpful'] });
    expect(fetchMock.mock.calls[1][0]).toBe(`${settings.baseUrl}/feedback`);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ request_id: 'reply-123', rating: 'up', tags: ['helpful'] });
  });

  it('rejects missing credentials and invalid feedback without network calls', async () => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    await expect(new CoarenaClient({ ...settings, apiKey: '' }).complete([{ role: 'user', content: 'Hello' }]))
      .rejects.toMatchObject({ status: 503 });
    await expect(new CoarenaClient(settings).feedback({ request_id: 'reply', rating: 'up', note: 'x'.repeat(2001) }))
      .rejects.toMatchObject({ status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('supports removing a rating', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    await new CoarenaClient(settings).feedback({ request_id: 'reply', rating: null });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).rating).toBeNull();
  });

  it.each([401, 429, 500])('sanitizes provider error %s without retrying', async (status) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('sensitive-provider-message', { status }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(new CoarenaClient(settings).complete([{ role: 'user', content: 'Hi' }]))
      .rejects.toMatchObject({ status: status === 429 ? 429 : 502 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('handles network timeouts and malformed successful replies', async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new DOMException('Timeout', 'TimeoutError'))
      .mockResolvedValueOnce(Response.json({ choices: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new CoarenaClient(settings);
    await expect(client.complete([{ role: 'user', content: 'Hi' }])).rejects.toMatchObject({ code: 'ai_unavailable' });
    await expect(client.complete([{ role: 'user', content: 'Hi' }])).rejects.toMatchObject({ code: 'ai_invalid_response' });
  });
});
