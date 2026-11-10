import { describe, expect, it } from 'vitest';
import en from '../../../src/i18n/locales/en';
import id from '../../../src/i18n/locales/in';
import vi from '../../../src/i18n/locales/vi';
import zhCN from '../../../src/i18n/locales/zh-CN';

// test/unit/i18n/localeBrand.test.ts
// ok唱歌 的界面文案不再出现 Folia。只查值，不查键（foliaTransport 这类键名留着）。

const walk = (value: unknown, path: string, hits: string[]): void => {
    if (typeof value === 'string') {
        if (value.includes('Folia') || value.includes('FOLIA')) hits.push(`${path}: ${value}`);
        return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
        walk(child, path ? `${path}.${key}` : key, hits);
    }
};

describe.each([
    ['en', en],
    ['zh-CN', zhCN],
    ['in', id],
    ['vi', vi],
] as const)('%s locale values', (name, bundle) => {
    it('do not contain Folia', () => {
        const hits: string[] = [];
        walk(bundle, name, hits);
        expect(hits).toEqual([]);
    });
});
