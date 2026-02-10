/**
 * Tests for migration 031: Add initial build phase columns to games table.
 * Verifies SQL structure and column definitions.
 */

import * as fs from 'fs';
import * as path from 'path';

describe('Migration 031: Add initial build columns', () => {
  let migrationSql: string;

  beforeAll(() => {
    const migrationPath = path.join(
      process.cwd(),
      'db',
      'migrations',
      '031_add_initial_build_columns.sql',
    );
    migrationSql = fs.readFileSync(migrationPath, 'utf-8');
  });

  it('should exist as a migration file', () => {
    expect(migrationSql).toBeDefined();
    expect(migrationSql.length).toBeGreaterThan(0);
  });

  it('should add initial_build_round column to games table', () => {
    expect(migrationSql).toContain('ALTER TABLE games');
    expect(migrationSql).toContain('initial_build_round');
    expect(migrationSql).toContain('INTEGER');
    expect(migrationSql).toContain('DEFAULT 0');
  });

  it('should add initial_build_order column to games table', () => {
    expect(migrationSql).toContain('initial_build_order');
    expect(migrationSql).toContain('JSONB');
  });

  it('should use IF NOT EXISTS for idempotent application', () => {
    expect(migrationSql).toContain('IF NOT EXISTS');
  });

  it('should include DOWN migration comments for rollback reference', () => {
    expect(migrationSql).toContain('-- DOWN');
    expect(migrationSql).toContain('DROP COLUMN IF EXISTS initial_build_round');
    expect(migrationSql).toContain('DROP COLUMN IF EXISTS initial_build_order');
  });
});

describe('Migration 030: Bot player columns (previously applied)', () => {
  let migrationSql: string;

  beforeAll(() => {
    const migrationPath = path.join(
      process.cwd(),
      'db',
      'migrations',
      '030_create_bot_turn_audits.sql',
    );
    migrationSql = fs.readFileSync(migrationPath, 'utf-8');
  });

  it('should add is_bot column to players table', () => {
    expect(migrationSql).toContain('ALTER TABLE players');
    expect(migrationSql).toContain('is_bot');
    expect(migrationSql).toContain('BOOLEAN');
    expect(migrationSql).toContain('DEFAULT FALSE');
  });

  it('should add bot_config column to players table', () => {
    expect(migrationSql).toContain('bot_config');
    expect(migrationSql).toContain('JSONB');
  });
});
