import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { hashPassword, signJwt, verifyPassword } from '../lib/auth.js';
import { newId } from '../lib/id.js';

const credsBody = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post('/auth/register', async (req, reply) => {
    const { email, password } = credsBody.parse(req.body);
    const normalized = email.trim().toLowerCase();
    const [existing] = await db.select().from(users).where(eq(users.email, normalized));
    if (existing) return reply.code(409).send({ error: 'email_taken' });

    const row = {
      id: newId(),
      email: normalized,
      passwordHash: hashPassword(password),
      createdAt: new Date(),
    };
    await db.insert(users).values(row);
    return reply.code(201).send({ token: signJwt(row.id), user: { id: row.id, email: row.email } });
  });

  app.post('/auth/login', async (req, reply) => {
    const { email, password } = credsBody.parse(req.body);
    const [user] = await db.select().from(users).where(eq(users.email, email.trim().toLowerCase()));
    if (!user || !verifyPassword(password, user.passwordHash)) {
      return reply.code(401).send({ error: 'invalid_credentials' });
    }
    return { token: signJwt(user.id), user: { id: user.id, email: user.email } };
  });

  app.get('/auth/me', async (req, reply) => {
    const userId = (req as { userId?: string }).userId;
    if (!userId) return reply.code(401).send({ error: 'unauthorized' });
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    if (!user) return reply.code(401).send({ error: 'unauthorized' });
    return { id: user.id, email: user.email };
  });
}
