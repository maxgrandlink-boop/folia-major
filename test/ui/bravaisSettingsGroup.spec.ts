import { expect, test, type Page } from '@playwright/test';
import { installBaseState, mockNeteaseApi, openApp } from './helpers/appFixtures';

// test/ui/bravaisSettingsGroup.spec.ts
// 界面设置的「Bravais 墙面」分组（2026-10-09，用户要求 bravais 独有的设置都整理到这里）：
// - bravais 生效时，分组紧跟在「资料库界面」后面，里面是透光三档、部分透明时的每块窗数与集合叠页边开关；
//   「资料库界面」那一节只剩 suite 的选择；
// - 切换都写进 useLibraryWallLookStore 并持久化，叠页边开关立刻作用到墙（stage 根节点的 has-stack-edges）；
// - grid 生效时整组不出现，切到 bravais 后立刻出现。

test.use({ screenshot: 'only-on-failure' });

const bootHome = async (page: Page, suite: 'bravais' | 'grid') => {
    // 保留真实的 matchMedia：设置弹窗的宽版布局（侧栏 + 内容列）按 (min-width: 768px) 分支，桩会把它算成窄版。
    await installBaseState(page, { neteaseMode: 'guest', preserveNativeMediaQueries: true });
    await page.addInitScript((suiteId) => {
        localStorage.setItem('library_suite', suiteId);
        // 打开设置弹窗要这两个桥接方法（与 bravaisVisualizerMount 同一份最小桥）。
        Object.assign((window as Window & { electron?: Record<string, unknown> }).electron ?? {}, {
            getSettings: async () => ({}),
            getCacheDirectory: async () => ({ path: '', isDefault: true }),
        });
    }, suite);
    await mockNeteaseApi(page, 'guest');
    await openApp(page);
};

const openGeneralSettings = (page: Page, anchorId?: string) => page.evaluate(async (anchor) => {
    const path = '/src/stores/useSettingsModalStore.ts';
    const { useSettingsModalStore } = await import(/* @vite-ignore */ path);
    useSettingsModalStore.getState().openSettings('options', 'general', null, anchor ?? null);
}, anchorId);

// 设置页改用 kit 之后，分组是 data-settings-anchor，选项是按钮的 aria-pressed / switch，
// 不再有 data-bravais-settings、data-library-wall-look 这些测试专用属性。
const group = (page: Page) => page.locator('[data-settings-anchor="bravaisSettings"]');
const suite = (page: Page) => page.locator('[data-settings-anchor="librarySuite"]');
const windows = (page: Page) => group(page).getByRole('group', { name: 'Windows per block' });

test('the Bravais group holds the transparency, the windows per block and the stack edges', async ({ page }) => {
    await bootHome(page, 'bravais');
    const stage = page.locator('[data-library-stage="bravais"]');
    await expect(stage).toHaveClass(/\bhas-stack-edges\b/);
    await openGeneralSettings(page, 'bravaisSettings');

    await expect(page.getByRole('heading', { name: 'Bravais wall', exact: true })).toBeVisible();
    await expect(group(page)).toBeVisible();
    // 透光与窗数在分组里；「资料库界面」只剩 suite 的选择。
    await expect(suite(page).getByRole('button', { name: 'Bravais wall', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(group(page).getByRole('button', { name: 'Grid', exact: true })).toHaveCount(0);
    // 分组在「资料库界面」那一节之后。
    const order = await page.evaluate(() => {
        const suiteSection = document.querySelector('[data-settings-anchor="librarySuite"]')!;
        const bravais = document.querySelector('[data-settings-anchor="bravaisSettings"]')!;
        return Boolean(suiteSection.compareDocumentPosition(bravais) & Node.DOCUMENT_POSITION_FOLLOWING);
    });
    expect(order).toBe(true);

    // 透光：部分透明时才有每块窗数。
    await group(page).getByRole('button', { name: 'Solid', exact: true }).click();
    await expect(windows(page)).toHaveCount(0);
    await group(page).getByRole('button', { name: 'Partly see-through', exact: true }).click();
    await expect(windows(page).getByRole('button')).toHaveCount(6);
    await windows(page).getByRole('button', { name: '4', exact: true }).click();
    expect(await page.evaluate(() => [localStorage.getItem('library_wall_look'), localStorage.getItem('library_wall_windows_per_block')])).toEqual(['partial', '4']);
    await expect(stage).toHaveAttribute('data-bravais-look', 'partial');

    // 集合叠页边：默认开，关掉后墙上立刻不画，存储里记成 false。
    const toggle = page.getByRole('switch', { name: 'Collection stack edges' });
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await expect(stage).not.toHaveClass(/\bhas-stack-edges\b/);
    expect(await page.evaluate(() => localStorage.getItem('library_wall_stack_edges'))).toBe('false');
    await toggle.click();
    await expect(stage).toHaveClass(/\bhas-stack-edges\b/);
});

test('the Bravais group stays out of the grid interface and appears once bravais is chosen', async ({ page }) => {
    await bootHome(page, 'grid');
    await openGeneralSettings(page, 'librarySuite');
    await expect(suite(page).getByRole('button', { name: 'Grid', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(group(page)).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Bravais wall', exact: true })).toHaveCount(0);

    await suite(page).getByRole('button', { name: 'Bravais wall', exact: true }).click();
    await expect(group(page)).toBeVisible();
    await expect(page.getByRole('switch', { name: 'Collection stack edges' })).toBeVisible();
});

// 2026-10-09：信息条的材质（始终透明 / 实色预设，互斥）与墙后画面的两个开关也在分组里。
test('the Bravais group switches the info strip material and the backdrop', async ({ page }) => {
    await bootHome(page, 'bravais');
    const stage = page.locator('[data-library-stage="bravais"]');
    await openGeneralSettings(page, 'bravaisSettings');
    await expect(group(page)).toBeVisible();

    // 信息条始终透明默认开（2026-10-09）：先关掉，下面的实色预设才作用到缝。
    const clear = page.getByRole('switch', { name: 'See-through info strip' });
    await expect(clear).toHaveAttribute('aria-checked', 'true');
    await expect(stage).toHaveClass(/\bhas-clear-seam\b/);
    await clear.click();
    await expect(clear).toHaveAttribute('aria-checked', 'false');
    expect(await page.evaluate(() => localStorage.getItem('library_wall_seam_clear'))).toBe('false');

    // 预设：8 个色样，默认主题纸色；点「纯白印刷」写进存储，墙上的缝换样式。
    const styles = group(page).getByRole('group', { name: 'Info strip style' });
    await expect(styles.getByRole('button')).toHaveCount(8);
    await expect(styles.getByRole('button', { name: 'Theme paper', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await styles.getByRole('button', { name: 'White print', exact: true }).click();
    await expect(styles.getByRole('button', { name: 'White print', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(stage).toHaveAttribute('data-bravais-seam-style', 'white');
    expect(await page.evaluate(() => localStorage.getItem('library_wall_seam_style'))).toBe('white');

    // 再打开始终透明：开着时预设整组禁用（值保留），缝换成透明的纱。
    await expect(clear).toHaveAttribute('aria-checked', 'false');
    await clear.click();
    await expect(clear).toHaveAttribute('aria-checked', 'true');
    await expect(stage).toHaveClass(/\bhas-clear-seam\b/);
    await expect(stage).toHaveAttribute('data-bravais-seam-style', 'clear');
    await expect(styles.getByRole('button', { name: 'Dot grid', exact: true })).toBeDisabled();
    expect(await page.evaluate(() => [localStorage.getItem('library_wall_seam_clear'), localStorage.getItem('library_wall_seam_style')])).toEqual(['true', 'white']);
    await clear.click();
    await expect(stage).toHaveAttribute('data-bravais-seam-style', 'white');
    await expect(styles.getByRole('button', { name: 'Dot grid', exact: true })).toBeEnabled();

    // 墙后画面：两个开关默认关，切换写进存储。
    for (const [name, key] of [['Lyrics behind the wall', 'library_wall_backdrop_lyrics'], ['Blur behind the wall', 'library_wall_backdrop_blur']] as const) {
        const toggle = page.getByRole('switch', { name });
        await expect(toggle).toHaveAttribute('aria-checked', 'false');
        await toggle.click();
        await expect(toggle).toHaveAttribute('aria-checked', 'true');
        expect(await page.evaluate(storageKey => localStorage.getItem(storageKey), key)).toBe('true');
    }
});
