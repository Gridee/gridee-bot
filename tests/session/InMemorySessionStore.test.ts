import { InMemorySessionStore } from '../../src/session/InMemorySessionStore';
import { runSessionStoreContractSuite } from './sessionStoreContract';

runSessionStoreContractSuite('InMemorySessionStore', ({ ttlMs }) => new InMemorySessionStore({ ttlMs }));
