/**
 * raindb-prisma CLI -- the "migration" replacement.
 *
 * RainDB has no destructive DDL. Schema changes are formation publishes. This
 * CLI publishes the formations emitted by the generator to a RainDB tenant:
 *
 *   raindb-prisma publish \
 *     --dir raindb/formations \
 *     --endpoint https://api.raindb.io/graphql \
 *     --api-key  rdb_...
 *
 * It reads each formations/<id>/config.json + schemas/v<N>.json and calls the
 * `publishFormation` mutation. Publishing a new schema version of an existing
 * formation is non-destructive: old droplets keep their version; the new
 * compatible schema is added alongside (RainDB's schema-versioning model).
 *
 * Flags:
 *   --dir       directory of generated formations (default: raindb/formations)
 *   --endpoint  RainDB GraphQL endpoint (or env RAINDB_ENDPOINT)
 *   --api-key   RainDB API key (or env RAINDB_API_KEY)
 *   --dry-run   print what would be published, do not call the API
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

interface Args {
  command: string;
  dir: string;
  endpoint: string | undefined;
  apiKey: string | undefined;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    command: argv[0] ?? 'help',
    dir: 'raindb/formations',
    dryRun: false,
    endpoint: process.env['RAINDB_ENDPOINT'],
    apiKey: process.env['RAINDB_API_KEY'],
  };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--dir':
        args.dir = argv[++i]!;
        break;
      case '--endpoint':
        args.endpoint = argv[++i]!;
        break;
      case '--api-key':
        args.apiKey = argv[++i]!;
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
    }
  }
  return args;
}

const PUBLISH_MUTATION = /* GraphQL */ `
  mutation Publish($formationId: String!, $config: JSON!, $schema: JSON!, $v: Int!) {
    publishFormation(formationId: $formationId, config: $config, schema: $schema, schemaVersion: $v) {
      formationId
      schemaVersion
    }
  }
`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.command !== 'publish') {
    printHelp();
    process.exit(args.command === 'help' ? 0 : 1);
  }

  const formations = await collectFormations(args.dir);
  if (formations.length === 0) {
    process.stderr.write(`No formations found under ${args.dir}\n`);
    process.exit(1);
  }

  process.stdout.write(`Found ${formations.length} formation(s) in ${args.dir}:\n`);
  for (const f of formations) {
    process.stdout.write(`  - ${f.formationId} (v${f.schemaVersion})\n`);
  }

  if (args.dryRun) {
    process.stdout.write('\n--dry-run: not publishing.\n');
    return;
  }

  if (!args.endpoint || !args.apiKey) {
    process.stderr.write(
      'Error: --endpoint and --api-key (or RAINDB_ENDPOINT / RAINDB_API_KEY) are required to publish.\n',
    );
    process.exit(1);
  }

  for (const f of formations) {
    await publish(args.endpoint, args.apiKey, f);
    process.stdout.write(`  published ${f.formationId} (v${f.schemaVersion})\n`);
  }
  process.stdout.write('Done.\n');
}

interface FormationArtifact {
  formationId: string;
  schemaVersion: number;
  config: unknown;
  schema: unknown;
}

async function collectFormations(dir: string): Promise<FormationArtifact[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const out: FormationArtifact[] = [];
  for (const name of entries) {
    const cfgPath = join(dir, name, 'config.json');
    try {
      const s = await stat(cfgPath);
      if (!s.isFile()) continue;
    } catch {
      continue;
    }
    const config = JSON.parse(await readFile(cfgPath, 'utf8')) as Record<string, unknown>;
    const formationId = (config['formationId'] as string) ?? name;
    const schemaVersion = (config['maxSchemaVersion'] as number) ?? 1;
    const schema = JSON.parse(
      await readFile(join(dir, name, 'schemas', `v${schemaVersion}.json`), 'utf8'),
    );
    out.push({ formationId, schemaVersion, config, schema });
  }
  return out;
}

async function publish(
  endpoint: string,
  apiKey: string,
  f: FormationArtifact,
): Promise<void> {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      query: PUBLISH_MUTATION,
      variables: {
        formationId: f.formationId,
        config: f.config,
        schema: f.schema,
        v: f.schemaVersion,
      },
    }),
  });
  if (!res.ok) {
    throw new Error(`publish ${f.formationId}: HTTP ${res.status}: ${await res.text()}`);
  }
  const json = (await res.json()) as { errors?: Array<{ message: string }> };
  if (json.errors && json.errors.length > 0) {
    throw new Error(`publish ${f.formationId}: ${json.errors.map((e) => e.message).join('; ')}`);
  }
}

function printHelp(): void {
  process.stdout.write(
    [
      'raindb-prisma -- publish generated RainDB formations (the migration replacement)',
      '',
      'Usage:',
      '  raindb-prisma publish [--dir <dir>] [--endpoint <url>] [--api-key <key>] [--dry-run]',
      '',
      'Env: RAINDB_ENDPOINT, RAINDB_API_KEY',
      '',
    ].join('\n'),
  );
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
