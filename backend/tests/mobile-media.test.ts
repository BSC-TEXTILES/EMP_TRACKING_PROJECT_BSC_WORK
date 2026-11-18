import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/index.js';
import { closePool } from '../src/db/index.js';

/** Mobile app media links (?mt=) for images, videos, downloads and exports. */

const ORIGIN = 'capacitor://localhost';
let app: Express;

async function mobileSession() {
  const res = await request(app).post('/api/auth/mobile/login').set('Origin', ORIGIN)
    .send({ identifier: 'gagan.cb@bsctextiles.in', password: 'Workforce@2026' });
  expect(res.status).toBe(200);
  return res.body as { accessToken: string; refreshToken: string };
}

beforeAll(() => {
  app = createApp();
});
afterAll(closePool);

describe('media tokens', () => {
  it('opens file downloads and exports, and nothing else', async () => {
    const session = await mobileSession();
    const auth = `Bearer ${session.accessToken}`;
    const minted = await request(app).post('/api/auth/mobile/media-token').set('Origin', ORIGIN).set('Authorization', auth);
    expect(minted.status).toBe(200);
    const mt = minted.body.token as string;
    expect(minted.body.expiresAt).toBeGreaterThan(Date.now() + 50 * 60_000);

    const upload = await request(app).post('/api/files/upload').set('Origin', ORIGIN).set('Authorization', auth)
      .attach('file', Buffer.from('hello from the phone'), { filename: 'note.txt', contentType: 'text/plain' });
    expect(upload.status).toBeLessThan(300);
    const fileId = upload.body.id as number;

    const file = await request(app).get(`/api/files/${fileId}?download=1&mt=${encodeURIComponent(mt)}`);
    expect(file.status).toBe(200);
    expect(file.text).toBe('hello from the phone');
    expect(file.headers['referrer-policy']).toBe('no-referrer');

    const exported = await request(app).get(`/api/exports?type=attendance&format=csv&mt=${encodeURIComponent(mt)}`);
    expect(exported.status).toBe(200);

    // Not a general-purpose credential.
    expect((await request(app).get(`/api/auth/me?mt=${encodeURIComponent(mt)}`)).status).toBe(401);
    expect((await request(app).get(`/api/files/chunked/abc?mt=${encodeURIComponent(mt)}`)).status).toBe(401);
    expect((await request(app).delete(`/api/files/${fileId}?mt=${encodeURIComponent(mt)}`)).status).toBe(401);
    expect((await request(app).get('/api/auth/me').set('Authorization', `Bearer ${mt}`)).status).toBe(401);
    expect((await request(app).get(`/api/files/${fileId}?mt=not-a-token`)).status).toBe(401);

    // Dies with the session.
    await request(app).post('/api/auth/mobile/logout').set('Origin', ORIGIN).send({ refreshToken: session.refreshToken });
    expect((await request(app).get(`/api/files/${fileId}?mt=${encodeURIComponent(mt)}`)).status).toBe(401);
  });

  it('is not issued to a cookie (website) session', async () => {
    const web = await request(app).post('/api/auth/login').set('Origin', 'http://localhost:5173')
      .send({ identifier: 'gagan.cb@bsctextiles.in', password: 'Workforce@2026' });
    const cookies = (web.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
    const res = await request(app).post('/api/auth/mobile/media-token').set('Origin', 'http://localhost:5173').set('Cookie', cookies);
    expect(res.status).toBe(403);
  });
});
