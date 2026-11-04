import { describe, expect, it } from 'vitest';
import { isHifiPlaybackRoute, isNativeRoute } from '@/services/playbackRoute';

// test/unit/playback/playbackRoute.test.ts
// 现在只有 HiFi 是原生路线；专指 HiFi 的判断和它结果相同，但是另一条函数。

describe('isNativeRoute', () => {
    it('treats only the HiFi route as native', () => {
        expect(isNativeRoute('hifi')).toBe(true);
        expect(isNativeRoute('web')).toBe(false);
        expect(isNativeRoute('external')).toBe(false);
    });
});

describe('isHifiPlaybackRoute', () => {
    it('matches the HiFi route itself', () => {
        expect(isHifiPlaybackRoute('hifi')).toBe(true);
        expect(isHifiPlaybackRoute('web')).toBe(false);
        expect(isHifiPlaybackRoute('external')).toBe(false);
    });
});
