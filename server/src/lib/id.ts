import { customAlphabet, nanoid } from 'nanoid';

export const newId = (): string => nanoid(16);

// API keys: readable prefix + secret body.
const keyBody = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789', 40);
export const newApiKey = (): { token: string; prefix: string } => {
  const prefix = customAlphabet('abcdefghijkmnopqrstuvwxyz23456789', 8)();
  return { token: `cmd_${prefix}_${keyBody()}`, prefix };
};

export function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'item'
  );
}
