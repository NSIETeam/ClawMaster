/**
 * @license Copyright 2026 ClawMaster SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as commercialControl from './modules/commercial_control/index.js';

const enterpriseDir = path.resolve(import.meta.dirname, 'enterprise');
const commercialControlDir = path.resolve(
  import.meta.dirname,
  'modules',
  'commercial_control',
);
const commercialControlImport = '../modules/commercial_control/index.js';

describe('commercial_control module boundary', () => {
  it('publishes deployment and module-update capabilities from one public entrypoint', () => {
    expect(commercialControl.createCommercialControlComposition).toBeTypeOf(
      'function',
    );
    expect(commercialControl.getDeploymentId).toBeTypeOf('function');
    expect(commercialControl.createDeploymentSettingsRepository).toBeTypeOf(
      'function',
    );
    expect(commercialControl.createAuditLogFacade).toBeTypeOf('function');
    expect(commercialControl.createAuditLogSchemaContributor).toBeTypeOf(
      'function',
    );
    expect(commercialControl.createCreditsFacade).toBeTypeOf('function');
    expect(commercialControl.createCreditsSchemaContributor).toBeTypeOf(
      'function',
    );
    expect(commercialControl.getModuleUpdateManifestFromStore).toBeTypeOf(
      'function',
    );
    expect(commercialControl.handleDeploymentRoute).toBeTypeOf('function');
    expect(commercialControl.handleModuleUpdateRoute).toBeTypeOf('function');
    expect(commercialControl.resolveDeploymentUpdatePolicy).toBeTypeOf(
      'function',
    );
    expect(commercialControl.PRIVATE_DEPLOYMENT_SCHEMA_CONTRIBUTOR.id).toBe(
      'commercial_control_private_deployment',
    );
  });

  it('does not keep obsolete commercial-control aliases in the enterprise directory', () => {
    for (const file of [
      'deploymentRepository.ts',
      'deploymentTypes.ts',
      'auditRepository.ts',
      'credits.ts',
      'creditsSchema.ts',
      'moduleUpdateManifest.ts',
      'moduleUpdateRepository.ts',
      'deploymentRoutes.ts',
      'moduleUpdateRoutes.ts',
    ]) {
      expect(fs.existsSync(path.join(enterpriseDir, file)), file).toBe(false);
    }
  });

  it('routes new enterprise dependencies through the module public entrypoint', () => {
    const databaseFacade = fs.readFileSync(
      path.join(enterpriseDir, 'db.ts'),
      'utf8',
    );
    const routeDispatcher = fs.readFileSync(
      path.join(enterpriseDir, 'enterpriseRouteDispatcher.ts'),
      'utf8',
    );
    const creditsRoutes = fs.readFileSync(
      path.join(enterpriseDir, 'creditsRoutes.ts'),
      'utf8',
    );
    expect(databaseFacade).toContain(commercialControlImport);
    expect(routeDispatcher).toContain(commercialControlImport);
    expect(databaseFacade).not.toMatch(
      /from ['"]\.\/(?:audit|credits|deployment|moduleUpdate)(?:Repository|Routes|Types|Manifest|Schema)?\.js['"];/,
    );
    expect(databaseFacade).not.toContain(
      'CREATE TABLE IF NOT EXISTS deployment_settings',
    );
    expect(databaseFacade).not.toContain(
      'SELECT value FROM deployment_settings WHERE key = ?',
    );
    expect(databaseFacade).not.toContain(
      'INSERT INTO deployment_settings (key, value, updated_at)',
    );
    expect(databaseFacade).toContain('createCommercialControlComposition');
    expect(databaseFacade).not.toContain(
      'createDeploymentSettingsRepository',
    );
    expect(databaseFacade).not.toContain('createAuditLogFacade');
    expect(databaseFacade).not.toContain('createCreditsFacade');
    expect(databaseFacade).not.toContain('getModuleUpdateManifestFromStore');
    expect(databaseFacade).not.toContain('getDeploymentIdFromRepository');
    expect(databaseFacade).not.toContain(
      'CREATE TABLE IF NOT EXISTS deployment_license',
    );
    expect(databaseFacade).not.toContain(
      'CREATE TABLE IF NOT EXISTS telemetry_events',
    );
    expect(databaseFacade).not.toContain('idx_telemetry_events_status_created');
    expect(databaseFacade).toContain('PRIVATE_DEPLOYMENT_SCHEMA_CONTRIBUTOR');
    expect(databaseFacade).toContain('createAuditLogSchemaContributor');
    expect(databaseFacade).toContain('createCreditsSchemaContributor');
    expect(databaseFacade).not.toContain('buildCreditsTablesSql');
    expect(databaseFacade).not.toContain(
      'CREATE TABLE IF NOT EXISTS credit_transactions',
    );
    expect(databaseFacade).not.toContain(
      'CREATE TABLE IF NOT EXISTS redeem_codes',
    );
    expect(databaseFacade).not.toContain(
      'ALTER TABLE organizations ADD COLUMN credit_balance',
    );
    expect(databaseFacade).not.toContain('idx_credit_trans_org');
    expect(databaseFacade).not.toContain('idx_redeem_codes_code');
    expect(databaseFacade).toMatch(
      /IDENTITY_ORGANIZATION_SCHEMA_CONTRIBUTOR,[\s\S]*?createCreditsSchemaContributor\(\{[\s\S]*?MODEL_GATEWAY_SCHEMA_CONTRIBUTOR/,
    );
    expect(databaseFacade).not.toContain(
      'CREATE TABLE IF NOT EXISTS audit_logs',
    );
    expect(databaseFacade).not.toContain('idx_audit_organization');
    expect(creditsRoutes).toContain(commercialControlImport);
    expect(creditsRoutes).not.toMatch(/from ['"]\.\/credits\.js['"]/);
  });

  it('keeps the audit kernel independent from the enterprise composition root', () => {
    for (const file of fs.readdirSync(commercialControlDir)) {
      if (!file.endsWith('.ts')) continue;
      const source = fs.readFileSync(
        path.join(commercialControlDir, file),
        'utf8',
      );
      expect(source).not.toMatch(/enterprise\/db(?:\.js)?/);
    }
  });
});
