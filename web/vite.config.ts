import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

type BrandKey = 'mind' | 'nexus' | 'train';

interface BrandConfig {
  brandId: BrandKey;
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

const BRANDS: Record<BrandKey, BrandConfig> = {
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

function resolveBrand(mode: string, env: Record<string, string>): BrandConfig {
  const envBrand = (env.BRAND || '').toLowerCase() as BrandKey | '';
  const modeBrand = mode as BrandKey;
  const key: BrandKey = envBrand && BRANDS[envBrand]
    ? envBrand
    : BRANDS[modeBrand]
      ? modeBrand
      : 'mind';
  return BRANDS[key];
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const brand = resolveBrand(mode, env);
  const proxyTarget = `http://127.0.0.1:${brand.bffPort}`;

  return {
    plugins: [react()],
    define: {
      __BRAND__: JSON.stringify(brand.brandId),
      __BRAND_NAME__: JSON.stringify(brand.brandName),
      __BRAND_COLOR__: JSON.stringify(brand.brandColor),
      __BRAND_COLOR_SECONDARY__: JSON.stringify(brand.brandColorSecondary),
      __BRAND_GRADIENT__: JSON.stringify(brand.gradient),
      __BRAND_LOGO_INITIAL__: JSON.stringify(brand.logoInitial),
      __BRAND_HERO_TITLE__: JSON.stringify(brand.heroTitle),
      __BRAND_HERO_TAGLINE__: JSON.stringify(brand.heroTagline),
      __BRAND_HERO_BG_HUE__: JSON.stringify(brand.heroBgHue),
      __BFF_PORT__: JSON.stringify(brand.bffPort),
    },
    server: {
      host: true,
      port: brand.port,
      strictPort: true,
      proxy: {
        '/login/start': proxyTarget,
        '/dashboard': proxyTarget,
        '/auth/oidc-params': proxyTarget,
        '/auth/logout': proxyTarget,
        '/auth/me': proxyTarget,
        '/auth/callback': proxyTarget,
        '/auth/login': proxyTarget,
        '/idp-api': proxyTarget,
        '/account': proxyTarget,
      },
    },
    preview: {
      host: true,
      port: brand.port + 1000,
    },
    envPrefix: ['VITE_'],
  };
});
