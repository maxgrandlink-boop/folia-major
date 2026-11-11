// src/product/okChang.ts
// ok唱歌 相对 Folia 关掉的两块表面。代码都留着，开关只在这里。
// 测试要照旧走这些入口时，把对应的 VITE_OKCHANG_* 设成 1（Playwright 的 webServer 如此）。
// 主进程读的是不带 VITE_ 前缀的同名变量，见 electron/main.cjs。

export const PRODUCT_NAME = 'ok唱歌';

const envFlag = (name: string): boolean => {
    const value = (import.meta.env as Record<string, unknown>)[name];
    return value === '1' || value === 'true' || value === true;
};

/** D2：商业在线曲库的界面入口。歌词匹配不看这个开关。 */
export const onlineCatalogUiEnabled = envFlag('VITE_OKCHANG_ONLINE_CATALOG');

/** D3：是否加载 Folium，以及设置里是否出现模组页。 */
export const foliumEnabled = envFlag('VITE_OKCHANG_FOLIUM');

/** 在线曲库入口关掉时，搜索来源只留本地和 Navidrome。 */
export const catalogSearchSource = <T extends string>(source: T): T | 'local' => (
    onlineCatalogUiEnabled || source === 'local' || source === 'navidrome' ? source : 'local'
);
