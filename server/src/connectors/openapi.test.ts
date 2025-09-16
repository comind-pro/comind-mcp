import { describe, expect, it } from 'vitest';
import { OpenApiConnector } from './openapi.js';

const spec = {
  openapi: '3.0.0',
  info: { title: 't', version: '1' },
  servers: [{ url: 'https://api.example.com' }],
  paths: {
    '/pets/{petId}': {
      get: {
        operationId: 'getPet',
        summary: 'Get a pet',
        parameters: [{ name: 'petId', in: 'path', required: true, schema: { type: 'string' } }],
      },
    },
    '/pets': {
      post: {
        operationId: 'createPet',
        requestBody: {
          content: {
            'application/json': {
              schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, tag: { type: 'string' } } },
            },
          },
        },
      },
    },
  },
};

describe('OpenApiConnector', () => {
  it('parses operations into tools', async () => {
    const c = new OpenApiConnector({ spec, baseUrl: 'https://api.example.com' });
    const tools = await c.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(['createPet', 'getPet']);
  });

  it('builds an input schema with path params required', async () => {
    const c = new OpenApiConnector({ spec });
    const getPet = (await c.listTools()).find((t) => t.name === 'getPet');
    expect(getPet?.inputSchema).toMatchObject({
      type: 'object',
      properties: { petId: { type: 'string' } },
      required: ['petId'],
    });
  });

  it('flattens requestBody properties into the input schema', async () => {
    const c = new OpenApiConnector({ spec });
    const createPet = (await c.listTools()).find((t) => t.name === 'createPet');
    const schema = createPet?.inputSchema as { properties: Record<string, unknown>; required: string[] };
    expect(Object.keys(schema.properties)).toEqual(expect.arrayContaining(['name', 'tag']));
    expect(schema.required).toContain('name');
  });

  it('reports health from a valid inline spec', async () => {
    const c = new OpenApiConnector({ spec });
    const h = await c.health();
    expect(h.ok).toBe(true);
  });
});
