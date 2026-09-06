/** @license Copyright 2026 ClawMaster SPDX-License-Identifier: Apache-2.0 */

import {
  BusinessDataConnectorCoordinator,
  OWL_PRICING_CONNECTOR_DESCRIPTOR,
  ZHILEMON_COMMERCE_CONNECTOR_DESCRIPTOR,
  type BusinessDataConnectorDescriptor,
  type BusinessDataConnectorReadiness,
  type BusinessDataConnectorV1,
  type BusinessDataSecretReferenceProvider,
} from './businessDataConnector.js';

const DEFAULT_OWL_ENDPOINT = 'http://8.141.8.31';
const DEFAULT_ZHILEMON_ENDPOINT = 'http://47.116.30.60:18787';

function unavailableConnector(
  descriptor: BusinessDataConnectorDescriptor,
): BusinessDataConnectorV1 {
  return {
    descriptor,
    async readiness() {
      throw new Error('provider adapter is not installed');
    },
    async sync() {
      throw new Error('provider adapter is not installed');
    },
  };
}

function enabled(value: string | undefined): boolean {
  return value?.trim().toLowerCase() !== 'false';
}

export async function listBuiltInBusinessConnectorReadiness(input: {
  organizationId: string;
  environment?: Record<string, string | undefined>;
  secretRefs?: BusinessDataSecretReferenceProvider;
}): Promise<BusinessDataConnectorReadiness[]> {
  const environment = input.environment ?? process.env;
  const coordinator = new BusinessDataConnectorCoordinator({
    connectors: [
      unavailableConnector(OWL_PRICING_CONNECTOR_DESCRIPTOR),
      unavailableConnector(ZHILEMON_COMMERCE_CONNECTOR_DESCRIPTOR),
    ],
    secretRefs: input.secretRefs ?? { exists: async () => false },
    publish: async () => undefined,
  });
  return Promise.all([
    coordinator.readiness({
      organizationId: input.organizationId,
      connectorId: OWL_PRICING_CONNECTOR_DESCRIPTOR.id,
      endpoint: environment.CLAWMASTER_OWL_ENDPOINT ?? DEFAULT_OWL_ENDPOINT,
      secretRef: environment.CLAWMASTER_OWL_SECRET_REF,
      enabled: enabled(environment.CLAWMASTER_OWL_ENABLED),
    }),
    coordinator.readiness({
      organizationId: input.organizationId,
      connectorId: ZHILEMON_COMMERCE_CONNECTOR_DESCRIPTOR.id,
      endpoint: environment.CLAWMASTER_ZHILEMON_ENDPOINT ?? DEFAULT_ZHILEMON_ENDPOINT,
      secretRef: environment.CLAWMASTER_ZHILEMON_SECRET_REF,
      enabled: enabled(environment.CLAWMASTER_ZHILEMON_ENABLED),
    }),
  ]);
}
