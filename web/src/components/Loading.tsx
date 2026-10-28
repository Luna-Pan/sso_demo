import { Spin } from 'antd';

export default function Loading({ tip = '加载中…' }: { tip?: string }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '80px 0',
      }}
    >
      <Spin size="large" tip={tip} />
    </div>
  );
}
