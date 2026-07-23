const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, '../..');

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(projectRoot);

// Watch the monorepo root so workspace packages (e.g. @mobile-claude/protocol) hot-reload.
config.watchFolders = [monorepoRoot];

// Resolve modules from the app and the monorepo root (pnpm + workspace packages).
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(monorepoRoot, 'node_modules'),
];

// Prefer the app's own node_modules; avoid walking up into unrelated packages.
config.resolver.disableHierarchicalLookup = true;

module.exports = config;
