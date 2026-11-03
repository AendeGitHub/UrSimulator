// Worker threads don't inherit tsx from `npm run train:bot`: this starter registers it and then
// loads the TypeScript worker.

import { register } from 'tsx/esm/api';

register();
await import('./bot-worker.ts');
