import { X } from 'lucide-react';

interface ExplorePageProps {
  onClose: () => void;
}

/**
 * P6 探索页（04 D7 / M9-1）：生态地图、Feature App 发布位、Works with Aha、
 * 社区配置包。首版静态展示 + 「开发中」徽章，无后端依赖。
 */
export function ExplorePage({ onClose }: ExplorePageProps) {
  return (
    <div className="aha-explore" role="dialog" aria-label="探索">
      <header className="aha-explore-head">
        <h2 className="aha-explore-title">探索</h2>
        <button type="button" className="aha-icon-btn" onClick={onClose} aria-label="关闭探索">
          <X size={16} />
        </button>
      </header>

      <section className="aha-explore-section">
        <div className="aha-explore-label">Works with Aha</div>
        <div className="aha-explore-grid">
          <div className="aha-explore-card aha-explore-card-feature">
            <div className="aha-explore-card-icon">⌨️</div>
            <div className="aha-explore-card-name">AhaKey X1</div>
            <p className="aha-explore-card-desc">
              实体四键 + 灯效 + OLED。批准键灯色 = 软件里的琥珀信号色；连接后虚拟键盘自动让位。
            </p>
            <span className="aha-dev-tag">设备配置 · 开发中</span>
          </div>
          <div className="aha-explore-card aha-explore-card-feature">
            <div className="aha-explore-card-icon">🖥️</div>
            <div className="aha-explore-card-name">AhaStation</div>
            <p className="aha-explore-card-desc">
              掌机形态 + 陪伴屏，双屏热插拔迁移。随硬件线发布启用。
            </p>
            <span className="aha-dev-tag">硬件线 · 开发中</span>
          </div>
        </div>
      </section>

      <section className="aha-explore-section">
        <div className="aha-explore-label">Feature Apps</div>
        <div className="aha-explore-grid">
          <div className="aha-explore-card">
            <div className="aha-explore-card-icon">🎙</div>
            <div className="aha-explore-card-name">AhaMeet</div>
            <p className="aha-explore-card-desc">会议模式已内置——你正在使用的就是它。</p>
            <span className="aha-explore-live">已启用</span>
          </div>
          <div className="aha-explore-card">
            <div className="aha-explore-card-icon">☁️</div>
            <div className="aha-explore-card-name">AhaTalk Cloud</div>
            <p className="aha-explore-card-desc">托管 ASR / 整理 / 词库同步，Pro 承接。</p>
            <span className="aha-dev-tag">开发中</span>
          </div>
        </div>
      </section>

      <section className="aha-explore-section">
        <div className="aha-explore-label">社区配置包</div>
        <div className="aha-explore-card">
          <div className="aha-explore-card-icon">🎨</div>
          <div className="aha-explore-card-name">灯效 / 键位 / 客户端配置分享</div>
          <p className="aha-explore-card-desc">
            分享与一键导入社区配置包（M9-4），依赖配置导入导出（M4-16）。
          </p>
          <span className="aha-dev-tag">开发中</span>
        </div>
      </section>
    </div>
  );
}
