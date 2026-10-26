import { defineWorkspace } from 'vitest/config'

export default defineWorkspace([
  'packages/core/vitest.config.ts',
  'packages/cli/vitest.config.ts',
  'packages/webapp/vitest.config.ts',
  'packages/vscode/vitest.config.ts',
  'packages/webview/vitest.config.ts',
])
