'use strict';

// CommonJS entry (Claude Hub requires this file); ESM consumers (Gaffer) get
// the same objects through index.mjs. Fetch-only: the claude -p turn
// classifier lives in its own repo, claude-cli-contract.

const catalog = require('./catalog.cjs');

module.exports = {
  MODEL_CACHE_TTL_MS: catalog.MODEL_CACHE_TTL_MS,
  EFFORT_LEVELS: catalog.EFFORT_LEVELS,
  parseOauthBlob: catalog.parseOauthBlob,
  versionLabel: catalog.versionLabel,
  catalogFromModels: catalog.catalogFromModels,
  resolveModel: catalog.resolveModel,
  readCredentialFromEnv: catalog.readCredentialFromEnv,
  accountIdFromEnv: catalog.accountIdFromEnv,
  createModelCatalog: catalog.createModelCatalog
};
