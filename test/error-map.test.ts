import { describe, expect, it } from 'vitest';
import { mapRainDBError } from '../src/raindb/error-map.js';

describe('scan error mapping', () => {
  it.each([
    'catalog scan: delete files are unsupported',
    'RainDB GraphQL error: catalog scan: unsupported partition layout',
    'RainDB HTTP 400: {"errors":[{"message":"planStrategy must be \\"range\\" or \\"scan\\", got \\"invalid\\"","extensions":{"code":"bad_request","httpStatus":400}}]}',
  ])('preserves the message for %s', (message) => {
    expect(mapRainDBError(message)).toEqual({ kind: 'InvalidInputValue', message });
  });

  it('does not classify unrelated bad requests as plan errors', () => {
    expect(mapRainDBError('RainDB HTTP 400: unknown request')).toBeNull();
    expect(mapRainDBError('RainDB request timed out')).toEqual({ kind: 'SocketTimeout' });
    expect(mapRainDBError('formation not found')).toEqual({ kind: 'TableDoesNotExist' });
  });
});
