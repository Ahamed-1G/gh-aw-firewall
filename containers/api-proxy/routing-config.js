'use strict';

const { createRoutingError } = require('./routing-errors');
const { normalizePolicyList, ROUTING_EFFORTS } = require('./routing-candidates');

const ROUTING_GOALS = new Set(['cost', 'cost-speed']);
const ROUTING_MODES = new Set(['economy', 'balanced', 'robust', 'auto']);
const ROUTING_PROVIDERS = new Set(['copilot', 'openai', 'anthropic']);

function configurationError(detail) {
  return createRoutingError('routing_configuration_error', detail);
}

function requireClosedObject(value, path, requiredKeys, allowedKeys = requiredKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw configurationError(`${path} must be an object`);
  }

  const keys = Object.keys(value);
  const unknown = keys.find(key => !allowedKeys.includes(key));
  if (unknown) {
    throw configurationError(`${path}.${unknown} is not supported`);
  }
  const missing = requiredKeys.find(key => !Object.hasOwn(value, key));
  if (missing) {
    throw configurationError(`${path}.${missing} is required`);
  }
}

function requireNonblankString(value, path) {
  if (typeof value !== 'string' || !value.trim()) {
    throw configurationError(`${path} must be a nonblank string`);
  }
  return value;
}

// Invalid efforts are rejected rather than dropped, so a typo cannot widen or empty the constraint silently.
function parseAllowedEfforts(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw configurationError('routing.allowedEfforts must be a non-empty array');
  }
  const efforts = [];
  for (const [index, effort] of value.entries()) {
    if (!ROUTING_EFFORTS.has(effort)) {
      throw configurationError(`routing.allowedEfforts[${index}] is not a supported effort`);
    }
    if (efforts.includes(effort)) {
      throw configurationError(`routing.allowedEfforts[${index}] is a duplicate effort`);
    }
    efforts.push(effort);
  }
  return efforts;
}

function parseRoutingConfig(raw) {
  if (raw === undefined) return null;
  if (typeof raw !== 'string' || !raw.trim()) {
    throw configurationError('AWF_ROUTING_CONFIG must contain JSON');
  }

  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw configurationError('AWF_ROUTING_CONFIG must contain valid JSON');
  }

  requireClosedObject(value, 'routing', ['objective', 'task'],
    ['objective', 'task', 'provider', 'candidateModels', 'allowedEfforts']);
  requireClosedObject(value.objective, 'routing.objective', ['goal', 'mode']);
  requireClosedObject(value.task, 'routing.task', ['conversationFile']);

  if (!ROUTING_GOALS.has(value.objective.goal)) {
    throw configurationError('routing.objective.goal is not supported');
  }
  if (!ROUTING_MODES.has(value.objective.mode)) {
    throw configurationError('routing.objective.mode is not supported');
  }
  const provider = value.provider === undefined ? 'copilot' : value.provider;
  if (!ROUTING_PROVIDERS.has(provider)) {
    throw configurationError('routing.provider is not supported');
  }
  let candidateModels;
  if (Object.hasOwn(value, 'candidateModels')) {
    if (!Array.isArray(value.candidateModels) || value.candidateModels.length === 0) {
      throw configurationError('routing.candidateModels must be a non-empty array');
    }
    candidateModels = normalizePolicyList(value.candidateModels, 'routing.candidateModels');
  }
  let allowedEfforts;
  if (Object.hasOwn(value, 'allowedEfforts')) {
    allowedEfforts = parseAllowedEfforts(value.allowedEfforts);
  }

  const config = {
    provider,
    ...(candidateModels ? { candidateModels: Object.freeze(candidateModels) } : {}),
    ...(allowedEfforts ? { allowedEfforts: Object.freeze(allowedEfforts) } : {}),
    objective: Object.freeze({
      goal: value.objective.goal,
      mode: value.objective.mode,
    }),
    task: Object.freeze({
      conversationFile: requireNonblankString(
        value.task.conversationFile,
        'routing.task.conversationFile',
      ),
    }),
  };
  return Object.freeze(config);
}

module.exports = {
  parseRoutingConfig,
};
