import type { Store } from './db.ts';
import type { PostgresStore } from './postgres-db.ts';

export type AppStore = Store | PostgresStore;
