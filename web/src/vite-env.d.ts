/// <reference types="vite/client" />

declare const __BRAND__: 'a' | 'b' | 'c';
declare const __BRAND_NAME__: string;
declare const __BRAND_COLOR__: string;
declare const __BRAND_COLOR_SECONDARY__: string;
declare const __BRAND_GRADIENT__: string;
declare const __BRAND_LOGO_INITIAL__: string;
declare const __BRAND_HERO_TITLE__: string;
declare const __BRAND_HERO_TAGLINE__: string;
declare const __BRAND_HERO_BG_HUE__: number;
declare const __BFF_PORT__: number;

interface Window {
  __SSO_BRAND__?: 'a' | 'b' | 'c';
  __SSO_BRAND_NAME__?: string;
  __SSO_BRAND_COLOR__?: string;
}
