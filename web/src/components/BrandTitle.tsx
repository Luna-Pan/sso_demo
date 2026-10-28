interface Props {
  children: React.ReactNode;
  size?: 'sm' | 'md' | 'lg';
}

/**
 * 品牌渐变大标题 —— 用 CSS 变量 --brand-gradient 着色。
 * 页面直接 `<BrandTitle>标题文字</BrandTitle>` 即可。
 */
export default function BrandTitle({ children, size = 'lg' }: Props) {
  return (
    <h1 className={size === 'sm' ? 'brand-title-sm' : 'brand-title'}>{children}</h1>
  );
}
