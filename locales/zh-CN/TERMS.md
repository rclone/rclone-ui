# 简体中文：术语与风格

Rclone UI 自己的用词怎么翻译，都记在这里，让整个应用说法一致。通用规则见 `locales/README.md`。

## 风格

- 称呼用“你”，不用“您”。
- 像一款好用的中文应用那样说话：简短、直接、自然。翻译意思，不逐词照搬英文。
- 按钮和菜单用简短的动词或名词：“开始复制”“卸载”“打开”。
- 使用全角标点（，。？！：“”），省略号用“…”。
- 中文与英文单词、数字之间加一个空格：“已挂载到 M:”“3 个文件”。
- 用户起的名字放在全角引号里，引号两边不加空格：编辑“{name}”、删除定时任务“{name}”？
  路径和远程存储名（如 {source}）照常与中文之间加空格。
- 某件事没做成的提示（“Schedule not paused”“Couldn't unmount”）用“无法…”：“无法暂停定时任务”。
- 时间用 24 小时制：“02:00”。
- 不翻译：Rclone UI、rclone、WinFsp、存储服务的名称（Google Drive、S3）、rclone 的选项
  （`--dry-run`）及其取值（`10M`、`1h30m`）、路径和远程存储的名称。

## 术语

| 英文 | 中文 | 说明 |
|---|---|---|
| remote | 远程存储 | 窗口标题也是“远程存储”。 |
| mount（动词） | 挂载 | |
| mount（名词） | 挂载 | “挂载 (2)”。 |
| mount point | 挂载点 | |
| unmount | 卸载 | |
| automount | 自动挂载 | |
| serve | 服务 | 窗口标题“服务”；“停止服务”。 |
| sync | 同步 | |
| bisync | 双向同步 | |
| copy | 复制 | |
| move | 移动 | |
| delete | 删除 | |
| purge | 清除 | 删除文件夹及其中的全部内容。 |
| download | 下载 | |
| upload | 上传 | |
| transfer | 传输 | |
| template | 模板 | |
| watcher | 监视器 | 监视两个文件夹，有变化就同步。 |
| schedule（名词） | 定时任务 | 窗口标题“定时任务”。 |
| schedule（动词） | 定时 | 按钮上用“定时”。 |
| Commander | 文件管理器 | |
| launcher | 启动器 | |
| history | 历史记录 | |
| settings | 设置 | |
| guide | 指南 | |
| notification | 通知 | |
| dry run, preview | 试运行、预览 | 菜单里用“预览”，解释时用“试运行”。 |
| option | 选项 | |
| flag | 选项 | rclone 的名称保持原样：`--dry-run`。 |
| cache | 缓存 | |
| config（rclone 的） | rclone 配置 | 文件名是 rclone.conf。 |
| password | 密码 | |
| folder | 文件夹 | |
| file | 文件 | |
| path | 路径 | |
| source | 源 | |
| destination | 目标 | |
| tray | 系统托盘 | macOS 上是“菜单栏”。 |
| this computer | 这台电脑 | |
| command | 命令 | “复制命令”。 |
| command line | 命令行 | |
| baseline（bisync） | 基线 | |
| Config（rclone 的通用选项组） | 通用 | “配置”已用于 rclone.conf。 |
| encrypt / encrypted | 加密 / 已加密 | |
| unlock / locked | 解锁 / 已锁定 | |
| system keychain | 系统钥匙串 | |
| shortcut | 快捷键 | |
| sign in | 登录 | “登录已过期”。 |
| reconnect | 重新连接 | |
| browse | 浏览 | |
| logs | 日志 | |
| favorites | 收藏 | |
| default | 默认 | |
| Check for updates | 检查更新 | |
| wizard | 向导 | |
| place（向导里的位置） | 位置 | |
| step | 步骤 | “第 2 步，共 5 步”。 |
| metadata / field / rule | 元数据 / 字段 / 规则 | |
| drive（盘符） | 磁盘 | |
| share / link | 共享 / 链接 | |
| tunnel / QR code | 隧道 / 二维码 | |
| phone | 手机 | |
| disable | 停用 | “关闭”表示 Close。 |
| Finder / File Explorer | 访达 / 文件资源管理器 | |
| file manager（系统自带的） | 文件浏览器 | “文件管理器”是 Commander。 |
| run（定时任务的一次运行） | 运行 | “下次运行：明天”“本次运行”。 |
| merge（文件夹） | 合并 | |
| resync | 重新同步 | |
| duplicate | 创建副本 | “复制”已经表示 copy。 |
| every weekday | 每个工作日 | |
| custom | 自定义 | |
| cron expression | Cron 表达式 | |
| filters | 筛选条件 | |
| add / edit | 添加 / 编辑 | |
| Disk Usage | 空间占用 | 文件管理器里的工具，扫描整个远程存储或磁盘：“扫描”“正在扫描…”“重新扫描”。远程存储不是磁盘，所以不用“磁盘用量”。 |
| AI agent / agent | AI 智能体 / 智能体 | 像 Claude Code、Cursor 这样替你使用 Rclone UI 的应用。设置里的分组叫“智能体”。不用“代理”，它容易和网络代理（proxy）混淆。 |
| MCP | MCP | 智能体连接所用的协议，不翻译。 |
| token | 令牌 | 通过地址连接的应用要发送它。“新令牌”。 |
| port | 端口 | |
| header（HTTP） | 请求头 | 请求头的名称 `Authorization` 不翻译。 |
| address（服务器的） | 地址 | 应用连接的 URL。 |
| OK / Cancel / Close | 确定 / 取消 / 关闭 | |
| Open / Quit / Retry | 打开 / 退出 / 重试 | |
