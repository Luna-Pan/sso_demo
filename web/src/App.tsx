import { useEffect, useRef } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { App as AntdApp } from 'antd';
import { useAuth } from './auth-context';
import Header from './components/Header';
import Home from './pages/Home';
import Login from './pages/Login';
import Register from './pages/Register';
import Profile from './pages/Profile';

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, initialized, loading } = useAuth();
  const location = useLocation();
  if (!initialized || loading) return null;
  if (!user) {
    return (
      <Navigate
        to="/login"
        replace
        state={{ next: location.pathname + location.search }}
      />
    );
  }
  return <>{children}</>;
}

function LoggedOutToast() {
  const loc = useLocation();
  const { message } = AntdApp.useApp();
  const fired = useRef(false);

  useEffect(() => {
    if (fired.current) return;
    if (new URLSearchParams(loc.search).get('loggedout') === '1') {
      fired.current = true;
      message.success('已退出登录');
    }
  }, [loc.search, message]);

  return null;
}

export default function AppRoutes() {
  return (
    <div className="sso-shell">
      <LoggedOutToast />
      <Header />
      <main className="sso-main">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />
          <Route
            path="/profile"
            element={
              <RequireAuth>
                <Profile />
              </RequireAuth>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
      <footer className="sso-footer">
        © {new Date().getFullYear()} SSO · 统一身份认证演示
      </footer>
    </div>
  );
}
