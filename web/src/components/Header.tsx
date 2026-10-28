import { Link } from 'react-router-dom';
import { Button } from 'antd';
import { useAuth } from '../auth-context';
import { runtimeBrand } from '../brand';

export default function Header() {
  const { user, logoutLocal, logoutGlobal } = useAuth();

  return (
    <header
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 50,
        backdropFilter: 'blur(18px)',
        WebkitBackdropFilter: 'blur(18px)',
        background: 'rgba(10, 10, 20, 0.55)',
        borderBottom: '1px solid rgba(255,255,255,0.08)',
      }}
    >
      <div
        style={{
          maxWidth: 1120,
          margin: '0 auto',
          padding: '14px 24px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 16,
        }}
      >
        {/* 左：Logo + 站点名 */}
        <Link
          to="/"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            textDecoration: 'none',
            color: 'inherit',
          }}
        >
          <div
            aria-hidden
            style={{
              width: 38,
              height: 38,
              borderRadius: 12,
              background: runtimeBrand.gradient,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontFamily: '"Inter Tight", system-ui',
              fontWeight: 900,
              fontSize: 18,
              color: '#fff',
              boxShadow: `0 8px 24px -8px ${runtimeBrand.brandColor}`,
            }}
          >
            {runtimeBrand.logoInitial}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.15 }}>
            <span
              style={{
                fontFamily: '"Inter Tight", system-ui',
                fontWeight: 800,
                fontSize: 16,
                letterSpacing: '-0.01em',
              }}
            >
              {runtimeBrand.brandName}
            </span>
            <span style={{ fontSize: 11, color: 'rgba(240,240,245,0.55)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
              Reely · SSO
            </span>
          </div>
        </Link>

        {/* 右：用户 / 登录 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {user ? (
            <>
              <Link to="/profile" style={{ color: 'inherit', textDecoration: 'none' }}>
                <Button className="reely-btn-ghost">
                  个人中心 · {user.nickname ?? user.username ?? user.id.slice(0, 8)}
                </Button>
              </Link>
              <Button
                onClick={() => void logoutLocal()}
                style={{ background: 'transparent', border: '1px solid rgba(255,255,255,0.14)', color: 'rgba(240,240,245,0.75)' }}
              >
                本地登出
              </Button>
              <Button
                danger
                onClick={() => logoutGlobal()}
              >
                全局登出
              </Button>
            </>
          ) : (
            <>
              <Link to="/register">
                <Button className="reely-btn-ghost">注册</Button>
              </Link>
              <Link to="/login">
                <Button className="reely-btn-primary">登录</Button>
              </Link>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
