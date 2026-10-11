# 谱键 P2K：网页识谱 + 手机练琴

网页端上传 PDF、识谱并校对；注册用户名和密码后，把音符与指法存入自己的账号。手机端使用同一账号，流程为 **登录 → 是否连接电钢琴（蓝牙 / Type-C / 听琴声 / 跳过）→ 曲库选择 → 原谱预览与范围选择 → 演奏界面**。服务端不保存原 PDF，密码使用 PBKDF2-HMAC-SHA256 哈希，不存明文。当前没有短信登录、密码找回或邮箱验证功能。

## 电脑端识谱后自动同步

登录后，网页端只要完成一次识谱（或点“同步到云端”），就会**自动把音符和原始 PDF 一起上传到该账号**，工具栏的云端状态会显示进度与结果；不需要再手动确认上传 PDF。手机端回到前台、恢复网络或打开曲库时会自动重新拉取云端列表，因此电脑上调好的曲谱手机上打开就是最新的；打开曲谱时若本机还没缓存原谱会自动下载并缓存，之后可离线练习。

## 手机端「专属练习模式」（听音判定）

演奏界面点 **🎹 听音练习** 打开底部判定抽屉，三种方式任选：

- **蓝牙连接**：扫描并连接支持 BLE MIDI 的电钢琴（服务 UUID `03B80E5A-…-C700`），直接读取琴键，判定最准。安卓 12+ 首次会请求“附近的设备”权限（APK 已把 targetSdk 提到 34，否则系统会直接拒绝扫描）。
- **USB 连接（推荐给特伦斯 V30 系列）**：用 Type-C 数据线连接，通过 Android MIDI API 读取琴键。**特伦斯 V30 / V30 Pro 的蓝牙只支持音频（A2DP），没有蓝牙 MIDI**，所以蓝牙搜索是搜不到它的 —— 请用 Type-C 或听琴声。
- **听琴声**：打开麦克风，实时估计音高（自相关 + 抛物线插值，支持 E2–C6），任何钢琴都能用。安卓 APK 使用原生 `AudioRecord` 采集，因此局域网 HTTP 页面也能听音；网页版在 HTTPS 或 localhost 下用 `getUserMedia`。

判定规则：弹出当前高亮的音 → 自动进入下一音；弹错 → 停在本音重试并提示还差哪个音。抽屉里可调 **灵敏度**、**容差（严格 / ±1 / ±2 半音）** 和 **弹对自动下一音** 开关。

演奏界面本身仍保留 **▶ 自动演奏**（按拍号与速度自动弹奏，可循环范围）。

## 演奏界面布局

竖屏/横屏统一为**自上而下的流式布局**，不再有浮层遮挡：① 当前行谱面 → ② 当前音 / 下一音 → ③ 琴键 → ④ 底部控制区（曲名与退出｜上一个·自动演奏·暂停·下一个｜听音练习｜拍号速度｜键盘设置·音域·全屏）。听音练习与键盘设置是**底部浮层抽屉**，点面板外或“收起”即可关闭，不占据琴键空间。

## 左右手 / 和弦提示

- **右手 = 深蓝，左手 = 深橙**；需要弹的键用实色高亮，键面角标“右 / 左 / 双”。
- **只弹一个音**：只有那一个键高亮，上方显示“C4(1指) 右手”。
- **需要同时按多个键（和弦）**：所有要按的键变成**玫红色**，上方显示“同时按 N 键”，每个键标注哪只手。
- **下一音提示**：用浅青色“★”标在对应键上，和当前音的实色明显区分，避免看不清。

## 响应优化

- 谱面整页只渲染一次，切行只做裁剪绘制，不再每个音符重画整页。
- 打开曲谱时预解码前 32 个用得到的琴键采样，自动演奏/点键不再有首次解码卡顿。
- 蓝牙/USB 连接成功会自动进入曲库，不再停在连接页。

## 原谱离线

曲库里每首曲谱都有 **下载原谱离线** 按钮：把该账号的原始 PDF 取回并存入浏览器 IndexedDB（`p2k-offline-library-v1`）。之后曲谱卡片显示 **原谱已离线**，断网也能打开预览与逐行谱面。打开曲谱时如未缓存会先自动下载并缓存。

本机网页服务会把识谱请求转发给 `127.0.0.1:8765` 的 HOMR 进程，浏览器不再直接跨端口请求识谱服务。PDF 在浏览器本机读取并转成页图；在本机试用时，页图只会发给本机 `8766` API，再转发到本机 `8765`。工具栏可将包含 PDF 和识谱结果的存档保存到浏览器本机仓库（IndexedDB），无需联网查看；“同步到云端”只上传音符、节拍和指法，不上传 PDF。手机端联网打开云端曲谱时会缓存练习数据，后续可断网练习；手机端不缓存或显示原 PDF。

## 本机试用

需 Python 3.12（本工作区提供 `work/p2k-omr-venv`）。安装依赖（一次即可）：

```powershell
work\p2k-omr-venv\Scripts\python.exe -m pip install -r outputs\p2k-site\requirements-api.txt
work\p2k-omr-venv\Scripts\python.exe -m pip install -r outputs\p2k-site\requirements-omr.txt
```

启动服务：**只需运行 `service/start_p2k.py` 一个入口**（或用工作区根目录的 `start_p2k_phone_lan.bat`）：

```powershell
work\p2k-omr-venv\Scripts\python.exe service\start_p2k.py
```

- 主服务（网页 + 账号/曲库）监听 `8766`。
- **识谱引擎（HOMR，8765）平时不启动**，只在第一次点「AI 自动识谱」时由主服务按需拉起，之后继续复用；不需要手动开第二个窗口。识谱引擎启动状态可看 `GET /api/health` 的 `omr` 字段（`idle` / `running`），或 `GET /api/omr-health`。
- 手动单独调试识谱时可以运行 `work\p2k-omr-venv\Scripts\python.exe service\run_omr.py`。

网页端为 `http://127.0.0.1:8766/`，手机布局为 `http://127.0.0.1:8766/?mode=app`。开发环境也使用真正的用户名/密码登录；请勿将开发服务暴露到公网。

服务入口都集中在 `service/` 目录（见该目录内 `README.md`）：`start_p2k.py`（主服务）、`run_omr.py`（按需识谱引擎）。旧的 `work/run_p2k_app.py`、`work/run_p2k_omr.py` 仍可单独使用，但推荐用 `service/`。

### 同一 Wi-Fi 下连接 Android 手机

当前电脑的局域网地址为 `192.168.1.2`。在电脑上运行工作区根目录的 `start_p2k_phone_lan.bat`，保持命令窗口运行；手机和电脑连接同一 Wi-Fi 后，可在手机浏览器打开 `http://192.168.1.2:8766/?mode=app`。新版 APK 会默认尝试此地址，无需首次输入网址。若电脑 IP 改变，在 APK 首页按返回键进入连接设置并改成新的电脑局域网 IP。此局域网模式使用 HTTP，只适用于可信的私人 Wi-Fi；不要在公共 Wi-Fi 或公网使用。当前 Windows 将以太网标记为“公用网络”，系统防火墙可能阻止手机连接；仅在确认网络可信时，允许该端口通过本地网络访问。公网和跨 Wi-Fi 同步仍应部署 HTTPS 域名。

## 自托管部署

`deploy/` 提供 Docker Compose、Caddy HTTPS 反向代理、P2K API 和 HOMR 识谱服务的开源部署骨架。准备一台可运行 Docker 的 Linux 主机、绑定到该主机的域名，并确保公网 80/443 端口可达：

```bash
cp deploy/.env.example deploy/.env
# 编辑 deploy/.env：填写域名和足够随机的 P2K_TOKEN_SECRET
docker compose --env-file deploy/.env -f deploy/docker-compose.yml up -d --build
```

Caddy 会为域名自动申请 HTTPS 证书。SQLite、识谱模型缓存和证书保存在 Docker 持久卷；仍需另外备份 `p2k-data`。模型首次启动会下载 HOMR 所需资源，CPU 识谱速度取决于主机配置。公开服务前还要把隐私政策、用户协议的运营者与联系方式占位符补齐，设置可靠备份、限流和监控。

国内大陆服务器通过域名提供网站服务前通常需要完成 ICP 备案。云商的“免费试用”并不等于长期免费：例如阿里云当前个人 ECS 试用为有额度/期限的 3 个月试用，官方说明该试用资源不支持 ICP 备案；腾讯云轻量服务器备案要求中国内地包月资源满足规定时长。请先看云服务商当前规则与费用，不要把试用服务器当作长期免费生产环境。无云账单的选项是把服务运行在自己的电脑或家用主机上，但公网访问、HTTPS、网络稳定性和备案仍需自行处理。

P2K 自有源代码按 `LICENSE-P2K.txt` 的 MIT 条款免费使用和修改。HOMR 依赖按 AGPL-3.0 提供的软件；PDF.js、Salamander 钢琴采样与 HOMR 各自保留原有许可证，因此整套组合不适用单一许可证。若对外提供识谱服务或分发组合程序，应先核对 HOMR 的 AGPL 义务。

## Android APK

Android WebView 壳源码在 `outputs/p2k-android`，当前版本 `1.2.0`（versionCode 6，targetSdk 34 / minSdk 24）。APK 默认连接电脑局域网 `http://192.168.1.2:8766`，手机和电脑需在同一 Wi‑Fi，且电脑端运行 `start_p2k_phone_lan.bat`。若路由器分配的电脑 IP 不同，APK 首页按返回进入设置并替换 IP。手机流程为登录 → 连接电钢琴（可跳过）→ 曲库 → 原谱预览/范围选择 → 横屏钢琴；原谱 PDF 仅在网页端同步时明确确认后才上传到个人仓库。安装 APK 时，从手机浏览器下载列表或“文件管理 → 下载”打开；如 Android 拦截安装，只为当前浏览器/文件管理器开启“允许安装未知应用”。Windows PowerShell 构建（已在本机验证通过，产物已复制到 `downloads/P2K-debug.apk`）：

```powershell
$env:JAVA_HOME='work\android-toolchain\jdk\jdk-17.0.20.1+1'
$env:ANDROID_HOME='work\android-toolchain\android-sdk'
cd outputs\p2k-android
..\..\work\android-toolchain\gradle-8.13\bin\gradle.bat assembleDebug
```

APK 输出在 `app/build/outputs/apk/debug/app-debug.apk`。原生部分包含三个类：`BluetoothMidiBridge`（BLE MIDI 扫描、连接、订阅琴键）、`UsbMidiBridge`（Type-C / USB MIDI，插上自动检测）和 `NativeAudioDetector`（AudioRecord 采集 + 音高估计）。需要的权限：蓝牙扫描/连接、麦克风、网络。Debug APK 用于个人安装测试；面向公众发布前请设置正式签名、应用图标、开发者信息并完成设备安装要求检查。

## 回归测试

`work/` 下有可重复运行的自检脚本（只需先启动 `service/start_p2k.py`，识谱引擎会在测试触发识谱时自动启动）：

```powershell
work\p2k-omr-venv\Scripts\python.exe work\make_test_score.py work\p2k-test-score.png   # 合成五线谱
work\p2k-omr-venv\Scripts\python.exe work\make_sample_pdf.py work\p2k-test-score.png work\p2k-sample-score.pdf
node work\test-pitch.cjs          # 音高识别算法（合成钢琴音，8 项）
node work\test-desktop-web.cjs    # 电脑网页：导入 PDF → AI 识谱（13 项）
node work\test-phone-flow.cjs     # 手机流程：登录 → 连接 → 曲库 → 演奏 → 听音判定（28 项）
node work\test-offline-pdf.cjs    # 原谱下载与断网离线练习（6 项）
```

当前生成的 APK 已复制到 `downloads/P2K-debug.apk`，下载 API 会使用 Android APK 的媒体类型并设置安装文件名。

## 目录

- `index.html`：网页识谱端和 PWA 入口。
- `?mode=app`：手机键盘练习界面。
- `omr_server.py`：HOMR 识谱 API 适配。
- `../../work/p2k_app_server.py`：用户名/密码、曲谱同步 API。
- `../../deploy/`：Docker Compose、Caddy 与服务镜像配置。
- `../p2k-android/`：Android WebView 工程。
