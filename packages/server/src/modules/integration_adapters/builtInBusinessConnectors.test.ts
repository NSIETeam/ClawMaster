import { describe, expect, it, vi } from 'vitest';
import { listBuiltInBusinessConnectorReadiness } from './builtInBusinessConnectors.js';

describe('built-in CompanyOS business connectors', () => {
  it('reports the known HTTP platform endpoints as blocked by default', async () => {
    const secretRefs = { exists: vi.fn(async () => true) };
    await expect(listBuiltInBusinessConnectorReadiness({
      organizationId: 'org-1', environment: {}, secretRefs,
    })).resolves.toEqual([
      expect.objectContaining({
        connectorId: 'owl-pricing-v1', provider: 'owl',
        state: 'blocked', reason: 'insecure_endpoint',
      }),
      expect.objectContaining({
        connectorId: 'zhilemon-commerce-v1', provider: 'zhilemon',
        state: 'blocked', reason: 'insecure_endpoint',
      }),
    ]);
    expect(secretRefs.exists).not.toHaveBeenCalled();
  });

  it('does not claim readiness when HTTPS exists but no provider adapter is installed', async () => {
    const readiness = await listBuiltInBusinessConnectorReadiness({
      organizationId: 'org-1',
      environment: {
        CLAWMASTER_OWL_ENDPOINT: 'https://owl.example/api',
        CLAWMASTER_OWL_SECRET_REF: 'secret://org-1/owl',
      },
      secretRefs: { exists: vi.fn(async () => true) },
    });
    expect(readiness[0]).toMatchObject({
      connectorId: 'owl-pricing-v1', state: 'unavailable',
      reason: 'provider_probe_failed',
    });
    expect(JSON.stringify(readiness)).not.toContain('secret://org-1/owl');
  });
});
