// `npm run server` runs TypeScript through tsx, and worker threads do not inherit it: the room
// worker starts here, registers tsx and then loads roomWorker.ts.

import { register } from 'tsx/esm/api';

register();
await import('./roomWorker.ts');
