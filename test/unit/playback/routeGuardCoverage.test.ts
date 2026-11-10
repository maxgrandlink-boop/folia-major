import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// test/unit/playback/routeGuardCoverage.test.ts
// src 里裸写的 === 'hifi' / !== 'hifi' 只能出现在原生路线判断和 HiFi 引擎自己的目录里。

const ROOT = path.resolve(__dirname, '../../..');
const SRC = path.join(ROOT, 'src');

const BARE_HIFI_COMPARISON = /(?:===|!==)\s*(['"])hifi\1/;

const listSources = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listSources(full);
    return /\.(?:[cm]?[jt]sx?)$/.test(entry.name) ? [full] : [];
});

const relativeOf = (file: string) => path.relative(ROOT, file).split(path.sep).join('/');

const isExemptFile = (relative: string) => relative === 'src/services/playbackRoute.ts'
    || relative.startsWith('src/services/hifi/');

const bareComparisons = () => listSources(SRC).flatMap(file => {
    const relative = relativeOf(file);
    if (isExemptFile(relative)) return [];
    return readFileSync(file, 'utf8').split('\n').flatMap((line, index) => {
        if (!BARE_HIFI_COMPARISON.test(line)) return [];
        const text = line.trim();
        return [`${relative}:${index + 1}: ${text} — 裸写的 HiFi 路线比较，改用 isNativeRoute（就是 HiFi 本身则改用 isHifiPlaybackRoute）`];
    });
});

describe('native route comparison coverage', () => {
    it('finds source files to scan', () => {
        expect(listSources(SRC).length).toBeGreaterThan(0);
    });

    it('rejects a bare HiFi route comparison outside the route guard', () => {
        expect(bareComparisons()).toEqual([]);
    });
});
