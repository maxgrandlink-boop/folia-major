import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createScanner, LanguageVariant, SyntaxKind } from 'typescript/unstable/ast';
import { describe, expect, it } from 'vitest';

// test/unit/playback/routeGuardCoverage.test.ts
// TypeScript 7 的包不再导出旧的 createSourceFile 解析器。这里用编译器 scanner：
// 注释和空白是 trivia，跳过后不会误拦；比较、case、includes/has 按记号的结构认，跨行也连得上。
// 字面量比较只豁免 playbackRoute.ts 和 hifiRouteGuard.ts。isHifiRoute( 只许出现在下面的白名单里。

const ROOT = path.resolve(__dirname, '../../..');
const SRC = path.join(ROOT, 'src');

const COMPARISON_EXEMPT = new Set([
    'src/services/playbackRoute.ts',
    'src/services/hifi/hifiRouteGuard.ts',
]);

// 这些文件里的 isHifiRoute( 是“就是 HiFi / mpv”，不是“任一原生路线”。
const HIFI_ROUTE_CALL_FILES = new Set([
    'src/App.tsx',
    'src/components/app/playback/bridges/usePlaybackInteractionBridge.ts',
    'src/components/app/playback/bridges/usePlaybackTransportController.ts',
    'src/components/app/playback/restore/useElectronWindowPlaybackHandoff.ts',
    'src/components/app/playback/start/usePlaybackQueueController.ts',
    'src/components/app/playback/useStagePlaybackController.ts',
    'src/components/command-palette/commands/hifiCommands.ts',
    'src/components/command-palette/surfaces/volumeSurface.ts',
    'src/components/hifi/hifiRouteTransport.ts',
    'src/components/hifi/useHifiGaplessPreload.ts',
    'src/components/hifi/useHifiPlaybackBridge.ts',
    'src/services/hifi/hifiGapless.ts',
    'src/services/hifi/hifiPlayback.ts',
    'src/services/hifi/hifiRouteGuard.ts',
    'src/services/hifi/hifiTransport.ts',
]);

const EQUALITY = new Set<number>([
    SyntaxKind.EqualsEqualsToken,
    SyntaxKind.ExclamationEqualsToken,
    SyntaxKind.EqualsEqualsEqualsToken,
    SyntaxKind.ExclamationEqualsEqualsToken,
]);

const MEMBERSHIP = new Set(['includes', 'has', 'hasOwn']);

type Tok = { kind: number; start: number; text: string };

type RouteHit = { file: string; line: number; text: string; kind: 'comparison' | 'isHifiRoute' };

const listSources = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listSources(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
});

const relativeOf = (file: string) => path.relative(ROOT, file).split(path.sep).join('/');

const lineOf = (source: string, start: number) => source.slice(0, start).split('\n').length;

const isHifiLiteral = (token: Tok | undefined): boolean => Boolean(
    token
    && (token.kind === SyntaxKind.StringLiteral || token.kind === SyntaxKind.NoSubstitutionTemplateLiteral)
    && token.text === 'hifi',
);

const tokenize = (source: string, jsx: boolean): Tok[] => {
    const scanner = createScanner(true, jsx ? LanguageVariant.JSX : LanguageVariant.Standard, source);
    const tokens: Tok[] = [];
    const push = (kind: number) => {
        const literal = kind === SyntaxKind.StringLiteral || kind === SyntaxKind.NoSubstitutionTemplateLiteral;
        tokens.push({
            kind,
            start: scanner.getTokenStart(),
            text: literal || kind === SyntaxKind.Identifier ? (literal ? scanner.getTokenValue() : scanner.getTokenText()) : '',
        });
    };
    const scanNext = () => {
        let kind = scanner.scan();
        if (kind === SyntaxKind.BacktickToken) kind = scanner.reScanTemplateHeadOrNoSubstitutionTemplate();
        return kind;
    };
    let kind = scanNext();
    let guard = 0;
    while (kind !== SyntaxKind.EndOfFile) {
        if (++guard > source.length + 10) break;
        if (kind === SyntaxKind.TemplateHead || kind === SyntaxKind.TemplateMiddle) {
            let depth = 0;
            kind = scanNext();
            while (kind !== SyntaxKind.EndOfFile) {
                if (++guard > source.length + 10) break;
                if (kind === SyntaxKind.OpenBraceToken) depth += 1;
                else if (kind === SyntaxKind.CloseBraceToken) {
                    if (depth === 0) {
                        kind = scanner.reScanTemplateToken(false);
                        break;
                    }
                    depth -= 1;
                }
                else push(kind);
                kind = scanNext();
            }
            continue;
        }
        push(kind);
        kind = scanNext();
    }
    return tokens;
};

const skipParens = (tokens: Tok[], index: number, step: -1 | 1): number => {
    let cursor = index;
    while (tokens[cursor] && (tokens[cursor].kind === SyntaxKind.OpenParenToken || tokens[cursor].kind === SyntaxKind.CloseParenToken)) {
        cursor += step;
    }
    return cursor;
};

const hitsIn = (file: string, source: string): RouteHit[] => {
    const tokens = tokenize(source, file.endsWith('x'));
    const lines = source.split('\n');
    const hits: RouteHit[] = [];
    const report = (start: number, kind: RouteHit['kind']) => {
        const line = lineOf(source, start);
        hits.push({ file, line, text: lines[line - 1]?.trim() ?? '', kind });
    };
    tokens.forEach((token, index) => {
        if (isHifiLiteral(token)) {
            const left = tokens[skipParens(tokens, index - 1, -1)];
            const right = tokens[skipParens(tokens, index + 1, 1)];
            if ((left && EQUALITY.has(left.kind)) || (right && EQUALITY.has(right.kind))) report(token.start, 'comparison');
        }
        if (token.kind === SyntaxKind.CaseKeyword && isHifiLiteral(tokens[skipParens(tokens, index + 1, 1)])) {
            report(token.start, 'comparison');
        }
        if ((token.kind === SyntaxKind.DotToken || token.kind === SyntaxKind.QuestionDotToken) && MEMBERSHIP.has(tokens[index + 1]?.text ?? '')) {
            if (tokens[index + 2]?.kind !== SyntaxKind.OpenParenToken) return;
            let listHasHifi = false;
            if (tokens[index - 1]?.kind === SyntaxKind.CloseBracketToken) {
                for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
                    if (tokens[cursor].kind === SyntaxKind.OpenBracketToken) break;
                    if (isHifiLiteral(tokens[cursor])) listHasHifi = true;
                }
            }
            let argumentIsHifi = false;
            let depth = 0;
            for (let cursor = index + 3; cursor < tokens.length; cursor += 1) {
                const argument = tokens[cursor];
                if (argument.kind === SyntaxKind.OpenParenToken) depth += 1;
                else if (argument.kind === SyntaxKind.CloseParenToken) {
                    if (depth === 0) break;
                    depth -= 1;
                }
                else if (depth === 0 && isHifiLiteral(argument)) argumentIsHifi = true;
            }
            if (argumentIsHifi || listHasHifi) report(tokens[index + 1].start, 'comparison');
        }
        if (token.text === 'isHifiRoute' && tokens[index + 1]?.kind === SyntaxKind.OpenParenToken) {
            report(token.start, 'isHifiRoute');
        }
    });
    return hits;
};

const sourceHits = (): RouteHit[] => listSources(SRC).flatMap(file => {
    const relative = relativeOf(file);
    return hitsIn(relative, readFileSync(file, 'utf8')).filter(hit => (
        hit.kind === 'isHifiRoute' || !COMPARISON_EXEMPT.has(relative)
    ));
});

const comparisonMessage = (hit: RouteHit) => (
    `${hit.file}:${hit.line}: ${hit.text} — 裸写的 HiFi 路线比较，改用 isNativeRoute（就是 HiFi 本身则改用 isHifiPlaybackRoute）`
);

const callMessage = (hit: RouteHit) => (
    `${hit.file}:${hit.line}: ${hit.text} — isHifiRoute( 只能出现在白名单文件里；原生路线用 isNativeRouteNow，就是 HiFi 本身用 isHifiPlaybackRoute`
);

describe('native route comparison coverage', () => {
    it('finds source files to scan', () => {
        expect(listSources(SRC).length).toBeGreaterThan(0);
    });

    it('rejects a bare HiFi route comparison outside the route guard', () => {
        const offenders = sourceHits().filter(hit => hit.kind === 'comparison').map(comparisonMessage);
        expect(offenders).toEqual([]);
    });

    it('allows isHifiRoute( only in the HiFi-specific whitelist', () => {
        const calls = sourceHits().filter(hit => hit.kind === 'isHifiRoute');
        const offenders = calls.filter(hit => !HIFI_ROUTE_CALL_FILES.has(hit.file)).map(callMessage);
        const seen = new Set(calls.map(hit => hit.file));
        const stale = [...HIFI_ROUTE_CALL_FILES].filter(file => !seen.has(file)).map(file => `${file} — 白名单里没有 isHifiRoute(`);
        expect([...offenders, ...stale]).toEqual([]);
    });

    it.each([
        ['equals', "const on = route === 'hifi';"],
        ['not equals', "const on = route !== 'hifi';"],
        ['reversed equals', "const on = 'hifi' === route;"],
        ['reversed not equals', "const on = 'hifi' !== route;"],
        ['loose equals', "const on = route == 'hifi';"],
        ['loose not equals', "const on = route != 'hifi';"],
        ['double quotes', 'const on = route === "hifi";'],
        ['template literal', 'const on = route === `hifi`;'],
        ['reversed template', 'const on = `hifi` !== route;'],
        ['parenthesized', "const on = route === ('hifi');"],
        ['case label', "switch (route) { case 'hifi': break; default: break; }"],
        ['template case label', 'switch (route) { case `hifi`: break; default: break; }'],
        ['includes argument', "const on = values.includes('hifi');"],
        ['optional includes', "const on = values?.includes('hifi');"],
        ['includes the literal in the list', "const on = ['hifi'].includes(route);"],
        ['set has', "const on = seen.has('hifi');"],
        ['hasOwn', "const on = Object.hasOwn(record, 'hifi');"],
        ['split across lines', "const on = route ===\n    'hifi';"],
    ])('rejects %s', (_label, source) => {
        const hits = hitsIn('src/leak.ts', source).filter(hit => hit.kind === 'comparison');
        expect(hits.map(comparisonMessage)).not.toEqual([]);
    });

    it('does not flag a comment that only mentions the comparison', () => {
        const source = [
            "// route === 'hifi'",
            "/* case 'hifi': values.includes('hifi') */",
            'const on = route === "web";',
        ].join('\n');
        expect(hitsIn('src/leak.ts', source)).toEqual([]);
    });
});
