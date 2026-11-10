import { expect, test, type Page } from '@playwright/test';
import { APP_VERSION, GUIDE_VERSION_STORAGE_KEY, waitForAppMounted } from '../helpers/appState';

// test/ui/helpCommunity.spec.ts
// 帮助页的社区入口。Discord 和 QQ 各是一行：Discord 打开邀请链接，QQ 旁边是群号和复制按钮。
// 页面曾经是一颗「加入社区」胶囊再弹出菜单；那颗胶囊已经不在了，两行直接摆在帮助页上。

const QQ_GROUP_NUMBER = '372521584';
const DISCORD_INVITE_URL = 'https://discord.com/invite/dMDBTHxeKd';

test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

const openHelp = async (page: Page, { clipboard }: { clipboard?: 'reject' | 'missing' } = {}) => {
    await page.addInitScript(([version, guideKey, mode]) => {
        localStorage.clear();
        localStorage.setItem('library_suite_prompt_seen', 'true');
        localStorage.setItem('folia_app_language', 'en');
        localStorage.setItem('static_mode', 'true');
        localStorage.setItem(guideKey, version);
        const opened: string[] = [];
        (window as unknown as { __opened: string[] }).__opened = opened;
        window.open = ((url?: string | URL) => {
            opened.push(String(url));
            return null;
        }) as typeof window.open;
        if (mode === 'reject') {
            navigator.clipboard.writeText = () => Promise.reject(new DOMException('Write permission denied.', 'NotAllowedError'));
        } else if (mode === 'missing') {
            // copyText 只在剪贴板 API 不存在时才退回 execCommand。API 在但拒绝写入，算失败，不退回。
            Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
        }
    }, [APP_VERSION, GUIDE_VERSION_STORAGE_KEY, clipboard ?? ''] as const);
    await page.route('**/__mock_netease__/**', async (route) => {
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });
    await page.goto('/');
    await waitForAppMounted(page);
    await page.evaluate(async () => {
        const storeModulePath = '/src/stores/useSettingsModalStore.ts';
        const { useSettingsModalStore } = await import(storeModulePath);
        useSettingsModalStore.getState().openSettings('help');
    });
};

const settings = (page: Page) => page.getByRole('dialog', { name: 'Settings' });
const discordRow = (page: Page) => settings(page).locator('.st-row').filter({ hasText: 'Join the Discord community' });
const qqRow = (page: Page) => settings(page).locator('.st-row').filter({ hasText: QQ_GROUP_NUMBER });
const qqCopy = (page: Page) => qqRow(page).getByRole('button', { name: 'Copy', exact: true });
const openedUrls = (page: Page) => page.evaluate(() => (window as unknown as { __opened: string[] }).__opened);

test('Discord and the QQ group are rows on the help page, not one community menu', async ({ page }) => {
    await openHelp(page);

    await expect(discordRow(page)).toBeVisible();
    await expect(settings(page).getByRole('button', { name: 'Join the Discord community', exact: true })).toBeAttached();
    await expect(qqRow(page)).toContainText('QQ self-help group');
    await expect(qqCopy(page)).toBeVisible();
    await expect(settings(page).getByRole('button', { name: 'Join the community', exact: true })).toHaveCount(0);
    await expect(settings(page).getByRole('menu', { name: 'Join the community' })).toHaveCount(0);
});

test('the QQ copy button puts the group number on the clipboard', async ({ page }) => {
    await openHelp(page);
    await page.evaluate(() => navigator.clipboard.writeText(''));

    await qqCopy(page).click();

    await expect(qqRow(page).getByRole('status')).toHaveText('Copied');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(QQ_GROUP_NUMBER);
});

test('the Discord row opens the invite and leaves settings open', async ({ page }) => {
    await openHelp(page);

    await discordRow(page).click();

    expect(await openedUrls(page)).toEqual([DISCORD_INVITE_URL]);
    await expect(settings(page)).toBeVisible();
    await expect(discordRow(page)).toBeVisible();
});

test('a refused clipboard API says the copy failed', async ({ page }) => {
    await openHelp(page, { clipboard: 'reject' });

    await qqCopy(page).click();

    await expect(qqRow(page).getByRole('status')).toHaveText('Copy failed, please try again');
});

test('a missing clipboard API copies through the copy command', async ({ page }) => {
    await openHelp(page, { clipboard: 'missing' });

    await qqCopy(page).click();

    // execCommand 成功时按钮同样报「已复制」。API 被拿掉了，读不回剪贴板，只看这个结果。
    await expect(qqRow(page).getByRole('status')).toHaveText('Copied');
});
