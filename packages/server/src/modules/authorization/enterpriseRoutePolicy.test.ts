import { describe, expect, it } from 'vitest';
import { isAdminRoute, isMemberRoute } from './enterpriseRoutePolicy.js';

describe('customer module route authorization', () => {
  it('keeps authoring and installation on member sessions', () => {
    expect(isMemberRoute('/enterprise/customer-modules')).toBe(true);
    expect(isMemberRoute('/enterprise/customer-modules/com.acme.report/1.0.0/install')).toBe(true);
    expect(isAdminRoute('/enterprise/customer-modules/com.acme.report/1.0.0/install')).toBe(false);
  });

  it('reserves public-market review and suspension for platform administration', () => {
    const review = '/enterprise/platform/customer-modules/com.acme.report/1.0.0/review';
    expect(isAdminRoute(review)).toBe(true);
    expect(isMemberRoute(review)).toBe(false);
  });
});

describe('CompanyOS route authorization', () => {
  it('reserves ingestion, watchdog execution and audit for administrators', () => {
    for (const path of [
      '/enterprise/companyos/events',
      '/enterprise/companyos/watchdog/inspect',
      '/enterprise/companyos/audit',
    ]) {
      expect(isAdminRoute(path)).toBe(true);
      expect(isMemberRoute(path)).toBe(false);
    }
    expect(isAdminRoute('/enterprise/companyos/tasks/task-1/decision')).toBe(true);
    expect(isMemberRoute('/enterprise/companyos/tasks/task-1/decision')).toBe(false);
  });

  it('allows signed-in members to read their tenant actions', () => {
    expect(isMemberRoute('/enterprise/companyos/actions')).toBe(true);
    expect(isAdminRoute('/enterprise/companyos/actions')).toBe(false);
    expect(isMemberRoute('/enterprise/companyos/tasks')).toBe(true);
    expect(isAdminRoute('/enterprise/companyos/tasks')).toBe(false);
    expect(isMemberRoute('/enterprise/companyos/connectors')).toBe(true);
    expect(isAdminRoute('/enterprise/companyos/connectors')).toBe(false);
  });
});
