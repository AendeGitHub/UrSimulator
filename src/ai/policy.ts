// The trained AI driver (src/ai/policy.json, made by `npm run train:bot`).

import policy from './policy.json';
import { networkBrain, type Brain } from './Bot';
import type { MlpData } from './mlp';

export const aiBrain = (): Brain => networkBrain(policy.net as MlpData);
