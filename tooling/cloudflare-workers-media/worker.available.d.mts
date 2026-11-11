import type { createMediaWorker } from './worker.mjs';

declare const worker: ReturnType<typeof createMediaWorker>;
export default worker;
