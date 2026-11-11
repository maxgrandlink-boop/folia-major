// src/components/ok/okChrome.ts
// 主题强调色在深色里接近白、在浅色里是橙色。铺满按钮的字色跟着换，避免白字写在白底上。

export function okFillClass(isDaylight: boolean): string {
    return `bg-[var(--ok-accent)] ${isDaylight ? 'text-white' : 'text-neutral-950'}`;
}
