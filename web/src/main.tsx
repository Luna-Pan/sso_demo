import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ConfigProvider, App as AntdApp, Spin } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { AuthProvider, useAuth } from './auth-context';
import { runtimeBrand } from './brand';
import AppRoutes from './App';
import './styles/global.css';

// antd ConfigProvider 的主题 token —— 每个品牌覆盖品牌色
function buildTheme(primaryColor: string, secondaryColor: string) {
  return {
    token: {
      colorPrimary: primaryColor,
      colorLink: primaryColor,
      colorInfo: primaryColor,
      colorLinkHover: secondaryColor,
      colorBgLayout: 'transparent', // 背景由我们自己的 CSS 控制
      colorBgContainer: 'rgba(255,255,255,0.04)',
      borderRadius: 12,
      controlHeight: 40,
      fontFamily: '"Inter", system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif',
    },
    components: {
      Button: {
        controlHeight: 44,
        fontWeight: 600,
      },
      Input: {
        controlHeight: 44,
        colorBgContainer: 'rgba(255,255,255,0.06)',
        colorBorder: 'rgba(255,255,255,0.14)',
        colorText: '#f0f0f5',
        colorTextPlaceholder: 'rgba(240,240,245,0.45)',
        activeBorderColor: primaryColor,
        hoverBorderColor: primaryColor,
      },
      Form: {
        labelColor: 'rgba(240,240,245,0.75)',
      },
      Modal: {
        contentBg: 'rgba(18,18,28,0.92)',
        headerBg: 'transparent',
        titleColor: '#f0f0f5',
      },
      Message: {
        contentBg: 'rgba(18,18,28,0.92)',
        textColor: '#f0f0f5',
      },
      Card: {
        colorBorderSecondary: 'rgba(255,255,255,0.10)',
        colorBgContainer: 'rgba(255,255,255,0.04)',
      },
    },
  };
}

function BootLoading() {
  return (
    <div
      style={{
        position: 'fixed', inset: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: '#0a0a12', zIndex: 9999,
      }}
    >
      <Spin size="large" tip="初始化中…" />
    </div>
  );
}

function AuthGate({ children }: { children: React.ReactNode }) {
  const { loading, initialized } = useAuth();
  if (!initialized || loading) return <BootLoading />;
  return <>{children}</>;
}

const theme = buildTheme(runtimeBrand.brandColor, runtimeBrand.brandColorSecondary);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <ConfigProvider locale={zhCN} theme={theme}>
        <AntdApp>
          <AuthProvider>
            <AuthGate>
              <AppRoutes />
            </AuthGate>
          </AuthProvider>
        </AntdApp>
      </ConfigProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
