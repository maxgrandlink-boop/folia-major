import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { installBaseState, mockNeteaseApi } from './helpers/appFixtures';

// test/ui/okSurfaces.spec.ts
// 深浅两套基线，linux 快照进仓库。win32 的同名文件要在 Windows CI 上重生成。

const PIN = fileURLToPath(new URL('./helpers/okScreenshot.css', import.meta.url));
const SHOT = { animations: 'disabled' as const, stylePath: PIN, scale: 'css' as const };

async function boot(page: Page, daylight: boolean) {
    await installBaseState(page, { neteaseMode: 'guest' });
    await page.addInitScript((isDaylight) => {
        localStorage.setItem('folia_app_language', 'zh-CN');
        localStorage.setItem('default_theme_daylight', isDaylight ? 'true' : 'false');
        localStorage.setItem('follow_system_theme', 'false');
        const electron = (window as unknown as { electron?: Record<string, unknown> }).electron;
        if (!electron) return;
        electron.getSettings = async () => ({ AI_PROVIDER: 'gemini', AI_API_KEYS_CONFIGURED: {}, OPENAI_API_KEY_ENDPOINT: null });
        electron.getCacheDirectory = async () => ({ path: '', isDefault: true });
    }, daylight);
    await mockNeteaseApi(page, 'guest');
    await page.goto('/?okMock=1&skipStartup');
    await expect(page.getByRole('button', { name: '作品库', exact: true })).toBeVisible({ timeout: 60_000 });
}

async function openLiveSettings(page: Page) {
    await page.evaluate(async () => {
        const store = await import('/src/stores/useSettingsModalStore.ts');
        store.useSettingsModalStore.getState().openSettings('options', 'live');
    });
    await expect(page.getByRole('heading', { name: '直播模式', exact: true })).toBeVisible();
}

test.describe('ok唱歌 surfaces', () => {
    for (const daylight of [false, true] as const) {
        const theme = daylight ? 'light' : 'dark';

        test(`captures ${theme} stems, live bar, live settings, works and cover`, async ({ page }) => {
            test.setTimeout(150_000);
            await boot(page, daylight);

            await expect(page.getByTestId('ok-live-bar')).toHaveScreenshot(`ok-live-bar-${theme}.png`, SHOT);

            await page.getByRole('button', { name: '作品库', exact: true }).click();
            await expect(page.getByRole('button', { name: /暗号/ })).toBeVisible();
            await expect(page.getByText('周杰伦 - 稻香')).toBeVisible();
            await expect(page.getByText('没有音轨', { exact: true })).toBeVisible();
            await expect(page.getByTestId('ok-works')).toHaveScreenshot(`ok-works-${theme}.png`, SHOT);

            await page.getByRole('button', { name: /暗号/ }).click();
            await expect(page.getByRole('button', { name: '暂停', exact: true })).toBeVisible();
            await page.getByRole('button', { name: '暂停', exact: true }).click();
            await page.getByLabel('进度').evaluate((element: HTMLInputElement) => {
                const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
                setter?.call(element, '20');
                element.dispatchEvent(new Event('input', { bubbles: true }));
            });
            await expect(page.getByTestId('ok-transport')).toContainText('0:20');
            await expect(page.getByTestId('ok-transport')).toHaveScreenshot(`ok-transport-${theme}.png`, SHOT);
            await expect(page.getByTestId('ok-stems')).toHaveScreenshot(`ok-stems-${theme}.png`, SHOT);

            await page.getByRole('button', { name: '损坏作品', exact: false }).click();
            await expect(page.getByRole('alert').filter({ hasText: '轨道读不了' })).toBeVisible();

            await page.getByRole('button', { name: '关闭', exact: true }).click();
            await page.evaluate(() => {
                const mock = (window as unknown as { __okMock?: { disconnectPlugin: () => void } }).__okMock;
                mock?.disconnectPlugin();
            });
            await expect(page.getByText('未连接')).toBeVisible();
            await expect(page.getByText('本机')).toBeVisible();
            await expect(page.getByTestId('ok-live-bar')).toHaveScreenshot(`ok-live-disconnected-${theme}.png`, SHOT);

            await openLiveSettings(page);
            await expect(page.getByRole('dialog')).toHaveScreenshot(`ok-live-settings-${theme}.png`, SHOT);
            await page.keyboard.press('Escape');

            await page.getByRole('button', { name: '翻唱', exact: true }).click();
            await expect(page.getByText('未安装', { exact: true })).toBeVisible();
            await expect(page.getByTestId('ok-cover-component')).toHaveScreenshot(`ok-cover-entry-${theme}.png`, SHOT);

            await page.evaluate(() => {
                (window as unknown as { __okMock?: { setClockRate: (rate: number) => void } }).__okMock?.setClockRate(40);
            });
            await page.getByRole('button', { name: '安装组件', exact: true }).click();
            await expect(page.getByText('已安装', { exact: true })).toBeVisible({ timeout: 20_000 });
            await page.evaluate(() => {
                (window as unknown as { __okMock?: { setClockRate: (rate: number) => void } }).__okMock?.setClockRate(1);
            });
            await page.getByRole('button', { name: '开始翻唱', exact: true }).click();
            await expect(page.getByText(/转换/)).toBeVisible({ timeout: 20_000 });
            await expect(page.getByTestId('ok-cover-job')).toHaveScreenshot(`ok-cover-indeterminate-${theme}.png`, SHOT);

            await page.evaluate(() => {
                (window as unknown as { __okMock?: { setClockRate: (rate: number) => void } }).__okMock?.setClockRate(20);
            });
            await expect(page.getByRole('button', { name: '播放新作品', exact: true })).toBeVisible({ timeout: 20_000 });
            await page.evaluate(() => {
                (window as unknown as { __okMock?: { setClockRate: (rate: number) => void } }).__okMock?.setClockRate(1);
            });
            await page.getByRole('button', { name: '播放新作品', exact: true }).click();
            await expect(page.getByRole('button', { name: '暂停', exact: true })).toBeVisible();
        });
    }
});
