import { MockBackendClient } from './mock-backend-client.js';
import { HttpBackendClient } from './http-backend-client.js';

export function createBackendClient(env) {
  if (env.backendMode === 'http') {
    return new HttpBackendClient({ 
      baseUrl: env.backendBaseUrl, 
      apiKey: env.backendApiKey,
      sharedSecret: env.backendSharedSecret
    });
  }
  return new MockBackendClient({ business: env.business });
}
