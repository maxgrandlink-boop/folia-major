#!/usr/bin/env node
// 在 Windows 上用 CMake + MSVC 编 ok-engine.exe，放到 build/ok-engine，供 beforePack 和开发覆盖使用。
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export async function prepareOkEngine({ projectRoot = ROOT } = {}) {
    if (process.platform !== 'win32') {
        console.log('[ok-engine] non-Windows host, skipping build');
        return;
    }
    const source = path.join(projectRoot, 'native', 'ok-engine');
    const build = path.join(projectRoot, 'build', 'ok-engine-cmake');
    const outDir = path.join(projectRoot, 'build', 'ok-engine');
    mkdirSync(outDir, { recursive: true });
    execFileSync('cmake', ['-S', source, '-B', build, '-G', 'Visual Studio 17 2022', '-A', 'x64'], { stdio: 'inherit' });
    execFileSync('cmake', ['--build', build, '--config', 'Release', '--target', 'ok-engine'], { stdio: 'inherit' });
    const dest = path.join(outDir, 'ok-engine.exe');
    copyFileSync(path.join(build, 'Release', 'ok-engine.exe'), dest);
    console.log(`[ok-engine] built ${dest}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    await prepareOkEngine();
}
