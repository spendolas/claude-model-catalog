'use strict';

// One entry for both halves. Claude Hub requires this file; ESM consumers
// (Gaffer) get the same objects through index.mjs.

const catalog = require('./catalog.cjs');
const contract = require('./cli-contract.cjs');

module.exports = {
  // catalog.cjs: live model discovery
  MODEL_CACHE_TTL_MS: catalog.MODEL_CACHE_TTL_MS,
  EFFORT_LEVELS: catalog.EFFORT_LEVELS,
  parseOauthBlob: catalog.parseOauthBlob,
  versionLabel: catalog.versionLabel,
  catalogFromModels: catalog.catalogFromModels,
  resolveModel: catalog.resolveModel,
  readCredentialFromEnv: catalog.readCredentialFromEnv,
  accountIdFromEnv: catalog.accountIdFromEnv,
  suggestableFamilies: catalog.suggestableFamilies,
  createModelCatalog: catalog.createModelCatalog,
  // cli-contract.cjs: `claude -p` turn classifier and CLI version checks
  LAST_VERIFIED: contract.LAST_VERIFIED,
  NEWER_PATCH_TOLERANCE: contract.NEWER_PATCH_TOLERANCE,
  UNRECOGNIZED_MODEL_TAG: contract.UNRECOGNIZED_MODEL_TAG,
  versionDetail: contract.versionDetail,
  versionStatus: contract.versionStatus,
  versionNotice: contract.versionNotice,
  newTurnState: contract.newTurnState,
  observe: contract.observe,
  classify: contract.classify,
  classifyJsonResult: contract.classifyJsonResult,
  defaultCopy: contract.defaultCopy,
  userMessage: contract.userMessage
};
