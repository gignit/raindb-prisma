import { defineConfig } from 'tsup';

export default defineConfig([
  // Library entry: ESM + CJS + types.
  {
    entry: ['src/index.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    clean: true,
    treeshake: true,
    splitting: false,
    outExtension({ format }) {
      return { js: format === 'cjs' ? '.cjs' : '.js' };
    },
  },
  // Executables: the Prisma generator + the publish CLI. Built as CJS
  // because @prisma/generator-helper is CommonJS and uses require() for node
  // builtins (child_process), which breaks when bundled into ESM. CJS output
  // keeps require working; the .js bins are run via `node`.
  {
    entry: ['src/generator/index.ts', 'src/cli/index.ts'],
    format: ['cjs'],
    dts: false,
    sourcemap: true,
    clean: false,
    treeshake: true,
    splitting: false,
    external: ['@prisma/generator-helper', '@prisma/generator'],
    banner: { js: '#!/usr/bin/env node' },
    outExtension() {
      return { js: '.cjs' };
    },
  },
]);
