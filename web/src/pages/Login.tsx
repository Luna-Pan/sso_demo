import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { App as AntdApp, Button, Checkbox, Form, Input } from 'antd';
import BrandTitle from '../components/BrandTitle';
import {
  authOidcParams,
  buildBridgeEstablishUrl,
  buildFedLoginUrl,
  idpApiLogin,
  type ApiError,
  type OidcParams,
} from '../api';
import { markLoggedIn } from '../auth-context';

interface LoginForm {
  account: string;
  password: string;
  remember?: boolean;
}

const DEFAULT_NEXT = '/';

/** 取登录成功后要回跳的页面：优先用 state.next，其次 query.next，都没则 DEFAULT_NEXT */
function resolveNext(loc: ReturnType<typeof useLocation>): string {
  const state = (loc.state as { next?: string } | null) ?? null;
  if (state?.next) return state.next;
  const q = new URLSearchParams(loc.search).get('next');
  return q ?? DEFAULT_NEXT;
}

export default function Login() {
  const [form] = Form.useForm<LoginForm>();
  const [submitting, setSubmitting] = useState(false);
  const [fedLoading, setFedLoading] = useState(false);
  const location = useLocation();
  const { message } = AntdApp.useApp();
  const next = resolveNext(location);

  async function submitLogin(values: LoginForm) {
    setSubmitting(true);
    try {
      const [ticketRes, oidc]: [
        { ticket: string },
        OidcParams,
      ] = await Promise.all([
        idpApiLogin(values.account, values.password),
        authOidcParams(next),
      ]);
      markLoggedIn();
      const url = buildBridgeEstablishUrl(oidc, ticketRes.ticket, next);
      // 顶层跳转 —— 走 IdP bridge → 回跳 BFF callback → BFF 种 cookie → 回前端
      window.location.href = url;
    } catch (err) {
      const e = err as ApiError;
      message.error(e.status === 401 ? '账号或密码错误' : e.message || '登录失败');
    } finally {
      setSubmitting(false);
    }
  }

  async function triggerFed(provider: 'vso' | 'wechat') {
    setFedLoading(true);
    try {
      const oidc = await authOidcParams(next);
      markLoggedIn();
      const url = buildFedLoginUrl(provider, oidc, next);
      window.location.href = url;
    } catch (err) {
      const e = err as ApiError;
      message.error(e.message || `${provider.toUpperCase()} 登录拉起失败`);
    } finally {
      setFedLoading(false);
    }
  }

  return (
    <div style={{ maxWidth: 460, margin: '40px auto 0' }}>
      <div className="glass-card">
        <BrandTitle size="sm">欢迎回来</BrandTitle>
        <p style={{ color: 'rgba(240,240,245,0.65)', marginTop: 8, marginBottom: 28 }}>
          使用账号密码登录，或通过联邦账号一键接入
        </p>

        <Form
          form={form}
          layout="vertical"
          onFinish={submitLogin}
          requiredMark={false}
          autoComplete="off"
        >
          <Form.Item
            label="账号"
            name="account"
            rules={[{ required: true, message: '请输入邮箱 / 手机号 / 用户名' }]}
          >
            <Input size="large" placeholder="邮箱 / 手机号 / 用户名" autoFocus />
          </Form.Item>

          <Form.Item
            label="密码"
            name="password"
            rules={[{ required: true, message: '请输入密码' }]}
          >
            <Input.Password size="large" placeholder="至少 8 位" />
          </Form.Item>

          <Form.Item style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <Form.Item name="remember" valuePropName="checked" noStyle>
                <Checkbox>记住我</Checkbox>
              </Form.Item>
              <Link to="/register" style={{ color: 'inherit', opacity: 0.75, fontSize: 13 }}>
                还没有账号？去注册 →
              </Link>
            </div>
          </Form.Item>

          <Button
            htmlType="submit"
            size="large"
            block
            loading={submitting}
            className="reely-btn-primary"
          >
            登录
          </Button>
        </Form>

        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          margin: '28px 0 20px',
          color: 'rgba(240,240,245,0.4)',
          fontSize: 12,
        }}>
          <div style={{ flex: 1, height: 1, background: 'rgba(255,255,255,0.08)' }} />
          <span>或使用联邦账号</span>
          <div style={{ flex: 1, height: 1, background: 'rgba(255,255,255,0.08)' }} />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Button
            size="large"
            loading={fedLoading}
            onClick={() => triggerFed('vso')}
            className="reely-btn-vso"
          >
            VSO 登录
          </Button>
          <Button
            size="large"
            loading={fedLoading}
            onClick={() => triggerFed('wechat')}
            className="reely-btn-wechat"
          >
            微信登录
          </Button>
        </div>
      </div>
    </div>
  );
}
