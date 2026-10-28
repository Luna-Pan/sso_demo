import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { App as AntdApp, Button, Form, Input } from 'antd';
import BrandTitle from '../components/BrandTitle';
import {
  authOidcParams,
  buildBridgeEstablishUrl,
  idpApiRegister,
  idpApiSmsSend,
  type ApiError,
  type OidcParams,
} from '../api';
import { markLoggedIn } from '../auth-context';

interface RegisterForm {
  phone: string;
  code: string;
  password: string;
  nickname: string;
}

function resolveNext(loc: ReturnType<typeof useLocation>): string {
  const state = (loc.state as { next?: string } | null) ?? null;
  if (state?.next) return state.next;
  const q = new URLSearchParams(loc.search).get('next');
  return q ?? '/';
}

export default function Register() {
  const [form] = Form.useForm<RegisterForm>();
  const [submitting, setSubmitting] = useState(false);
  const [sending, setSending] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const timerRef = useRef<number | null>(null);
  const { message } = AntdApp.useApp();
  const location = useLocation();
  const next = resolveNext(location);

  useEffect(() => () => {
    if (timerRef.current) window.clearInterval(timerRef.current);
  }, []);

  function startCountdown(seconds = 60) {
    setCountdown(seconds);
    timerRef.current = window.setInterval(() => {
      setCountdown((c) => {
        if (c <= 1) {
          if (timerRef.current) window.clearInterval(timerRef.current);
          return 0;
        }
        return c - 1;
      });
    }, 1000);
  }

  async function handleSendSms() {
    try {
      await form.validateFields(['phone']);
    } catch {
      return;
    }
    const phone = form.getFieldValue('phone');
    setSending(true);
    try {
      const res = await idpApiSmsSend(phone, 'register');
      if (res.devCode) {
        message.success(`开发模式验证码：${res.devCode}`);
        form.setFieldValue('code', res.devCode);
      } else {
        message.success('验证码已发送');
      }
      startCountdown();
    } catch (err) {
      const e = err as ApiError;
      message.error(e.message || '验证码发送失败');
    } finally {
      setSending(false);
    }
  }

  async function handleSubmit(values: RegisterForm) {
    setSubmitting(true);
    try {
      const [reg, oidc]: [
        { ticket: string; userId?: string },
        OidcParams,
      ] = await Promise.all([
        idpApiRegister({
          phone: values.phone,
          code: values.code,
          password: values.password,
          nickname: values.nickname,
        }),
        authOidcParams(next),
      ]);
      markLoggedIn();
      const url = buildBridgeEstablishUrl(oidc, reg.ticket, next);
      window.location.href = url;
    } catch (err) {
      const e = err as ApiError;
      message.error(e.message || '注册失败，请稍后再试');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{ maxWidth: 460, margin: '40px auto 0' }}>
      <div className="glass-card">
        <BrandTitle size="sm">创建账号</BrandTitle>
        <p style={{ color: 'rgba(240,240,245,0.65)', marginTop: 8, marginBottom: 28 }}>
          手机号注册即开通 Reely 统一身份，全站通行
        </p>

        <Form
          form={form}
          layout="vertical"
          onFinish={handleSubmit}
          requiredMark={false}
          autoComplete="off"
        >
          <Form.Item
            label="昵称"
            name="nickname"
            rules={[
              { required: true, message: '请输入昵称' },
              { max: 32, message: '昵称不超过 32 字符' },
            ]}
          >
            <Input size="large" placeholder="你喜欢的昵称" maxLength={32} />
          </Form.Item>

          <Form.Item
            label="手机号"
            name="phone"
            rules={[
              { required: true, message: '请输入手机号' },
              { pattern: /^1[3-9]\d{9}$/, message: '请输入有效的中国大陆手机号' },
            ]}
          >
            <Input size="large" placeholder="11 位手机号" maxLength={11} />
          </Form.Item>

          <Form.Item
            label="验证码"
            name="code"
            rules={[{ required: true, message: '请输入验证码' }]}
          >
            <div style={{ display: 'flex', gap: 10 }}>
              <Input size="large" placeholder="6 位验证码" maxLength={6} style={{ flex: 1 }} />
              <Button
                size="large"
                disabled={countdown > 0}
                loading={sending}
                onClick={handleSendSms}
                className="reely-btn-ghost"
                style={{ flexShrink: 0 }}
              >
                {countdown > 0 ? `${countdown}s 后重发` : '获取验证码'}
              </Button>
            </div>
          </Form.Item>

          <Form.Item
            label="密码"
            name="password"
            rules={[
              { required: true, message: '请设置密码' },
              { min: 8, message: '密码至少 8 位' },
            ]}
            hasFeedback
          >
            <Input.Password size="large" placeholder="至少 8 位，建议包含字母和数字" />
          </Form.Item>

          <Form.Item
            label="确认密码"
            name="confirm"
            dependencies={['password']}
            rules={[
              { required: true, message: '请再次输入密码' },
              ({ getFieldValue }) => ({
                validator(_, value) {
                  if (!value || getFieldValue('password') === value) return Promise.resolve();
                  return Promise.reject(new Error('两次密码不一致'));
                },
              }),
            ]}
          >
            <Input.Password size="large" placeholder="再次输入密码" />
          </Form.Item>

          <Button
            htmlType="submit"
            size="large"
            block
            loading={submitting}
            className="reely-btn-primary"
          >
            注册并登录
          </Button>

          <div style={{ textAlign: 'center', marginTop: 16, fontSize: 13, color: 'rgba(240,240,245,0.6)' }}>
            已有账号？
            <Link to="/login" style={{ color: 'inherit', marginLeft: 4 }}>
              去登录 →
            </Link>
          </div>
        </Form>
      </div>
    </div>
  );
}
