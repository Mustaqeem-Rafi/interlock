#!/usr/bin/env node
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InvariantViolation } from '@interlock/core';
import { manifestHash, type UpstreamTool } from '../proxy/upstream.js';
import { QUESTIONS, type InitAnswers } from '../init/questions.js';
import { runInit } from '../init/cli.js';
import type { AuthoringModel } from '../init/author.js';
import { MOCK_MANIFEST } from '../proxy/manifest.js';

/**
 * `interlock init` — the one place a model touches the money path.
 *
 * It touches it at authoring time only. The model turns four plain-English
 * answers into a mandate; a person reads that mandate and approves it; from
 * then on only deterministic code reads the file. That asymmetry is the whole
 * argument of the project, so this command is deliberately shaped to make
 * skipping the human impossible: there is no --yes, and nothing is written
 * unless the answer at the prompt is exactly "yes".
 */

const VERSION = '0.1.0';

const HELP = `interlock init ${VERSION}

Draft a mandate from four plain-English answers, then require a human to
approve it before it can be used.

USAGE
  interlock init [--upstream-command "<cmd>"] [--out <path>]

OPTIONS
  --upstream-command <c>  Spawn the real upstream MCP server to read its tool
                          manifest, e.g. "docker run -i --rm razorpay/mcp".
                          Omit to author against the built-in mock manifest.
  --out <path>            Where to write the mandate. Default ./mandate.yaml
  --merchant <id>         Merchant account id. Default acc_DEMO000001
  --agent <id>            Agent identity. Default agent_support_bot
  --model <name>          Authoring model. Default gpt-4o-mini
  --help, --version

ENVIRONMENT
  OPENAI_API_KEY          required — the model drafts the policy

The model drafts. A person approves. After that, nothing consults a model.
`;

/**
 * A minimal OpenAI client, used once, at authoring time.
 *
 * Deliberately not shared with anything on the money path: there is no code
 * path from a decision to this function, and keeping it in the init binary is
 * how that stays visibly true.
 */
function openAiAuthor(apiKey: string, model: string): AuthoringModel {
  return {
    async complete(prompt: string): Promise<string> {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          temperature: 0,
          messages: [
            {
              role: 'system',
              content:
                'You author machine-checkable payment mandates. Reply with YAML only, no prose ' +
                'and no code fence. Every money value is an integer in minor units.',
            },
            { role: 'user', content: prompt },
          ],
        }),
      });
      if (!response.ok) {
        throw new InvariantViolation(
          'init.model',
          `the authoring model returned ${String(response.status)}: ${await response.text()}`,
        );
      }
      const body = (await response.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      const text = body.choices?.[0]?.message?.content;
      if (typeof text !== 'string' || text === '') {
        throw new InvariantViolation('init.model', 'the authoring model returned no content');
      }
      return text;
    },
  };
}

async function readManifest(command: string | undefined): Promise<readonly UpstreamTool[]> {
  if (command === undefined) return MOCK_MANIFEST;
  const [head, ...rest] = command.split(' ').filter((p) => p !== '');
  if (head === undefined) throw new InvariantViolation('init.upstream', '--upstream-command was empty');
  const client = new Client({ name: 'interlock-init', version: VERSION }, { capabilities: {} });
  await client.connect(new StdioClientTransport({ command: head, args: rest }));
  try {
    const listed = await client.listTools();
    return listed.tools as unknown as readonly UpstreamTool[];
  } finally {
    await client.close();
  }
}

export async function main(argv: readonly string[]): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP);
    return 0;
  }
  if (argv.includes('--version')) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };

  const apiKey = process.env['OPENAI_API_KEY'];
  if (apiKey === undefined || apiKey === '') {
    process.stderr.write(
      'OPENAI_API_KEY is not set. init is the one command that needs a model, ' +
        'because it is the one place a model is allowed to act.\n',
    );
    return 2;
  }

  const out = resolve(flag('out') ?? 'mandate.yaml');
  if (existsSync(out)) {
    process.stderr.write(`${out} already exists. Move it aside first.\n`);
    return 2;
  }

  const tools = await readManifest(flag('upstream-command'));
  process.stdout.write(
    `Read ${String(tools.length)} tool(s) from upstream: ${tools.map((t) => t.name).join(', ')}\n\n`,
  );

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answers: Record<string, string> = {};
    for (const question of QUESTIONS) {
      process.stdout.write(`${question.help}\n`);
      const value = (await rl.question(`${question.prompt}\n> `)).trim();
      if (value === '') {
        process.stderr.write('An empty answer cannot be turned into a policy. Stopping.\n');
        return 2;
      }
      answers[question.key] = value;
      process.stdout.write('\n');
    }

    process.stdout.write('Drafting a mandate...\n\n');

    const result = await runInit({
      upstream: flag('upstream-command') ?? 'built-in mock rail',
      answers: answers as unknown as InitAnswers,
      model: openAiAuthor(apiKey, flag('model') ?? 'gpt-4o-mini'),
      manifest: { sha256: manifestHash(tools), tools },
      merchantId: flag('merchant') ?? 'acc_DEMO000001',
      agentId: flag('agent') ?? 'agent_support_bot',
      confirm: async (_yaml, warnings) => {
        if (warnings.length > 0) {
          process.stdout.write('\nThings worth a second look:\n');
          for (const warning of warnings) process.stdout.write(`  - ${warning}\n`);
        }
        // Typing the whole word, not pressing enter on a default. This mandate
        // is standing authority to move real money.
        const answer = await rl.question('\nApprove this mandate? Type "yes" to accept: ');
        return answer.trim().toLowerCase() === 'yes';
      },
      write: (yaml) => {
        writeFileSync(out, yaml, 'utf8');
        return out;
      },
      print: (line) => process.stdout.write(`${line}\n`),
    });

    if (!result.approved) return 1;
    process.stdout.write(
      `\nWrote ${result.path ?? out}\n` +
        `Run it with:  interlock-mcp --mandate ${result.path ?? out}\n`,
    );
    return 0;
  } finally {
    rl.close();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => {
      if (code !== 0) process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
