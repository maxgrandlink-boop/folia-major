import { describe, expect, it } from 'vitest';
import { formatClock, formatGigabytes } from '../../../src/services/multitrack/format';
import { activeLyricIndex, parseWorkLyrics } from '../../../src/services/multitrack/parseWorkLyrics';

// test/unit/ok/stemFormat.test.ts
// 分轨面板用到的字节显示和暗号歌词定位。

const ANHAO = '[ti:暗号]\n[ar:白允y]\n[offset:0]\n[00:16.02]<00:16.02>占<00:16.23>位<00:16.50>一\n[00:19.89]<00:19.89>占<00:19.98>位<00:20.52>二';

describe('ok stem formatting', () => {
    it('shows integer bytes as GB with 1024^3', () => {
        expect(formatGigabytes(47492912)).toBe('0.04 GB');
        expect(formatGigabytes(9_800_000_000)).toBe('9.13 GB');
        expect(formatGigabytes(0)).toBe('0.00 GB');
    });

    it('formats a playback clock', () => {
        expect(formatClock(16.02)).toBe('0:16');
        expect(formatClock(269.23)).toBe('4:29');
    });

    it('walks the enhanced LRC of 暗号 word by word', () => {
        const lines = parseWorkLyrics(ANHAO);
        expect(lines.map(line => line.text)).toEqual(['占位一', '占位二']);
        expect(activeLyricIndex(lines, 10).line).toBe(-1);
        expect(activeLyricIndex(lines, 16.3)).toEqual({ line: 0, word: 1 });
        expect(activeLyricIndex(lines, 20)).toEqual({ line: 1, word: 1 });
    });
});
