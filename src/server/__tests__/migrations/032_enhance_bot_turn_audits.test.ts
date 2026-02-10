/**
 * Tests for migration 032: Enhance bot_turn_audits table with additional columns.
 * Verifies SQL structure for snapshot_hash, selected_plan, execution_result columns and retention index.
 */

import * as fs from 'fs';
import * as path from 'path';

describe('Migration 032: Enhance bot_turn_audits', () => {
  let migrationSql: string;

  beforeAll(() => {
    const migrationPath = path.join(
      process.cwd(),
      'db',
      'migrations',
      '032_enhance_bot_turn_audits.sql',
    );
    migrationSql = fs.readFileSync(migrationPath, 'utf-8');
  });

  it('should exist as a migration file', () => {
    expect(migrationSql).toBeDefined();
    expect(migrationSql.length).toBeGreaterThan(0);
  });

  it('should add snapshot_hash column', () => {
    expect(migrationSql).toContain('snapshot_hash');
    expect(migrationSql).toContain('TEXT');
  });

  it('should add selected_plan column as JSONB', () => {
    expect(migrationSql).toContain('selected_plan');
    expect(migrationSql).toContain('JSONB');
  });

  it('should add execution_result column as JSONB', () => {
    expect(migrationSql).toContain('execution_result');
    expect(migrationSql).toContain('JSONB');
  });

  it('should use IF NOT EXISTS for idempotent application', () => {
    const ifNotExistsCount = (migrationSql.match(/IF NOT EXISTS/g) || []).length;
    expect(ifNotExistsCount).toBeGreaterThanOrEqual(4); // 3 columns + 1 index
  });

  it('should create a retention index on created_at', () => {
    expect(migrationSql).toContain('idx_bot_turn_audits_created_at');
    expect(migrationSql).toContain('created_at');
    expect(migrationSql).toContain('CREATE INDEX');
  });

  it('should include DOWN migration comments for rollback reference', () => {
    expect(migrationSql).toContain('-- DOWN');
    expect(migrationSql).toContain('DROP COLUMN IF EXISTS snapshot_hash');
    expect(migrationSql).toContain('DROP COLUMN IF EXISTS selected_plan');
    expect(migrationSql).toContain('DROP COLUMN IF EXISTS execution_result');
    expect(migrationSql).toContain('DROP INDEX IF EXISTS idx_bot_turn_audits_created_at');
  });

  it('should alter bot_turn_audits table (not create a new table)', () => {
    expect(migrationSql).toContain('ALTER TABLE bot_turn_audits');
    expect(migrationSql).not.toContain('CREATE TABLE');
  });
});
