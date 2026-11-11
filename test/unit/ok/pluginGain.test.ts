import { describe, expect, it } from 'vitest';
import { pluginGainPercent } from '../../../src/services/live/liveSession';

// test/unit/ok/pluginGain.test.ts
// 插件音量从 dB 换成百分比：0 dB ≈ 83%。

describe('plugin track volume percent', () => {
    it('maps 0 dB to about 83 percent', () => {
        expect(pluginGainPercent(0)).toBe(83);
        expect(pluginGainPercent(-60)).toBe(0);
        expect(pluginGainPercent(12)).toBe(100);
    });
});
