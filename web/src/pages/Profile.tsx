import { useEffect, useState } from 'react';
import { App as AntdApp, Button, Card, Descriptions, Divider, Modal, Space, Tag, Form, Input } from 'antd';
import { useAuth } from '../auth-context';
import Loading from '../components/Loading';
import BrandTitle from '../components/BrandTitle';
import {
  idpApiAccountBindings,
  idpApiAccountProfile,
  idpApiAccountUnbind,
  idpApiBindPhone,
  idpApiSetPassword,
  idpApiSmsSend,
  type ApiError,
  type AccountBinding,
  type AccountProfile,
} from '../api';

interface BindPhoneForm { phone: string; code: string; }
interface SetPasswordForm { password: string; confirm: string; }

export default function Profile() {
  const { user, logoutLocal, logoutGlobal, refresh } = useAuth();
  const { message, modal } = AntdApp.useApp();

  const [profile, setProfile] = useState<AccountProfile | null>(null);
  const [bindings, setBindings] = useState<AccountBinding[]>([]);
  const [loading, setLoading] = useState(true);

  const [bindPhoneOpen, setBindPhoneOpen] = useState(false);
  const [setPwdOpen, setSetPwdOpen] = useState(false);
  const [bindForm] = Form.useForm<BindPhoneForm>();
  const [pwdForm] = Form.useForm<SetPasswordForm>();
  const [countdown, setCountdown] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [p, b] = await Promise.all([
          idpApiAccountProfile(),
          idpApiAccountBindings(),
        ]);
        if (cancelled) return;
        setProfile(p);
        setBindings(b);
      } catch (err) {
        const e = err as ApiError;
        message.error(e.status === 401 ? '会话已过期，请重新登录' : (e.message || '加载资料失败'));
        if (e.status === 401) void refresh();
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [message, refresh]);

  function startCountdown(seconds = 60) {
    setCountdown(seconds);
    const t = window.setInterval(() => {
      setCountdown((c) => {
        if (c <= 1) { window.clearInterval(t); return 0; }
        return c - 1;
      });
    }, 1000);
  }

  async function sendBindPhoneCode() {
    try { await bindForm.validateFields(['phone']); } catch { return; }
    const phone = bindForm.getFieldValue('phone');
    try {
      const res = await idpApiSmsSend(phone, 'bindphone');
      if (res.devCode) {
        message.success(`开发模式验证码：${res.devCode}`);
        bindForm.setFieldValue('code', res.devCode);
      } else {
        message.success('验证码已发送');
      }
      startCountdown();
    } catch (err) {
      const e = err as ApiError;
      message.error(e.message || '验证码发送失败');
    }
  }

  async function handleBindPhone() {
    const values = await bindForm.validateFields();
    try {
      await idpApiBindPhone(values.phone, values.code);
      message.success('手机号绑定成功');
      setBindPhoneOpen(false);
      bindForm.resetFields();
      // 刷新资料
      const [p, b] = await Promise.all([
        idpApiAccountProfile(), idpApiAccountBindings(),
      ]);
      setProfile(p); setBindings(b);
    } catch (err) {
      const e = err as ApiError;
      message.error(e.message || '绑定失败');
    }
  }

  async function handleSetPassword() {
    const values = await pwdForm.validateFields();
    try {
      await idpApiSetPassword(values.password);
      message.success('密码设置成功');
      setSetPwdOpen(false);
      pwdForm.resetFields();
      const p = await idpApiAccountProfile();
      setProfile(p);
    } catch (err) {
      const e = err as ApiError;
      message.error(e.message || '密码设置失败');
    }
  }

  async function handleUnbind(item: AccountBinding) {
    const ok = await modal.confirm({
      title: `确认解绑 ${labelOf(item.identityType)}？`,
      content: `解绑后将无法通过 ${labelOf(item.identityType)} 登录本账号。`,
      okButtonProps: { danger: true },
      okText: '确认解绑',
      cancelText: '取消',
    });
    if (!ok) return;
    try {
      await idpApiAccountUnbind(item.identityType, item.externalUniqueId);
      message.success('已解绑');
      setBindings((arr) => arr.filter((b) =>
        !(b.identityType === item.identityType && b.externalUniqueId === item.externalUniqueId)
      ));
    } catch (err) {
      const e = err as ApiError;
      message.error(e.message || '解绑失败');
    }
  }

  function handleBindFed(provider: 'vso' | 'wechat') {
    // 已登录态 BFF 自动加 access_token → 跳 IdP /auth/fed/{provider}/start → 回 BFF bind 模式
    window.location.href = `/account/bind/${provider}/start`;
  }

  function labelOf(t: string): string {
    switch (t) {
      case 'reely': return 'Reely 账号';
      case 'vso': return 'VSO';
      case 'wechat': return '微信';
      default: return t.toUpperCase();
    }
  }

  if (loading) return <Loading tip="加载个人资料…" />;

  return (
    <div style={{ maxWidth: 860, margin: '24px auto 0' }}>
      <div className="glass-card" style={{ marginBottom: 20 }}>
        <BrandTitle size="sm">个人中心</BrandTitle>
        <p style={{ color: 'rgba(240,240,245,0.6)', marginTop: 6, marginBottom: 24 }}>
          {profile?.nickname ?? user?.nickname ?? ''} · {user?.id}
        </p>

        <Descriptions
          column={{ xs: 1, sm: 2 }}
          labelStyle={{ color: 'rgba(240,240,245,0.55)', width: 120 }}
          contentStyle={{ color: 'rgba(240,240,245,0.9)' }}
        >
          <Descriptions.Item label="账号 ID">{profile?.id ?? user?.id}</Descriptions.Item>
          <Descriptions.Item label="昵称">{profile?.nickname ?? user?.nickname ?? '—'}</Descriptions.Item>
          <Descriptions.Item label="手机">{profile?.phone ?? '—'}</Descriptions.Item>
          <Descriptions.Item label="邮箱">{profile?.email ?? '—'}</Descriptions.Item>
          <Descriptions.Item label="登录方式">
            {bindings.map((b) => (
              <Tag key={b.externalUniqueId} color="rgba(255,255,255,0.14)" style={{ marginRight: 6, marginBottom: 4 }}>
                {labelOf(b.identityType)}
              </Tag>
            ))}
          </Descriptions.Item>
        </Descriptions>

        <Divider style={{ borderColor: 'rgba(255,255,255,0.08)', margin: '20px 0' }} />

        <Space wrap size={12}>
          {!profile?.phone && (
            <Button className="reely-btn-ghost" onClick={() => setBindPhoneOpen(true)}>
              绑定手机号
            </Button>
          )}
          {!profile?.hasPassword && (
            <Button className="reely-btn-ghost" onClick={() => setSetPwdOpen(true)}>
              设置登录密码
            </Button>
          )}
          <Button onClick={() => void logoutLocal()}>本地登出（清本站）</Button>
          <Button danger onClick={() => logoutGlobal()}>全局登出（全部站点）</Button>
        </Space>
      </div>

      {/* 绑定管理 */}
      <Card
        className="glass-card"
        title={<span style={{ fontFamily: '"Inter Tight", system-ui', fontWeight: 700 }}>绑定管理</span>}
        style={{ background: 'transparent', border: 'none' }}
        styles={{ body: { padding: 24 } }}
      >
        {bindings.length === 0 ? (
          <div style={{ color: 'rgba(240,240,245,0.5)', fontSize: 14 }}>
            暂无绑定的登录方式
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 12 }}>
            {bindings.map((b) => (
              <div
                key={`${b.identityType}-${b.externalUniqueId}`}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '14px 18px',
                  borderRadius: 14,
                  background: 'rgba(255,255,255,0.04)',
                  border: '1px solid rgba(255,255,255,0.08)',
                }}
              >
                <div>
                  <div style={{ fontWeight: 600 }}>{labelOf(b.identityType)}</div>
                  <div style={{ fontSize: 12, color: 'rgba(240,240,245,0.55)', marginTop: 2 }}>
                    {b.nickname ?? b.externalUniqueId}
                    {b.boundAt ? ` · ${b.boundAt}` : ''}
                  </div>
                </div>
                <Button
                  danger
                  size="small"
                  onClick={() => void handleUnbind(b)}
                  disabled={b.identityType === 'reely' && bindings.filter(x => x.identityType === 'reely').length <= 1}
                >
                  解绑
                </Button>
              </div>
            ))}
          </div>
        )}

        <Divider style={{ borderColor: 'rgba(255,255,255,0.08)', margin: '20px 0' }} />

        <Space wrap size={12}>
          <Button className="reely-btn-vso" onClick={() => handleBindFed('vso')}>
            {bindings.some(b => b.identityType === 'vso') ? '重新绑定 VSO' : '绑定 VSO 账号'}
          </Button>
          <Button className="reely-btn-wechat" onClick={() => handleBindFed('wechat')}>
            {bindings.some(b => b.identityType === 'wechat') ? '重新绑定微信' : '绑定微信账号'}
          </Button>
        </Space>
      </Card>

      {/* 绑手机弹窗 */}
      <Modal
        open={bindPhoneOpen}
        title="绑定手机号"
        onCancel={() => setBindPhoneOpen(false)}
        onOk={() => void handleBindPhone()}
        okText="确认绑定"
        cancelText="取消"
      >
        <Form form={bindForm} layout="vertical">
          <Form.Item label="手机号" name="phone" rules={[
            { required: true, message: '请输入手机号' },
            { pattern: /^1[3-9]\d{9}$/, message: '请输入有效的手机号' },
          ]}>
            <Input size="large" maxLength={11} placeholder="11 位手机号" />
          </Form.Item>
          <Form.Item label="验证码" name="code" rules={[{ required: true, message: '请输入验证码' }]}>
            <div style={{ display: 'flex', gap: 10 }}>
              <Input size="large" maxLength={6} placeholder="6 位验证码" style={{ flex: 1 }} />
              <Button
                size="large"
                disabled={countdown > 0}
                onClick={() => void sendBindPhoneCode()}
                className="reely-btn-ghost"
                style={{ flexShrink: 0 }}
              >
                {countdown > 0 ? `${countdown}s` : '获取验证码'}
              </Button>
            </div>
          </Form.Item>
        </Form>
      </Modal>

      {/* 设密码弹窗 */}
      <Modal
        open={setPwdOpen}
        title="设置登录密码"
        onCancel={() => setSetPwdOpen(false)}
        onOk={() => void handleSetPassword()}
        okText="确认设置"
        cancelText="取消"
      >
        <Form form={pwdForm} layout="vertical">
          <Form.Item
            label="密码"
            name="password"
            rules={[
              { required: true, message: '请输入密码' },
              { min: 8, message: '密码至少 8 位' },
            ]}
            hasFeedback
          >
            <Input.Password size="large" placeholder="至少 8 位" />
          </Form.Item>
          <Form.Item
            label="确认密码"
            name="confirm"
            dependencies={['password']}
            rules={[
              { required: true, message: '请再次输入密码' },
              ({ getFieldValue }) => ({
                validator(_, v) {
                  if (!v || getFieldValue('password') === v) return Promise.resolve();
                  return Promise.reject(new Error('两次密码不一致'));
                },
              }),
            ]}
          >
            <Input.Password size="large" placeholder="再次输入密码" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
