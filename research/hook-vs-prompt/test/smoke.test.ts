import { describe, expect, it } from 'vitest';

import { createInputChannel } from '../../../src/main/agent/inputChannel';
import { createGateHooks } from '../../../src/main/gates/hooks';
import { createPlanStore } from '../../../src/main/plan/store';

describe('앱 모듈 재사용', () => {
  it('관문 hook·계획 저장소·입력 채널을 고치지 않고 import 한다', () => {
    expect(typeof createGateHooks).toBe('function');
    expect(typeof createPlanStore().read).toBe('function');
    expect(typeof createInputChannel().push).toBe('function');
  });
});
