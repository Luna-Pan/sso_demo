// 运行时品牌配置 —— 与 vite.config.ts 中的 BRANDS 表保持同步，
// 页面组件在此通过 runtimeBrand 取数据。
// vite.config.ts 已通过 define 在编译期注入常量，这里也暴露 runtimeBrand 方便页面访问。

export type BrandId = 'mind' | 'nexus' | 'train';

export interface BrandConfig {
  brandId: BrandId;
  brandName: string;
  port: number;
  bffPort: number;
  brandColor: string;
  brandColorSecondary: string;
  gradient: string;
  logoInitial: string;
  heroTitle: string;
  heroTagline: string;
  heroBgHue: number;
}

export const BRANDS: Record<BrandId, BrandConfig> = {
  mind: {
    brandId: 'mind',
    brandName: 'ReelyMind',
    port: 3001,
    bffPort: 4001,
    brandColor: '#3855ff',
    brandColorSecondary: '#0ea5e9',
    gradient: 'linear-gradient(135deg, #3855ff 0%, #0ea5e9 100%)',
    logoInitial: 'M',
    heroTitle: 'ReelyMind',
    heroTagline: '沉静思维 · 清晰洞察',
    heroBgHue: 230,
  },
  nexus: {
    brandId: 'nexus',
    brandName: 'ReelyNexus',
    port: 3002,
    bffPort: 4002,
    brandColor: '#b14bff',
    brandColorSecondary: '#ec4899',
    gradient: 'linear-gradient(135deg, #b14bff 0%, #ec4899 100%)',
    logoInitial: 'N',
    heroTitle: 'ReelyNexus',
    heroTagline: '连接灵感 · 创造未来',
    heroBgHue: 280,
  },
  train: {
    brandId: 'train',
    brandName: 'ReelyTrain',
    port: 3003,
    bffPort: 4003,
    brandColor: '#14b8a6',
    brandColorSecondary: '#22c55e',
    gradient: 'linear-gradient(135deg, #14b8a6 0%, #22c55e 100%)',
    logoInitial: 'T',
    heroTitle: 'ReelyTrain',
    heroTagline: '持续成长 · 稳步前行',
    heroBgHue: 165,
  },
};

export function getBrand(id?: BrandId): BrandConfig {
  const key = id ?? __BRAND__;
  return BRANDS[key] ?? BRANDS.mind;
}

export const runtimeBrand: BrandConfig = BRANDS[__BRAND__] ?? BRANDS.mind;
