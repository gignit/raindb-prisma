import { describe, expect, it } from 'vitest';
import {
  bareTableName,
  formationToPeriscopeTable,
  nameMapFromFormations,
  periscopeTableToFormation,
  resolveFormation,
  unquoteIdent,
} from '../src/sql/identifiers.js';

describe('Periscope table-name rule (hyphen -> double underscore)', () => {
  it('formation id hyphens become double underscores', () => {
    expect(formationToPeriscopeTable('vizzda-events')).toBe('vizzda__events');
    expect(formationToPeriscopeTable('fdn-documents')).toBe('fdn__documents');
    expect(formationToPeriscopeTable('a-b-c')).toBe('a__b__c');
    expect(formationToPeriscopeTable('nohyphen')).toBe('nohyphen');
  });

  it('inverts double underscore back to hyphen', () => {
    expect(periscopeTableToFormation('vizzda__events')).toBe('vizzda-events');
    expect(periscopeTableToFormation('a__b__c')).toBe('a-b-c');
    expect(periscopeTableToFormation('nohyphen')).toBe('nohyphen');
  });

  it('round-trips', () => {
    for (const fid of ['vizzda-events', 'fdn-documents', 'plain', 'a-b-c-d']) {
      expect(periscopeTableToFormation(formationToPeriscopeTable(fid))).toBe(fid);
    }
  });
});

describe('unquoteIdent', () => {
  it('strips quotes and unescapes', () => {
    expect(unquoteIdent('"user"')).toBe('user');
    expect(unquoteIdent('"a""b"')).toBe('a"b');
    expect(unquoteIdent('bare')).toBe('bare');
  });
});

describe('bareTableName', () => {
  it('extracts the last segment, unquoted', () => {
    expect(bareTableName('entity."vizzda__events"')).toBe('vizzda__events');
    expect(bareTableName('"user"')).toBe('user');
    expect(bareTableName('public."User"')).toBe('User');
  });
});

describe('resolveFormation', () => {
  it('uses the name map when present', () => {
    const map = nameMapFromFormations(['vizzda-events', 'fdn-documents']);
    expect(resolveFormation('entity."vizzda__events"', map)).toBe('vizzda-events');
    expect(resolveFormation('"fdn__documents"', map)).toBe('fdn-documents');
  });

  it('falls back to the __ -> - inverse when unmapped', () => {
    const map = nameMapFromFormations([]);
    expect(resolveFormation('"some__thing"', map)).toBe('some-thing');
    expect(resolveFormation('"plain"', map)).toBe('plain');
  });
});
