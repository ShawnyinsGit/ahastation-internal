/**
 * P7 设置占位区块（04 §9.1）：账号/Pro、AhaTalk 处理路径与词库、
 * AhaKey 设备配置（数字孪生编辑器）——后端均未建设，统一「开发中」徽章。
 */
export function UpcomingSettingsPanel() {
  return (
    <section className="aha-settings-upcoming">
      <div className="aha-settings-upcoming-head">AhaStudio 新表面</div>

      <div className="aha-settings-upcoming-item">
        <div className="aha-settings-upcoming-name">账号与 AhaStudio Pro</div>
        <p className="aha-settings-upcoming-desc">
          登录 / 注册 / 订阅（$10/月 · 中国区 ¥39/月）、充值包与订单查询。社区版全部本地能力永久免费。
        </p>
        <span className="aha-dev-tag">开发中</span>
      </div>

      <div className="aha-settings-upcoming-item">
        <div className="aha-settings-upcoming-name">AhaTalk 处理路径与词库</div>
        <p className="aha-settings-upcoming-desc">
          本地 / 自有 Key / AhaTalk Cloud 三路径切换（禁止静默切换计费来源）；本地项目词库与跨设备同步。
        </p>
        <span className="aha-dev-tag">开发中</span>
      </div>

      <div className="aha-settings-upcoming-item">
        <div className="aha-settings-upcoming-name">AhaKey 设备配置</div>
        <p className="aha-settings-upcoming-desc">
          数字孪生编辑器：四模式键位映射、宏、OLED 动图、9 状态 × 17 灯效、拨杆语义与 IDE 配置联动。
        </p>
        <span className="aha-dev-tag">开发中</span>
      </div>

      <div className="aha-settings-upcoming-item">
        <div className="aha-settings-upcoming-name">交接与同步</div>
        <p className="aha-settings-upcoming-desc">
          Sync Vault 加密检查点、跨设备 Handoff（同一任务始终只有一个执行节点）、Trusted Device 配对。
        </p>
        <span className="aha-dev-tag">开发中</span>
      </div>
    </section>
  );
}
