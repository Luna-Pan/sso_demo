import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  authMe,
  authLogoutLocal,
  buildGlobalLogoutUrl,
  type AuthUser,
  type ApiError,
} from './api';

interface AuthState {
  user: AuthUser | null;
  loading: boolean;
  initialized: boolean;
  skipBoot: boolean;
}

interface AuthContextValue extends AuthState {
  /** 重新探测登录态，返回当前用户（null = 未登录） */
  refresh: () => Promise<AuthUser | null>;
  logoutLocal: () => Promise<void>;
  logoutGlobal: () => void;
  setUser: (u: AuthUser | null) => void;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

const SKIP_BOOT_KEY = 'reely.auth.skipBoot';

function readSkipBoot(): boolean {
  try {
    return localStorage.getItem(SKIP_BOOT_KEY) === '1';
  } catch {
    return false;
  }
}

function writeSkipBoot(v: boolean): void {
  try {
    if (v) localStorage.setItem(SKIP_BOOT_KEY, '1');
    else localStorage.removeItem(SKIP_BOOT_KEY);
  } catch { /* noop */ }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [initialized, setInitialized] = useState(false);
  const skipBootRef = useRef<boolean>(readSkipBoot());

  // 返回本次探测到的登录态（null = 未登录）。
  // 调用方不能依赖闭包里的 user —— 该 effect 只执行一次，闭包里的 user 永远是首次渲染的 null，
  // 用它判断会导致「已登录用户每次刷新页面都被重新踢去走一遍静默授权」。
  const refresh = useCallback(async (): Promise<AuthUser | null> => {
    try {
      const me = await authMe();
      const current = me.loggedIn ? (me.user ?? null) : null;
      setUser(current);
      return current;
    } catch (err) {
      const e = err as ApiError;
      if (e.status !== 401) {
        console.warn('[Auth] /auth/me 异常', err);
      }
      setUser(null);
      return null;
    }
  }, []);

  // 启动时探测登录态
  useEffect(() => {
    let cancelled = false;
    async function boot() {
      setLoading(true);
      const current = skipBootRef.current ? null : await refresh();
      if (cancelled) return;
      setLoading(false);
      setInitialized(true);

      // 未登录且当前页面不是登录相关页 → 尝试静默 SSO 探测
      // 顶层跳 BFF /login/start（BFF 会拼 prompt=none 的 authorize），
      // 浏览器会自动带上 idp 域的 SSO Cookie（如果有的话）
      // —— 有 SSO 就免登回来，没有则 IdP 拒登录 → BFF 回跳 /login，自然落到手动登录页
      if (!current) {
        const p = window.location.pathname;
        // /login/start 是 BFF 处理的顶层跳转路由，React Router 不渲染但 fetch 仍会触发，
        // 必须列入白名单否则会无限递归跳自己
        const isAuthPage =
          p === '/login' ||
          p === '/register' ||
          p === '/auth/callback' ||
          p === '/auth/logout/cb' ||
          p === '/login/start';
        if (!isAuthPage) {
          const next = encodeURIComponent(window.location.pathname + window.location.search);
          window.location.replace(`/login/start?next=${next}`);
        }
      }
    }
    void boot();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const logoutLocal = useCallback(async () => {
    try { await authLogoutLocal(); } catch { /* ignore */ }
    setUser(null);
    writeSkipBoot(false);
  }, []);

  const logoutGlobal = useCallback(() => {
    // 顶层跳转 —— BFF 清本站会话后跳 IdP /logout
    writeSkipBoot(false);
    window.location.href = buildGlobalLogoutUrl();
  }, []);

  const value = useMemo<AuthContextValue>(() => ({
    user,
    loading,
    initialized,
    skipBoot: skipBootRef.current,
    refresh,
    logoutLocal,
    logoutGlobal,
    setUser,
  }), [user, loading, initialized, refresh, logoutLocal, logoutGlobal]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth 必须在 AuthProvider 内使用');
  return ctx;
}

// 登录后调用，让后续启动跳过 /auth/me 探测
export function markLoggedIn(): void {
  writeSkipBoot(false);
}
