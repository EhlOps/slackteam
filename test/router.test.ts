import { describe, expect, it } from 'vitest';
import { routeJobMessage } from '../src/slack/router.js';

describe('routeJobMessage', () => {
  it('defaults to the EM', () => expect(routeJobMessage('please add tests')).toEqual({ agent: 'EM', text: 'please add tests' }));
  it('routes swe-1:/swe2, prefixes', () => {
    expect(routeJobMessage('swe-1: use sqlite')).toEqual({ agent: 'SWE-1', text: 'use sqlite' });
    expect(routeJobMessage('SWE2, retry the build')).toEqual({ agent: 'SWE-2', text: 'retry the build' });
  });
  it('does not treat mentions mid-sentence as routing', () => expect(routeJobMessage('ask swe-1: later').agent).toBe('EM'));
});
