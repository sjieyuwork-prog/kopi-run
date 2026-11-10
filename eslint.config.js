import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules', '.wrangler', 'demo'] },
  js.configs.recommended,
  { files: ['public/**/*.js'], languageOptions: { globals: globals.browser } },
  { files: ['src/**/*.js'], languageOptions: { globals: globals.serviceworker } },
  { files: ['test/**/*.js', '*.js'], languageOptions: { globals: globals.node } },
  { rules: { 'consistent-return': 'error', eqeqeq: 'error', 'no-alert': 'warn' } },
];
