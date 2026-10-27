/**
 * 图文教程：自动化做不了（要登录、要在别的网站点几下）的步骤，一步步教用户自己做。
 *
 * 每个教程 = 标题 + 等级 + 预计用时 + 一句话说明 + 分步卡片（每步：标题、说明、可选的「复制」代码、操作按钮）+ 常见问题。
 * 文字里的 {port} {url} {hostname} 会在打开时换成当前的值。
 *
 * 按钮种类：
 *   open: 网址           在系统浏览器打开
 *   copy: 文字           复制到剪贴板
 *   guide: 教程 id       跳到另一个教程
 *   provider: 隧道类型    切换到这种连接方式
 *   focus: 元素 id（可带 tab）  跳到软件里对应的输入框
 *   click: 元素 id（可带 tab）  替用户点软件里的某个按钮（例如「检测」）
 */
export const LEVELS = {
  1: { name: "入门", cls: "lv1" },
  2: { name: "进阶", cls: "lv2" },
  3: { name: "高级", cls: "lv3" },
};

/** 侧栏里的排列顺序：从易到难 */
export const GUIDE_ORDER = ["how", "quick", "aifile", "ngrok", "proxy", "named", "trouble"];

export const GUIDES = {
  how: {
    short: "先看原理",
    level: 1, minutes: 1,
    diagram: true,
    title: "先看原理：AI 怎么用到你的电脑",
    intro: "一张图看懂：AI 在云端，文件在你电脑里，中间靠 MCP 和隧道接起来。",
    steps: [
      { id: "ai", title: "AI 在云端", text: "Claude、ChatGPT 等跑在网上的服务器里，默认碰不到你电脑上的文件。" },
      { id: "mcp", title: "MCP：AI 的通用插头", text: "本软件在电脑上开一个 MCP 服务。AI 按 MCP 的规则发指令：读写文件、搜索，或在命令行（CLI）里运行命令。" },
      { id: "tunnel", title: "隧道：给电脑一个网址", text: "云端 AI 找不到你家里的电脑。隧道（Cloudflare / ngrok）给它一个 https:// 网址，指令顺着隧道送到本机，结果原路返回。" },
      { id: "scope", title: "只开放你选的文件夹", text: "AI 只能动「允许的文件夹」里的东西。断开隧道，连接立刻失效。", actions: [{ label: "开始：快速隧道", guide: "quick" }] },
    ],
  },

  quick: {
    short: "快速隧道",
    level: 1, minutes: 1,
    title: "快速隧道：最省事",
    intro: "不用注册、不用域名，点一下就有一个以 https:// 开头的地址，远程 AI 通过它连到这台电脑。缺点是每次重新连接地址都会变。",
    steps: [
      {
        id: "pick", title: "选「快速隧道」",
        text: "在 Bridge 页往下翻到「隧道」卡片，点「快速隧道」那一格。选中后格子会高亮。",
        actions: [{ label: "帮我选快速隧道", provider: "cloudflare" }],
      },
      {
        id: "client", title: "第一次用：装隧道客户端",
        text: "快速隧道靠一个叫 cloudflared 的小程序。没装的话，隧道卡片下面会提示「还需要补」，点「安装」即可，大约 20MB，装一次以后都不用管。",
      },
      {
        id: "connect", title: "一键连接",
        text: "点 Bridge 页最上面的「一键连接」。正常 5–15 秒就会显示「已连接」，下面出现远程地址。连接期间别关软件窗口（可以最小化到托盘）。",
      },
      {
        id: "connect-ai", title: "连接 AI",
        text: "看到「已连接」后，把地址填进 AI 客户端的 MCP 设置。需要带口令的，在请求头里加 Authorization: Bearer 你的口令；口令在「设置 → 口令入口」新增。",
        actions: [{ label: "去口令入口", focus: "btn-owner-auth-add-key", tab: "settings" }],
      },
    ],
    tips: [
      "一直停在「连接中」：多半是代理软件或防火墙挡住了，看「代理 / 网络」教程。",
      "地址每次都变很麻烦：用 ngrok（免费送一个固定域名），或者用自己的域名（固定地址教程）。",
      "电脑休眠或断网后会自动重连，地址可能会变，用路径地址的客户端要换新地址。",
    ],
    footer: [{ label: "代理 / 网络教程", guide: "proxy" }],
  },

  aifile: {
    short: "AI 说读不了文件",
    level: 1, minutes: 1,
    title: "AI 说「读不了本地文件」怎么办",
    intro: "有些 AI 不知道自己已经连上了这台电脑，会回答「我无法访问你的本地文件」。其实它能读：告诉它用 Windrise Bridge 的 MCP 工具就行。",
    steps: [
      {
        id: "tell", title: "复制这段话发给 AI",
        text: "把下面这段话发到同一个 AI 对话里（路径换成你要读的文件或文件夹）。AI 一般马上就会去读。",
        code: "你已经连接了 Windrise Bridge（自定义 MCP），可以直接读写我这台电脑上的文件。请用 Windrise Bridge 的 MCP 工具：先用 list_directory 看看「{root}」里有什么，再用 read_files 读取需要的文件。不要说读不了，直接调用工具。",
      },
      {
        id: "path", title: "直接给出完整路径更准",
        text: "知道文件在哪的话，把完整路径告诉它，比如下面这样。找不到文件就让它用 find_files 按名字找，用 search_files 按内容搜；图片用 read_image 看。",
        code: "用 Windrise Bridge 的 read_files 读取 {root}\\文件名.txt",
      },
      {
        id: "check", title: "还是说读不了？查三件事",
        text: "① Bridge 页最上面是「已连接」；② AI 客户端的 MCP 连接里有 Windrise Bridge，对话里的工具 / 连接开关也打开了它；③ 要读的文件在「AI 可访问的文件夹」里。",
        actions: [{ label: "去口令入口", focus: "btn-owner-auth-add-key", tab: "settings" }],
      },
      {
        id: "folder", title: "文件不在允许的文件夹里",
        text: "AI 只能读你允许的文件夹。在 Bridge 页「AI 可访问的文件夹」点「添加 / 修改」，把文件所在的文件夹加进去，再让 AI 读一次。",
        actions: [{ label: "添加文件夹", click: "btn-ws-edit", tab: "bridge" }],
      },
    ],
    tips: [
      "开新对话时，第一句先说「用 Windrise Bridge」，AI 就会直接用这台电脑的工具。",
      "客户端问「是否允许使用 Windrise Bridge」时选「始终允许」，以后不用每次确认。",
    ],
    footer: [{ label: "连不上怎么办", guide: "trouble" }],
  },

  ngrok: {
    short: "ngrok 固定域名",
    level: 2, minutes: 3,
    title: "ngrok：免费固定域名",
    intro: "ngrok 免费，不需要自己的域名。注册后能领一个固定的免费域名，地址以后都不会变，AI 客户端里配一次就够。全程大约 3 分钟。",
    steps: [
      {
        id: "signup", title: "注册或登录 ngrok",
        text: "用邮箱、Google 或 GitHub 账号都可以。注册时问你用途，随便选一个就行。网页是英文的，跟着下面的位置找即可。",
        actions: [{ label: "打开 ngrok 注册页", open: "https://dashboard.ngrok.com/signup" }, { label: "已有账号，去登录", open: "https://dashboard.ngrok.com/login" }],
      },
      {
        id: "token", title: "复制 Authtoken（令牌）",
        text: "登录后左侧点「Getting Started → Your Authtoken」，在 Your Authtoken 那一栏点「Copy」。令牌是一长串字母数字。",
        warn: "令牌相当于账号钥匙：别发给别人，也别截图发到群里。",
        actions: [{ label: "打开 Authtoken 页面", open: "https://dashboard.ngrok.com/get-started/your-authtoken" }],
      },
      {
        id: "paste", title: "粘贴到 Windrise",
        text: "回到软件，在「设置 → ngrok 令牌」里粘贴，点「保存」。（在 Bridge 页选了 ngrok 时，「还需要补」里也有一个输入框，粘那里也行。）",
        actions: [{ label: "去填令牌", focus: "set-ngrok-token", tab: "settings" }],
      },
      {
        id: "domain", title: "领免费固定域名（推荐）",
        text: "ngrok 网页左侧点「Universal Gateway → Domains」（旧版叫「Cloud Edge → Domains」），点「+ New Domain」。免费账号能领 1 个，样子像 xxx.ngrok-free.app。复制它，填到「设置 → ngrok 固定域名」并保存。不填也能用，只是每次地址会变。",
        actions: [{ label: "打开域名页面", open: "https://dashboard.ngrok.com/domains" }, { label: "去填域名", focus: "set-ngrok-domain", tab: "settings" }],
      },
      {
        id: "client", title: "装 ngrok 客户端",
        text: "回到 Bridge 页选「ngrok」。没装客户端的话「还需要补」里会有「安装」按钮，点一下就行。",
        actions: [{ label: "选 ngrok", provider: "ngrok" }],
      },
      {
        id: "connect", title: "一键连接",
        text: "点「一键连接」，看到「已连接」就好了。之后把地址和口令填进 AI 客户端，一次就够。",
        actions: [{ label: "去口令入口", focus: "btn-owner-auth-add-key", tab: "settings" }],
      },
    ],
    tips: [
      "ERR_NGROK_4018：令牌没填或填错了，回第 2 步重新复制。",
      "ERR_NGROK_334：这个域名正在别处使用（别的电脑或终端开着 ngrok），先关掉那边，或换一个域名。",
      "ERR_NGROK_108：免费账号同时只能开 1 个 ngrok，关掉别处的再试。",
      "ERR_NGROK_9009 或一直连不上：多半是代理挡住了，看「代理 / 网络」教程。",
      "免费版每月有流量上限，正常给 AI 用绰绰有余。",
    ],
    footer: [{ label: "代理 / 网络教程", guide: "proxy" }],
  },

  proxy: {
    short: "代理 / 网络",
    level: 2, minutes: 5,
    title: "代理 / 网络：隧道被挡住怎么办",
    intro: "开着代理软件（Clash、V2Ray 等）或在公司、学校网络里，隧道可能一直「连接中」或报超时。软件会自动尝试直连、备用方式和代理中继，全都不行时按下面一条条试。",
    steps: [
      {
        id: "check", title: "先让软件检测一下",
        text: "点首页「网络 / 代理」卡片里的「检测网络」，软件会检查代理、能不能直连 Cloudflare，并写出卡在哪、怎么改。",
        actions: [{ label: "帮我点「检测」", click: "btn-net-check", tab: "bridge" }],
      },
      {
        id: "direct", title: "让隧道直连（Cloudflare）",
        text: "在代理软件的规则里，把下面这些域名设为直连（DIRECT）。Clash / Clash Verge 可以在「订阅 → 编辑规则」或覆写配置里，把这几行加到 rules 的最前面，保存后「重载配置」：",
        code: "- DOMAIN-SUFFIX,trycloudflare.com,DIRECT\n- DOMAIN-SUFFIX,argotunnel.com,DIRECT\n- DOMAIN-SUFFIX,cfargotunnel.com,DIRECT",
      },
      {
        id: "fakeip", title: "开了 fake-ip 的再加一步",
        text: "Clash 的 DNS 模式是 fake-ip 时，还要把同样的域名加进「fake-ip 过滤（fake-ip-filter）」，否则还是会被代理接管：",
        code: "+.trycloudflare.com\n+.argotunnel.com\n+.cfargotunnel.com",
      },
      {
        id: "port", title: "放行 7844 端口",
        text: "cloudflared 用 7844 端口（TCP 和 UDP）连 Cloudflare。公司、学校网络或防火墙挡了的话，换个网络（比如手机热点）试一下就能确认是不是这个原因。",
      },
      {
        id: "ngrok", title: "用 ngrok 时：不能走 HTTP 代理",
        text: "ngrok 走 HTTP 代理会报 ERR_NGROK_9009。把下面这些设为直连，或者打开代理软件的 TUN 模式：",
        code: "- DOMAIN-SUFFIX,ngrok.com,DIRECT\n- DOMAIN-SUFFIX,ngrok-free.app,DIRECT\n- DOMAIN-SUFFIX,ngrok.io,DIRECT",
      },
      {
        id: "retry", title: "还不行",
        text: "临时关掉代理软件的「系统代理」，回到 Bridge 页点「重试」；或者换另一种连接方式。软件每 30 秒会自动复查一次网络，环境一变就自动重连。",
        actions: [{ label: "改用快速隧道", provider: "cloudflare" }, { label: "改用 ngrok", provider: "ngrok" }],
      },
    ],
    tips: [
      "改完代理规则后，记得在代理软件里「重载配置」或重启一下代理。",
      "开了 TUN（虚拟网卡）模式的，规则同样要加，否则流量还是会绕到代理节点。",
    ],
    footer: [{ label: "连不上怎么办", guide: "trouble" }],
  },

  named: {
    short: "用自己的域名",
    level: 3, minutes: 10,
    title: "固定地址：用自己的域名（Cloudflare 命名隧道）",
    intro: "需要一个自己的域名，并把它交给 Cloudflare 管理（免费）。好处是地址永远不变、流量不限、速度稳定。第一次大约 10 分钟，之后再也不用管。",
    steps: [
      {
        id: "zone", title: "把域名加到 Cloudflare",
        text: "登录 Cloudflare，点「添加站点 / Add a domain」，输入你的域名，选 Free 免费套餐。然后按页面提示，去买域名的地方（阿里云、腾讯云等）把「DNS 服务器」改成 Cloudflare 给的两个地址。一般几分钟到几小时生效，Cloudflare 显示「有效 / Active」就行。已经在 Cloudflare 的域名跳过这步。",
        actions: [{ label: "打开 Cloudflare", open: "https://dash.cloudflare.com/" }],
      },
      {
        id: "tunnel", title: "创建隧道，复制令牌",
        text: "打开 Cloudflare Zero Trust →「网络 / Networks → Tunnels」→「创建隧道」→ 选「Cloudflared」→ 起个名字（如 windrise）。下一页会给一条安装命令，只需要复制命令里 eyJ 开头的那一长串（这就是隧道令牌），命令本身不用运行。",
        warn: "隧道令牌别外传，也别截图。",
        actions: [{ label: "打开 Cloudflare Tunnels", open: "https://one.dash.cloudflare.com/" }],
      },
      {
        id: "route", title: "添加公网主机名",
        text: "在这条隧道的「公共主机名 / Public Hostname」（新版叫「已发布应用程序路由 / Published application routes」）里点「添加」：子域填 mcp，域名选你的域名，类型选 HTTP，URL 填下面这个地址，保存。",
        code: "http://127.0.0.1:{port}",
        warn: "这里的端口必须和软件「设置 → 端口」一致，改了端口要回来同步改。",
      },
      {
        id: "paste", title: "填到 Windrise",
        text: "回到软件「设置」，把「公网域名」填成 mcp.你的域名（如 mcp.example.com），把第 2 步的令牌粘到「隧道令牌」，点「保存」。",
        actions: [{ label: "去填域名", focus: "set-tunnel-host", tab: "settings" }, { label: "去填令牌", focus: "set-tunnel-token", tab: "settings" }],
      },
      {
        id: "connect", title: "一键连接，检查 DNS",
        text: "回到 Bridge 页，选「命名隧道」，点「一键连接」。如果显示已连接但网址打不开，去 Cloudflare 的 DNS 页面看一下：应该有一条 mcp 的 CNAME 记录，指向 xxx.cfargotunnel.com，并且是橙色云朵（已代理）。",
        actions: [{ label: "选命名隧道", provider: "cloudflare-named" }, { label: "打开 Cloudflare DNS", open: "https://dash.cloudflare.com/?to=/:account/:zone/dns" }],
      },
    ],
    tips: [
      "命令行登录过 cloudflared（cloudflared tunnel login）的，可以直接用「设置 → 一键开通固定地址」，自动完成第 2–4 步。",
      "打开网址显示 1033 / 530：隧道没在跑，或 DNS 指向了别的隧道，检查第 5 步。",
      "没有域名又想要固定地址：用 ngrok，免费送一个。",
    ],
    footer: [{ label: "改用 ngrok", guide: "ngrok" }, { label: "代理 / 网络教程", guide: "proxy" }],
  },

  trouble: {
    short: "连不上怎么办",
    level: 3, minutes: 5,
    title: "连不上怎么办",
    intro: "按顺序排查，大多数问题前三步就能解决。",
    steps: [
      { id: "retry", title: "点「重试」", text: "网络抖一下很常见，Bridge 页最上面的按钮会变成「重试」，点一下通常就好。" },
      {
        id: "read", title: "看错误提示",
        text: "Bridge 页最上面那行灰字写了原因，旁边的「怎么解决？」会直接打开对应教程。带 ERR_NGROK 的看 ngrok 教程；一直「连接中」或超时看代理教程；命名隧道看固定地址教程。",
        actions: [{ label: "ngrok 教程", guide: "ngrok" }, { label: "代理 / 网络", guide: "proxy" }, { label: "固定地址教程", guide: "named" }],
      },
      { id: "probe", title: "让软件检测网络", text: "点隧道卡片右上的「检测」，看是不是代理或防火墙挡住了。", actions: [{ label: "帮我点「检测」", click: "btn-tunnel-probe", tab: "bridge" }] },
      { id: "switch", title: "换一种连接方式", text: "快速隧道最省事，不用任何账号；ngrok 在部分网络下更容易连上。", actions: [{ label: "改用快速隧道", provider: "cloudflare" }, { label: "改用 ngrok", provider: "ngrok" }] },
      { id: "client", title: "隧道通了但 AI 用不了", text: "客户端里的地址要和 Bridge 页显示的一致（快速隧道重连后会变）；用口令连接的，请求头里要带 Authorization: Bearer 你的口令。", actions: [{ label: "去口令入口", focus: "btn-owner-auth-add-key", tab: "settings" }] },
    ],
    tips: [
      "软件日志在「设置 → 打开数据目录」里，找卖家帮忙时可以附上。",
    ],
    footer: [],
  },
};

/** 隧道类型 → 教程 */
export const GUIDE_FOR_PROVIDER = { cloudflare: "quick", "cloudflare-named": "named", ngrok: "ngrok" };

/** 按错误文字猜该看哪个教程（以及哪一步） */
export function guideForError(text, provider) {
  const t = String(text ?? "");
  if (/ERR_NGROK_9009|proxy|代理|7844|超时|timed? ?out|i\/o timeout|EOF|handshake|TLS/i.test(t)) return { id: "proxy" };
  if (/ERR_NGROK_4018|authtoken|令牌/i.test(t) && provider === "ngrok") return { id: "ngrok", step: "token" };
  if (/ERR_NGROK_334|domain|域名/i.test(t) && provider === "ngrok") return { id: "ngrok", step: "domain" };
  if (/ERR_NGROK_108/i.test(t)) return { id: "ngrok" };
  if (/ngrok/i.test(t) || provider === "ngrok") return { id: "ngrok" };
  if (/1033|530|cfargotunnel|DNS|hostname|credentials|凭据/i.test(t) || provider === "cloudflare-named") return { id: "named", step: /DNS|1033|530/i.test(t) ? "connect" : undefined };
  return { id: "trouble" };
}
