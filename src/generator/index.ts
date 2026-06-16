/**
 * The @raindb/prisma generator.
 *
 * Registered in schema.prisma as:
 *
 *   generator raindb {
 *     provider = "raindb-prisma-generator"
 *     output   = "../raindb/formations"
 *   }
 *
 * On `prisma generate` it walks the datamodel and writes, under `output`:
 *   formations/<id>/config.json
 *   formations/<id>/schemas/v<N>.json
 *   raindb-model-map.json          (pass to new PrismaRainDB({ models }))
 *
 * It does NOT publish to RainDB -- publishing is a separate, explicit step
 * (the "migration" replacement) so generation stays side-effect-free. See
 * the `publish` CLI.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { generatorHandler } from '@prisma/generator-helper';
import type { GeneratorOptions } from '@prisma/generator';
import { buildFromDatamodel } from './build.js';

const GENERATOR_NAME = 'raindb-prisma-generator';

generatorHandler({
  onManifest() {
    return {
      version: '0.1.0',
      defaultOutput: 'raindb/formations',
      prettyName: 'RainDB formations',
    };
  },

  async onGenerate(options: GeneratorOptions) {
    const outputDir = options.generator.output?.value;
    if (!outputDir) {
      throw new Error(`${GENERATOR_NAME}: no output path configured`);
    }

    const models = options.dmmf.datamodel.models;
    const result = buildFromDatamodel(models);

    const allWarnings: string[] = [];

    for (const f of result.formations) {
      const dir = join(outputDir, f.formationId);
      await mkdir(join(dir, 'schemas'), { recursive: true });
      await writeJSON(join(dir, 'config.json'), f.config);
      await writeJSON(join(dir, 'schemas', `v${f.schemaVersion}.json`), f.schema);
      for (const w of f.warnings) allWarnings.push(w);
    }

    // The model-map the adapter consumes at runtime.
    await writeJSON(join(outputDir, 'raindb-model-map.json'), result.modelMap);

    if (allWarnings.length > 0) {
      // Generators surface diagnostics on stderr; Prisma shows them.
      for (const w of allWarnings) {
        process.stderr.write(`[raindb] warning: ${w}\n`);
      }
    }
  },
});

async function writeJSON(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', 'utf8');
}
