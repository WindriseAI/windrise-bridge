/**
 * 自有域名教程页：静态教程 + 一段「让 AI 帮你配」的提示词（一键复制）。
 * 不发任何网络请求；页面里的外链是 <a>，由用户自己点开。
 */

(() => {
  "use strict";

  const PROMPT = [
    "你连着我电脑上的 Windrise（MCP）。请用 Windrise 的浏览器工具（空间 + 页面读写点）帮我在 Cloudflare 上完成这几件事，每做完一步都用一两句话告诉我结果：",
    "1. 先打开一个 Windrise 空间（比如「cloudflare 配置」），在这个空间里打开 https://dash.cloudflare.com/ 。",
    "2. 如果 Cloudflare 要登录、要验证码、要手机验证：立刻停下，请我本人在网页上登录。登录页你碰不到，也绝不输入我的密码。我登录好之后你接着干。",
    "3. 登录后：把域名加到 Cloudflare（Add a domain，选 Free 免费计划），拿到两个 DNS 服务器地址，告诉我这两个地址，我自己去域名注册商那里改 NS（这一步你也只能等我）。",
    "4. 创建 API 令牌：右上角头像 → My Profile → API Tokens → Create Token → Create Custom Token；权限加两条：Zone / DNS / Edit 和 Account / Cloudflare Tunnel / Edit；Zone Resources 选我那个域名。创建成功后，令牌请你不要读取、不要转述、不要复制——提示我自己复制，我自己粘贴进 Windrise 设置。",
    "5. 我贴好令牌后，接下来由我在 Windrise 设置里点「一键开通固定地址」；如果报错，你把报错文字读给我，对照这篇教程的「常见报错」告诉我卡在哪一步。",
    "遇到付款、验证码、删除操作、发布操作，一律停下问我，不自己决定。",
  ].join("\n");

  const box = document.getElementById("domain-prompt");
  if (box) box.textContent = PROMPT;

  const hint = document.getElementById("guide-hint");
  const button = document.getElementById("btn-copy-prompt");
  button?.addEventListener("click", async () => {
    let ok = false;
    try {
      await navigator.clipboard.writeText(PROMPT);
      ok = true;
    } catch {
      try {
        const area = document.createElement("textarea");
        area.value = PROMPT;
        area.style.position = "fixed";
        area.style.left = "-9999px";
        document.body.appendChild(area);
        area.select();
        ok = document.execCommand("copy");
        area.remove();
      } catch {
        ok = false;
      }
    }
    if (hint) hint.textContent = ok ? "提示词已复制：粘到 AI 对话里发给它。" : "复制失败：请手动选中上面那段话复制。";
  });

  /* 教程里的「回到 Windrise 一键配置」：走插件白名单动作 show-settings（带 tab）打开设置窗口 */
  document.getElementById("btn-open-settings")?.addEventListener("click", () => {
    try {
      chrome.runtime.sendMessage({ type: "grid-action", action: "show-settings", tab: "settings" }, (reply) => {
        const error = chrome.runtime.lastError;
        if (error || !reply?.ok) {
          if (hint) hint.textContent = "打不开设置窗口：请从系统托盘图标打开 Windrise，再进「设置」。";
          return;
        }
        if (hint) hint.textContent = "已打开 Windrise 设置窗口：往下找到「一键开通固定地址」。";
      });
    } catch {
      if (hint) hint.textContent = "打不开设置窗口：请从系统托盘图标打开 Windrise，再进「设置」。";
    }
  });
})();
