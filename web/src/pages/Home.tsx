import { Link } from 'react-router-dom';
import { Button } from 'antd';
import { useAuth } from '../auth-context';
import BrandTitle from '../components/BrandTitle';
import { runtimeBrand } from '../brand';

export default function Home() {
  const { user } = useAuth();

  return (
    <div style={{ padding: '48px 0 64px' }}>
      <div className="glass-card" style={{ maxWidth: 760, margin: '0 auto', textAlign: 'center' }}>
        <BrandTitle>{runtimeBrand.heroTitle}</BrandTitle>
        <p
          style={{
            marginTop: 16,
            fontSize: 18,
            color: 'rgba(240,240,245,0.7)',
            letterSpacing: '0.02em',
          }}
        >
          {runtimeBrand.heroTagline}
        </p>

        <div
          style={{
            display: 'flex',
            gap: 12,
            justifyContent: 'center',
            marginTop: 40,
            flexWrap: 'wrap',
          }}
        >
          {user ? (
            <>
              <Link to="/profile">
                <Button size="large" className="reely-btn-primary">
                  前往个人中心
                </Button>
              </Link>
              <Link to="/">
                <Button size="large" className="reely-btn-ghost">
                  返回首页
                </Button>
              </Link>
            </>
          ) : (
            <>
              <Link to="/login">
                <Button size="large" className="reely-btn-primary">
                  立即登录
                </Button>
              </Link>
              <Link to="/register">
                <Button size="large" className="reely-btn-ghost">
                  创建账号
                </Button>
              </Link>
            </>
          )}
        </div>

        <div
          style={{
            marginTop: 56,
            paddingTop: 32,
            borderTop: '1px solid rgba(255,255,255,0.08)',
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
            gap: 20,
            textAlign: 'left',
          }}
        >
          {[
            { icon: '✧', title: '统一身份', desc: '一次登录，跨站通行' },
            { icon: '◈', title: '联邦接入', desc: 'VSO / 微信账号一键绑定' },
            { icon: '◎', title: '安全可控', desc: 'OIDC + PKCE + 本地会话' },
          ].map((f) => (
            <div key={f.title}>
              <div
                style={{
                  fontSize: 22,
                  background: runtimeBrand.gradient,
                  WebkitBackgroundClip: 'text',
                  backgroundClip: 'text',
                  color: 'transparent',
                  fontFamily: '"Inter Tight", system-ui',
                  fontWeight: 900,
                }}
              >
                {f.icon}
              </div>
              <div style={{ fontWeight: 700, marginTop: 4 }}>{f.title}</div>
              <div style={{ color: 'rgba(240,240,245,0.55)', fontSize: 13, marginTop: 2 }}>
                {f.desc}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
