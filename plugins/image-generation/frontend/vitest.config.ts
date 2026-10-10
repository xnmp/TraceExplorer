import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['plugins/image-generation/frontend/**/*.test.ts'], environment: 'node' } });
