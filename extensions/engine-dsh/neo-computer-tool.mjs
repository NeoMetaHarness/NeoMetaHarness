import { defineTool } from '@deepseek-ai/dsh-tools';

export const name = 'neo-computer-tool';
export const inject = ['tools'];

export function apply(ctx) {
  if (!process.env.NEO_COMPUTER_ENDPOINT || !process.env.NEO_COMPUTER_TOKEN) return;

  const tool = defineTool({
    name: 'neo_computer',
    description: 'Operate the computer assigned to this DSH session through Neo Gateway.',
    parameters: {
      action: { type: 'string', required: true, enum: ['click', 'capture', 'type', 'key', 'scroll'] },
      x: { type: 'number' },
      y: { type: 'number' },
      text: { type: 'string' },
      keys: { type: 'string' },
      direction: { type: 'string' },
      amount: { type: 'number' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          capture: { type: 'object', additionalProperties: false,
            properties: { png: { type: 'string', required: true },
              width: { type: 'number', required: true }, height: { type: 'number', required: true } } },
        },
      },
      render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }],
    },
    async execute(args) {
      const response = await fetch(process.env.NEO_COMPUTER_ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.NEO_COMPUTER_TOKEN}`,
          'Content-Type': 'application/json' },
        body: JSON.stringify(args),
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error(`Neo computer action rejected (${response.status})`);
      return response.json();
    },
  });
  ctx.effect(() => ctx.tools.register(tool));
}
